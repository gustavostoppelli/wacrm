import type { SupabaseClient } from '@supabase/supabase-js'
import {
  daysAgoStart,
  DOW_SHORT_MON_FIRST,
  lastNDayKeys,
  localDayKey,
  mondayIndex,
  startOfLocalDay,
} from './date-utils'
import type {
  ActivityItem,
  CampaignReportRow,
  ConversationsSeriesPoint,
  FunnelInsightsData,
  MetricsBundle,
  PipelineDonutData,
  PipelineFunnelData,
  PipelineStageSlice,
  ResponseTimeBucket,
  ResponseTimeSummary,
  StageDwellTime,
} from './types'

// ------------------------------------------------------------
// All client-side aggregation. RLS scopes every query to the
// signed-in user automatically, so we never pass user_id explicitly
// here. Perf is acceptable for the current scale (low thousands of
// messages) — if a tenant's dataset outgrows this, we'd migrate the
// heavy aggregations to SQL RPCs. Noted in the PR.
// ------------------------------------------------------------

type DB = SupabaseClient

// --- 1. Metric cards ---------------------------------------------------

export async function loadMetrics(db: DB): Promise<MetricsBundle> {
  const todayStart = startOfLocalDay().toISOString()
  const yesterdayStart = daysAgoStart(1).toISOString()

  const [
    openConvCur,
    newConvToday,
    newConvYesterday,
    newContactsToday,
    newContactsYesterday,
    openDeals,
    messagesToday,
    messagesYesterday,
  ] = await Promise.all([
    db.from('conversations').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open')
      .gte('created_at', todayStart),
    db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open')
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
    db.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', todayStart),
    db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
    db.from('deals').select('value, status').eq('status', 'open'),
    db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('sender_type', 'agent')
      .gte('created_at', todayStart),
    db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('sender_type', 'agent')
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
  ])

  const openDealsRows = (openDeals.data ?? []) as { value: number | null }[]
  const openDealsValue = openDealsRows.reduce((sum, d) => sum + (d.value ?? 0), 0)

  return {
    activeConversations: {
      current: openConvCur.count ?? 0,
      // "vs yesterday" on a current-state count has no clean answer
      // without snapshots — we show the delta in NEW open conversations
      // today vs yesterday. That's the business-meaningful daily signal.
      previous: (newConvToday.count ?? 0) - (newConvYesterday.count ?? 0),
    },
    newContactsToday: {
      current: newContactsToday.count ?? 0,
      previous: newContactsYesterday.count ?? 0,
    },
    openDealsValue,
    openDealsCount: openDealsRows.length,
    messagesSentToday: {
      current: messagesToday.count ?? 0,
      previous: messagesYesterday.count ?? 0,
    },
  }
}

// --- 2. Conversations over time ---------------------------------------

export async function loadConversationsSeries(
  db: DB,
  rangeDays: number,
): Promise<ConversationsSeriesPoint[]> {
  const start = daysAgoStart(rangeDays - 1).toISOString()
  const { data, error } = await db
    .from('messages')
    .select('created_at, sender_type')
    .gte('created_at', start)
    .order('created_at', { ascending: true })
  if (error) throw error

  const keys = lastNDayKeys(rangeDays)
  const buckets = new Map<string, { incoming: number; outgoing: number }>()
  for (const k of keys) buckets.set(k, { incoming: 0, outgoing: 0 })

  for (const row of (data ?? []) as { created_at: string; sender_type: string }[]) {
    const key = localDayKey(row.created_at)
    const bucket = buckets.get(key)
    if (!bucket) continue
    if (row.sender_type === 'customer') bucket.incoming += 1
    else bucket.outgoing += 1 // agent + bot both count as outgoing
  }

  return keys.map((day) => ({ day, ...(buckets.get(day) ?? { incoming: 0, outgoing: 0 }) }))
}

// --- 3. Pipeline donut -------------------------------------------------

export async function loadPipelineDonut(db: DB): Promise<PipelineDonutData> {
  const [stagesRes, dealsRes] = await Promise.all([
    db.from('pipeline_stages').select('id, name, color, pipeline_id, position').order('position'),
    db.from('deals').select('stage_id, value, status').eq('status', 'open'),
  ])

  const stages =
    (stagesRes.data ?? []) as { id: string; name: string; color: string }[]
  const deals = (dealsRes.data ?? []) as { stage_id: string; value: number | null }[]

  const byStage = new Map<string, { count: number; total: number }>()
  for (const d of deals) {
    const row = byStage.get(d.stage_id) ?? { count: 0, total: 0 }
    row.count += 1
    row.total += d.value ?? 0
    byStage.set(d.stage_id, row)
  }

  const slices: PipelineStageSlice[] = stages
    .map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color || '#64748b',
      dealCount: byStage.get(s.id)?.count ?? 0,
      totalValue: byStage.get(s.id)?.total ?? 0,
    }))
    // Hide empty stages from the ring (but we'd still show them in the
    // legend if the user wanted a full breakdown — trimming keeps the
    // visual clean for the common case).
    .filter((s) => s.totalValue > 0 || s.dealCount > 0)

  return {
    stages: slices,
    totalValue: slices.reduce((sum, s) => sum + s.totalValue, 0),
  }
}

// --- 4. Response time by day of week ----------------------------------

export async function loadResponseTime(db: DB): Promise<ResponseTimeSummary> {
  // Pull the last 14 days of messages in one shot, then walk per
  // conversation to find each "first inbound" → "first subsequent
  // outbound" pair. 14 days gives us both "this week" + "last week"
  // with enough overlap if the user opens the dashboard late on a
  // Monday.
  const fourteenDaysAgo = daysAgoStart(13).toISOString()
  const { data, error } = await db
    .from('messages')
    .select('conversation_id, sender_type, created_at')
    .gte('created_at', fourteenDaysAgo)
    .order('conversation_id', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error

  const rows = (data ?? []) as {
    conversation_id: string
    sender_type: string
    created_at: string
  }[]

  // Group per conversation, pair unreplied customer messages with the
  // next outbound message from the agent/bot. A single customer message
  // can only count once (avoids inflating averages if the customer
  // double-messages while the agent takes time to reply).
  interface Sample {
    customerAt: Date
    responseAt: Date
  }
  const samples: Sample[] = []

  let currentConv = ''
  let pendingCustomer: Date | null = null
  for (const row of rows) {
    if (row.conversation_id !== currentConv) {
      currentConv = row.conversation_id
      pendingCustomer = null
    }
    const ts = new Date(row.created_at)
    if (row.sender_type === 'customer') {
      if (!pendingCustomer) pendingCustomer = ts
    } else if (pendingCustomer) {
      samples.push({ customerAt: pendingCustomer, responseAt: ts })
      pendingCustomer = null
    }
  }

  const now = new Date()
  const thisWeekStart = daysAgoStart(mondayIndex(now))
  const lastWeekStart = daysAgoStart(mondayIndex(now) + 7)

  // Per-day-of-week buckets, averaged over both weeks' worth of data
  // so each bar has more samples to stand on. If a day has no samples
  // its avgMinutes stays null and the chart renders the bar muted.
  const byDow = new Map<number, number[]>()
  for (let i = 0; i < 7; i++) byDow.set(i, [])
  const thisWeekMins: number[] = []
  const lastWeekMins: number[] = []

  for (const s of samples) {
    const diffMin = (s.responseAt.getTime() - s.customerAt.getTime()) / 60_000
    if (diffMin < 0) continue
    const dow = mondayIndex(s.customerAt)
    byDow.get(dow)!.push(diffMin)
    if (s.customerAt >= thisWeekStart) {
      thisWeekMins.push(diffMin)
    } else if (s.customerAt >= lastWeekStart && s.customerAt < thisWeekStart) {
      lastWeekMins.push(diffMin)
    }
  }

  const avg = (arr: number[]) =>
    arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length

  const buckets: ResponseTimeBucket[] = Array.from({ length: 7 }, (_, dow) => {
    const samples = byDow.get(dow) ?? []
    return {
      dow,
      avgMinutes: avg(samples),
      samples: samples.length,
    }
  })

  // Silence unused-label warnings — keep the arrays explicitly named
  // for readability above.
  void DOW_SHORT_MON_FIRST

  return {
    buckets,
    thisWeekAvg: avg(thisWeekMins),
    lastWeekAvg: avg(lastWeekMins),
  }
}

// --- 5. Activity feed --------------------------------------------------

export async function loadActivity(db: DB, limit = 20): Promise<ActivityItem[]> {
  // Pull ~10 from each source (plenty of headroom after merge-sort),
  // then interleave by timestamp. The individual per-table limits
  // keep the payload small; the final limit is enforced after sort.
  const [msgs, contacts, deals, broadcasts, autoLogs] = await Promise.all([
    db
      .from('messages')
      .select('id, content_text, sender_type, created_at, conversation_id, conversations(contact_id, contacts(name, phone))')
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(10),
    db
      .from('contacts')
      .select('id, name, phone, created_at')
      .order('created_at', { ascending: false })
      .limit(10),
    db
      .from('deals')
      .select('id, title, updated_at, stage:pipeline_stages(name)')
      .order('updated_at', { ascending: false })
      .limit(10),
    db
      .from('broadcasts')
      .select('id, name, status, total_recipients, created_at')
      .order('created_at', { ascending: false })
      .limit(5),
    db
      .from('automation_logs')
      .select('id, trigger_event, status, created_at, automation:automations(name), contact:contacts(name, phone)')
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  const items: ActivityItem[] = []

  // PostgREST returns nested selections as arrays by default, even when
  // the foreign key is 1:1. We normalise by taking [0] on each level.
  for (const m of (msgs.data ?? []) as unknown as Array<{
    id: string
    content_text: string | null
    created_at: string
    conversation_id: string
    conversations:
      | { contact_id: string | null; contacts: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null }[]
      | { contact_id: string | null; contacts: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null }
      | null
  }>) {
    const conv = Array.isArray(m.conversations) ? m.conversations[0] : m.conversations
    const contact = Array.isArray(conv?.contacts) ? conv?.contacts[0] : conv?.contacts
    const who = contact?.name || contact?.phone || 'Unknown'
    items.push({
      id: `msg-${m.id}`,
      kind: 'message',
      text: `New message from ${who}`,
      at: m.created_at,
      href: `/inbox?c=${m.conversation_id}`,
    })
  }

  for (const c of (contacts.data ?? []) as Array<{ id: string; name: string | null; phone: string; created_at: string }>) {
    items.push({
      id: `contact-${c.id}`,
      kind: 'contact',
      text: `New contact: ${c.name || c.phone}`,
      at: c.created_at,
      href: '/contacts',
    })
  }

  for (const d of (deals.data ?? []) as unknown as Array<{
    id: string
    title: string
    updated_at: string
    stage: { name: string }[] | { name: string } | null
  }>) {
    const stage = Array.isArray(d.stage) ? d.stage[0] : d.stage
    items.push({
      id: `deal-${d.id}`,
      kind: 'deal',
      text: stage?.name
        ? `Deal "${d.title}" in ${stage.name}`
        : `Deal "${d.title}" updated`,
      at: d.updated_at,
      href: '/pipelines',
    })
  }

  for (const b of (broadcasts.data ?? []) as Array<{
    id: string
    name: string
    status: string
    total_recipients: number
    created_at: string
  }>) {
    const label =
      b.status === 'sent'
        ? `sent to ${b.total_recipients} contacts`
        : `${b.status} (${b.total_recipients} recipients)`
    items.push({
      id: `broadcast-${b.id}`,
      kind: 'broadcast',
      text: `Broadcast "${b.name}" ${label}`,
      at: b.created_at,
      href: '/broadcasts',
    })
  }

  for (const l of (autoLogs.data ?? []) as unknown as Array<{
    id: string
    trigger_event: string
    status: string
    created_at: string
    automation: { name: string }[] | { name: string } | null
    contact: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null
  }>) {
    const automation = Array.isArray(l.automation) ? l.automation[0] : l.automation
    const contact = Array.isArray(l.contact) ? l.contact[0] : l.contact
    const who = contact?.name || contact?.phone || 'a contact'
    const autoName = automation?.name || 'Automation'
    items.push({
      id: `auto-${l.id}`,
      kind: 'automation',
      text: `Automation "${autoName}" ${l.status === 'failed' ? 'failed for' : 'triggered for'} ${who}`,
      at: l.created_at,
    })
  }

  return items
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0))
    .slice(0, limit)
}

// --- 6. Campaign report --------------------------------------------------

/**
 * Every deal grouped by (source, campaign), with how many reached a
 * meeting-scheduled deal or a won deal — the two "this lead was actually
 * qualified" proxies already tracked on `deals`. Lets an account see
 * which specific campaign converts, not just which broad channel.
 *
 * "Reached a meeting" uses the same two-signal check as
 * `loadPipelineFunnel` below (`meeting_scheduled_at` OR a stage tagged
 * `stage_role = 'meeting_scheduled'`) — this used to only check the
 * timestamp, so a deal dragged by hand into that stage (never going
 * through the AI-agent/site-form flow that sets the timestamp) silently
 * never counted here, even though the funnel chart further down the
 * same page already counted it correctly.
 */
export async function loadCampaignReport(db: DB): Promise<CampaignReportRow[]> {
  const [stagesRes, dealsRes] = await Promise.all([
    db.from('pipeline_stages').select('id, stage_role'),
    db.from('deals').select('source, campaign, status, stage_id, meeting_scheduled_at'),
  ])

  if (dealsRes.error) {
    console.error('[dashboard] loadCampaignReport failed:', dealsRes.error)
    return []
  }

  const meetingStageIds = new Set(
    ((stagesRes.data ?? []) as { id: string; stage_role: string | null }[])
      .filter((s) => s.stage_role === 'meeting_scheduled')
      .map((s) => s.id)
  )

  const buckets = new Map<string, CampaignReportRow>()
  for (const row of (dealsRes.data ?? []) as Array<{
    source: string | null
    campaign: string | null
    status: string | null
    stage_id: string
    meeting_scheduled_at: string | null
  }>) {
    const key = `${row.source ?? ''}::${row.campaign ?? ''}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        source: row.source,
        campaign: row.campaign,
        totalDeals: 0,
        meetingScheduledCount: 0,
        wonCount: 0,
      }
      buckets.set(key, bucket)
    }
    bucket.totalDeals += 1
    if (row.meeting_scheduled_at || meetingStageIds.has(row.stage_id)) {
      bucket.meetingScheduledCount += 1
    }
    if (row.status === 'won') bucket.wonCount += 1
  }

  return Array.from(buckets.values()).sort((a, b) => b.totalDeals - a.totalDeals)
}

// --- 7. Pipeline funnel ---------------------------------------------------

/**
 * "Reached a meeting" combines the two ways a deal ends up there: the
 * AI-agent/site-form flows that set `meeting_scheduled_at` directly, and
 * a card dragged by hand into whichever stage is tagged
 * `stage_role = 'meeting_scheduled'` on the Kanban. A deal dragged
 * straight past that stage without ever pausing there (and without the
 * timestamp set some other way) won't be counted -- same edge case the
 * "Reunião Agendada" badge on the kanban card already has.
 */
export async function loadPipelineFunnel(db: DB): Promise<PipelineFunnelData> {
  const [stagesRes, dealsRes] = await Promise.all([
    db.from('pipeline_stages').select('id, stage_role'),
    db.from('deals').select('stage_id, status, meeting_scheduled_at'),
  ])

  const meetingStageIds = new Set(
    ((stagesRes.data ?? []) as { id: string; stage_role: string | null }[])
      .filter((s) => s.stage_role === 'meeting_scheduled')
      .map((s) => s.id)
  )

  const deals = (dealsRes.data ?? []) as {
    stage_id: string
    status: string | null
    meeting_scheduled_at: string | null
  }[]

  let reachedMeetingCount = 0
  let wonCount = 0
  let wonFromMeetingCount = 0
  let lostCount = 0
  let openCount = 0

  for (const d of deals) {
    const reachedMeeting = Boolean(d.meeting_scheduled_at) || meetingStageIds.has(d.stage_id)
    if (reachedMeeting) reachedMeetingCount += 1
    if (d.status === 'won') {
      wonCount += 1
      if (reachedMeeting) wonFromMeetingCount += 1
    } else if (d.status === 'lost') {
      lostCount += 1
    } else {
      openCount += 1
    }
  }

  return {
    totalDeals: deals.length,
    reachedMeetingCount,
    wonCount,
    wonFromMeetingCount,
    lostCount,
    openCount,
  }
}

// --- 8. Funnel insights (time-to-close, ticket size, stalled deals) ------

/** Open deal sitting this long in the meeting-scheduled stage counts as stalled. */
const STALL_THRESHOLD_DAYS = 7

export async function loadFunnelInsights(db: DB): Promise<FunnelInsightsData> {
  const [stagesRes, dealsRes, historyRes] = await Promise.all([
    db.from('pipeline_stages').select('id, name, stage_role, position').order('position'),
    db.from('deals').select('id, stage_id, status, value, created_at, closed_at'),
    // Ascending so each deal's own entries land in visit order once
    // grouped below — no extra per-group sort needed.
    db.from('deal_stage_history').select('deal_id, stage_id, entered_at').order('entered_at', { ascending: true }),
  ])

  const stages = (stagesRes.data ?? []) as {
    id: string
    name: string
    stage_role: string | null
  }[]
  const meetingStageIds = new Set(
    stages.filter((s) => s.stage_role === 'meeting_scheduled').map((s) => s.id)
  )

  const deals = (dealsRes.data ?? []) as {
    id: string
    stage_id: string
    status: string | null
    value: number | null
    created_at: string
    closed_at: string | null
  }[]
  const dealById = new Map(deals.map((d) => [d.id, d]))

  const closedDurationsDays: number[] = []
  for (const d of deals) {
    if (d.status === 'won' && d.closed_at) {
      closedDurationsDays.push(
        (new Date(d.closed_at).getTime() - new Date(d.created_at).getTime()) / 86400000
      )
    }
  }

  const wonValues = deals.filter((d) => d.status === 'won').map((d) => d.value ?? 0)
  const openValues = deals.filter((d) => d.status === 'open').map((d) => d.value ?? 0)

  const historyByDeal = new Map<string, { stage_id: string; entered_at: string }[]>()
  for (const h of (historyRes.data ?? []) as {
    deal_id: string
    stage_id: string
    entered_at: string
  }[]) {
    const list = historyByDeal.get(h.deal_id) ?? []
    list.push(h)
    historyByDeal.set(h.deal_id, list)
  }

  const now = Date.now()
  const stageDurationsDays = new Map<string, number[]>()
  let stuckInMeetingCount = 0

  for (const [dealId, entries] of historyByDeal) {
    const deal = dealById.get(dealId)
    if (!deal) continue
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const next = entries[i + 1]
      const start = new Date(entry.entered_at).getTime()
      const end = next ? new Date(next.entered_at).getTime() : now
      const days = (end - start) / 86400000

      const list = stageDurationsDays.get(entry.stage_id) ?? []
      list.push(days)
      stageDurationsDays.set(entry.stage_id, list)

      const isCurrentEntry = !next
      if (
        isCurrentEntry &&
        deal.status === 'open' &&
        meetingStageIds.has(entry.stage_id) &&
        days >= STALL_THRESHOLD_DAYS
      ) {
        stuckInMeetingCount += 1
      }
    }
  }

  const avgTimeInStage: StageDwellTime[] = stages
    .map((s) => {
      const durations = stageDurationsDays.get(s.id) ?? []
      return {
        stageId: s.id,
        stageName: s.name,
        avgDays: average(durations) ?? 0,
        samples: durations.length,
      }
    })
    .filter((s) => s.samples > 0)

  return {
    avgDaysToClose: average(closedDurationsDays),
    avgValueWon: average(wonValues),
    avgValueOpen: average(openValues),
    stuckInMeetingCount,
    stallThresholdDays: STALL_THRESHOLD_DAYS,
    avgTimeInStage,
  }
}

function average(nums: number[]): number | null {
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}
