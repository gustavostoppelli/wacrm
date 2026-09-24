import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution, findOrCreateInternalRecipient } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import {
  dispatchInboundToAiReply,
  scheduleFollowup,
  clampToBusinessHours,
} from '@/lib/ai/auto-reply'
import { loadAiConfig } from '@/lib/ai/config'
import { engineSendText } from '@/lib/flows/meta-send'
import { loadTodayActivityRanking } from '@/lib/dashboard/queries'
import type { TodayActivityRankingRow } from '@/lib/dashboard/types'
import { resolveDefaultChannelForAccount } from '@/lib/whatsapp/resolve-channel'
import { sendUazapiText } from '@/lib/whatsapp/uazapi-api'
import { getSdrIaConfig } from '@/lib/sdr-ia/config'
import { findOrCreateConversationForChannel, sendSdrIaFirstContact } from '@/lib/sdr-ia/send'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { variantTagName } from '@/lib/sdr-ia/tags'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // BUG (fixed 2026-08-20): this used to `return` here when there were
  // no due automation_pending_executions rows -- which is the common
  // case, since that table only holds paused/waiting automation steps.
  // That early return skipped every drain call below (AI off-hours
  // replies, meeting reminders, followups, reactivation, tasks) on
  // every cron tick where nothing happened to be mid-automation, which
  // in practice meant they almost never actually ran. Confirmed live:
  // a meeting's hour_before reminder sat with sent_at still null well
  // past its send_at.
  let processed = 0
  for (const row of due ?? []) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  const aiProcessed = await drainDueAiReplies(admin)
  const remindersProcessed = await drainDueMeetingReminders(admin)
  const followupsProcessed = await drainDueFollowups(admin)
  const reactivationsProcessed = await drainLostDealReactivation(admin)
  const tasksProcessed = await drainDueTasks(admin)
  const closeDateAlertsProcessed = await drainDueCloseDateAlerts(admin)
  const stageEntryNotificationsProcessed = await drainStageEntryNotifications(admin)
  const dailyDigestsSent = await drainDailyDigest(admin)
  const sdrIaProcessed = await drainSdrIa(admin)

  return NextResponse.json({
    processed,
    ai_processed: aiProcessed,
    reminders_processed: remindersProcessed,
    followups_processed: followupsProcessed,
    reactivations_processed: reactivationsProcessed,
    tasks_processed: tasksProcessed,
    close_date_alerts_processed: closeDateAlertsProcessed,
    stage_entry_notifications_processed: stageEntryNotificationsProcessed,
    daily_digests_sent: dailyDigestsSent,
    sdr_ia_processed: sdrIaProcessed,
  })
}

/**
 * Drains due `ai_pending_replies` rows (see migration 040) — leads who
 * messaged outside business hours and are waiting for the window to
 * open. Re-runs the normal dispatch path for each; since we're now
 * inside business hours by construction, the gate in auto-reply.ts
 * passes through and it generates + sends for real, picking up
 * whatever the lead said in the meantime (buildConversationContext
 * reads live).
 */
async function drainDueAiReplies(
  admin: ReturnType<typeof supabaseAdmin>,
): Promise<number> {
  const { data: due } = await admin
    .from('ai_pending_replies')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(50)

  if (!due || due.length === 0) return 0

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('ai_pending_replies')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    try {
      await dispatchInboundToAiReply({
        accountId: row.account_id as string,
        conversationId: row.conversation_id as string,
        contactId: row.contact_id as string,
        configOwnerUserId: row.config_owner_user_id as string,
      })
    } finally {
      // Always mark done, even on failure -- dispatchInboundToAiReply
      // never throws (it owns its own try/catch), but this table's
      // job is just "did we act on the wake-up", not "did it succeed".
      // Delete rather than keep 'done' rows around indefinitely.
      await admin.from('ai_pending_replies').delete().eq('id', row.id)
    }
    processed++
  }
  return processed
}

const DAY_BEFORE_TEMPLATE = (name: string, when: string, link: string) =>
  `Oi${name ? `, ${name}` : ''}! Passando pra confirmar nossa reunião${
    when ? ` amanhã (${when})` : ' amanhã'
  }. Consegue comparecer?${link ? `\n\nLink da reunião: ${link}` : ''}`

const HOUR_BEFORE_TEMPLATE = (name: string, when: string, link: string) =>
  `Oi${name ? `, ${name}` : ''}! Nossa reunião é daqui a 1 hora${
    when ? ` (${when})` : ''
  }. Te vejo já já!${link ? `\n\nLink da reunião: ${link}` : ''}`

/**
 * Drains due `deal_meeting_reminders` rows (migration 042): sends the
 * day-before/hour-before attendance-confirmation text, and reopens the
 * conversation for the AI Agent (clears `ai_autoreply_disabled` and
 * any human assignment) so that if the lead says they can't make it,
 * the agent itself offers a new time and reschedules — instead of the
 * message just sitting in a human's queue. A human can always
 * reassign themselves if they want back in.
 */
async function drainDueMeetingReminders(
  admin: ReturnType<typeof supabaseAdmin>,
): Promise<number> {
  const { data: due } = await admin
    .from('deal_meeting_reminders')
    .select('*, deal:deals(meeting_scheduled_at, meeting_link), contact:contacts(name)')
    .is('sent_at', null)
    .lte('send_at', new Date().toISOString())
    .order('send_at', { ascending: true })
    .limit(50)

  if (!due || due.length === 0) return 0

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('deal_meeting_reminders')
      .update({ sent_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('sent_at', null)
      .select('id')
      .maybeSingle()
    if (!claim) continue

    const name = (row.contact as { name?: string } | null)?.name ?? ''
    const dealRow = row.deal as { meeting_scheduled_at?: string; meeting_link?: string } | null
    const meetingAt = dealRow?.meeting_scheduled_at
    const link = dealRow?.meeting_link ?? ''
    const when = meetingAt
      ? new Date(meetingAt).toLocaleString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : ''
    const text =
      row.kind === 'day_before'
        ? DAY_BEFORE_TEMPLATE(name, when, link)
        : HOUR_BEFORE_TEMPLATE(name, when, link)

    try {
      // Reopen the thread for the AI agent BEFORE sending, so an
      // immediate reply from the lead (common right after a reminder)
      // lands while the conversation is already eligible again.
      await admin
        .from('conversations')
        .update({ ai_autoreply_disabled: false, assigned_agent_id: null })
        .eq('id', row.conversation_id)

      await engineSendText({
        accountId: row.account_id as string,
        userId: row.config_owner_user_id as string,
        conversationId: row.conversation_id as string,
        contactId: row.contact_id as string,
        text,
        aiGenerated: true,
      })
    } catch (err) {
      console.error('[meeting reminder] send failed:', err)
    }
    processed++
  }
  return processed
}

const FOLLOWUP_TEMPLATE_1 = (name: string) =>
  `Oi${name ? `, ${name}` : ''}! Só passando pra saber se você viu minha última mensagem. Quando puder, me conta.`

const FOLLOWUP_TEMPLATE_2 = (name: string) =>
  `Oi de novo${name ? `, ${name}` : ''}! Ainda dá tempo de continuar nossa conversa, é só responder por aqui quando puder.`

/**
 * Drains due `conversation_followups` rows (migration 044): a lead
 * who went quiet mid-qualification gets a nudge. Any real inbound
 * message deletes the pending row outright (see the top of
 * dispatchInboundToAiReply), so this mostly just double-checks
 * eligibility hasn't changed via some other path (a human taking the
 * thread) before sending — belt and suspenders against races with the
 * inbound webhook, not the primary cancellation mechanism.
 */
async function drainDueFollowups(
  admin: ReturnType<typeof supabaseAdmin>,
): Promise<number> {
  const { data: due } = await admin
    .from('conversation_followups')
    .select('*, contact:contacts(name)')
    .is('sent_at', null)
    .lte('send_at', new Date().toISOString())
    .order('send_at', { ascending: true })
    .limit(50)

  if (!due || due.length === 0) return 0

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('conversation_followups')
      .update({ sent_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('sent_at', null)
      .select('id')
      .maybeSingle()
    if (!claim) continue

    try {
      const { data: conv } = await admin
        .from('conversations')
        .select('assigned_agent_id, ai_autoreply_disabled')
        .eq('id', row.conversation_id)
        .maybeSingle()
      if (!conv || conv.assigned_agent_id || conv.ai_autoreply_disabled) {
        processed++
        continue
      }

      const { count: repliedSince } = await admin
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', row.conversation_id)
        .eq('sender_type', 'customer')
        .gt('created_at', row.last_outbound_at as string)
      if ((repliedSince ?? 0) > 0) {
        processed++
        continue
      }

      const name = (row.contact as { name?: string } | null)?.name ?? ''
      const text = row.attempt === 1 ? FOLLOWUP_TEMPLATE_1(name) : FOLLOWUP_TEMPLATE_2(name)

      await engineSendText({
        accountId: row.account_id as string,
        userId: row.config_owner_user_id as string,
        conversationId: row.conversation_id as string,
        contactId: row.contact_id as string,
        text,
        aiGenerated: true,
      })

      if (row.attempt === 1) {
        const config = await loadAiConfig(admin, row.account_id as string, {
          requireActive: false,
        })
        const nextSendAt = config
          ? clampToBusinessHours(new Date(Date.now() + 24 * 60 * 60_000), config)
          : new Date(Date.now() + 24 * 60 * 60_000)
        await scheduleFollowup(admin, {
          accountId: row.account_id as string,
          conversationId: row.conversation_id as string,
          contactId: row.contact_id as string,
          configOwnerUserId: row.config_owner_user_id as string,
          attempt: 2,
          sendAt: nextSendAt,
          lastOutboundAt: new Date(),
        })
      }
      // attempt 2 with still no reply: no reschedule -- the system
      // stops trying on its own, per spec.
    } catch (err) {
      console.error('[conversation followup] send failed:', err)
    }
    processed++
  }
  return processed
}

const DEFAULT_REACTIVATION_TEMPLATE = (name: string) =>
  `Oi${name ? `, ${name}` : ''}! Faz um tempo que a gente não conversa. Ainda tem interesse em retomar? Se sim, é só me responder por aqui.`

/**
 * Re-engages deals marked "lost" a while ago -- one native, opt-in
 * mechanism any account can turn on (see migration 048), not a
 * Fuse-specific script.
 *
 * Scoped to deals that already have a `conversation_id`: only a
 * contact who's had a real WhatsApp thread before is eligible. A deal
 * that arrived via the public API bridge (a form, an ads sync) and
 * was lost without the lead ever messaging in has no conversation to
 * resume -- sending a first WhatsApp message to someone who's never
 * opened a thread is exactly the unsolicited business-initiated
 * pattern this account's number needs to avoid (see the ban-risk
 * discussion this session settled on for the site form's WhatsApp
 * button). This mirrors that same boundary automatically.
 */
async function drainLostDealReactivation(
  admin: ReturnType<typeof supabaseAdmin>,
): Promise<number> {
  const { data: configs } = await admin
    .from('ai_configs')
    .select('account_id, reactivation_days, reactivation_message')
    .eq('reactivation_enabled', true)

  if (!configs || configs.length === 0) return 0

  let processed = 0
  for (const cfg of configs) {
    const days = (cfg.reactivation_days as number | null) ?? 90
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString()

    const { data: deals } = await admin
      .from('deals')
      .select('id, account_id, user_id, contact_id, conversation_id, contact:contacts(name)')
      .eq('account_id', cfg.account_id as string)
      .eq('status', 'lost')
      .not('conversation_id', 'is', null)
      .lte('closed_at', cutoff)
      .is('reactivation_sent_at', null)
      // Caps how many one account can trigger per cron tick -- a large
      // backlog the first time this is turned on drains gradually
      // across ticks instead of firing dozens of messages at once.
      .limit(20)

    if (!deals || deals.length === 0) continue

    for (const deal of deals) {
      const { data: claim } = await admin
        .from('deals')
        .update({ reactivation_sent_at: new Date().toISOString() })
        .eq('id', deal.id)
        .is('reactivation_sent_at', null)
        .select('id')
        .maybeSingle()
      if (!claim) continue

      try {
        const contact = Array.isArray(deal.contact) ? deal.contact[0] : deal.contact
        const name = (contact as { name?: string } | null)?.name ?? ''
        const template = (cfg.reactivation_message as string | null)?.trim()
        const text = template
          ? template.replace(/\{\{\s*nome\s*\}\}/gi, name)
          : DEFAULT_REACTIVATION_TEMPLATE(name)

        // Reopen for the AI agent so a reply picks the conversation
        // back up automatically, same as meeting reminders/followups.
        await admin
          .from('conversations')
          .update({ ai_autoreply_disabled: false, assigned_agent_id: null })
          .eq('id', deal.conversation_id as string)

        await engineSendText({
          accountId: deal.account_id as string,
          userId: deal.user_id as string,
          conversationId: deal.conversation_id as string,
          contactId: deal.contact_id as string,
          text,
          aiGenerated: true,
        })
      } catch (err) {
        console.error('[deal reactivation] send failed:', err)
      }
      processed++
    }
  }
  return processed
}

/**
 * Drains due `tasks` (migration 050) into a `task_due` row on the
 * existing `notifications` table -- reuses the unread-badge + realtime
 * subscription already built for conversation-assignment alerts (027)
 * instead of a new delivery path. A human's reminder, not something
 * the AI agent or a lead ever sees.
 */
async function drainDueTasks(admin: ReturnType<typeof supabaseAdmin>): Promise<number> {
  const { data: due } = await admin
    .from('tasks')
    .select('id, account_id, assigned_to, deal_id, contact_id, title, deal:deals(title)')
    .is('completed_at', null)
    .is('reminder_sent_at', null)
    .lte('due_at', new Date().toISOString())
    .order('due_at', { ascending: true })
    .limit(50)

  if (!due || due.length === 0) return 0

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('tasks')
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('reminder_sent_at', null)
      .select('id')
      .maybeSingle()
    if (!claim) continue

    try {
      const dealRow = Array.isArray(row.deal) ? row.deal[0] : row.deal
      const dealTitle = (dealRow as { title?: string } | null)?.title
      const body = dealTitle ? `${row.title as string} — ${dealTitle}` : (row.title as string)

      await admin.from('notifications').insert({
        account_id: row.account_id,
        user_id: row.assigned_to,
        type: 'task_due',
        deal_id: row.deal_id,
        contact_id: row.contact_id,
        title: 'Tarefa vencendo',
        body,
      })
    } catch (err) {
      console.error('[task reminder] notify failed:', err)
    }
    processed++
  }
  return processed
}

/**
 * Drains open deals (migration 052) whose `expected_close_date` has
 * arrived or passed into a `deal_close_due` notification -- "time to
 * close this" the day it's due, "this is overdue" every day after
 * until someone changes the date or moves the deal to won/lost.
 * `expected_close_date` is a plain DATE (no timezone), so "due" is
 * evaluated against the cron server's own UTC date, same
 * best-effort precision as the rest of this file's day-level checks.
 * Notifies `assigned_to` when set, falling back to the deal's
 * creator (`user_id`) otherwise -- mirrors who a human would actually
 * expect to hear about it.
 */
async function drainDueCloseDateAlerts(
  admin: ReturnType<typeof supabaseAdmin>,
): Promise<number> {
  const today = new Date().toISOString().slice(0, 10)

  const { data: due } = await admin
    .from('deals')
    .select('id, account_id, user_id, assigned_to, contact_id, title, expected_close_date')
    .eq('status', 'open')
    .lte('expected_close_date', today)
    .is('close_date_alert_sent_at', null)
    .order('expected_close_date', { ascending: true })
    .limit(50)

  if (!due || due.length === 0) return 0

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('deals')
      .update({ close_date_alert_sent_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('close_date_alert_sent_at', null)
      .select('id')
      .maybeSingle()
    if (!claim) continue

    try {
      const isOverdue = (row.expected_close_date as string) < today
      const body = isOverdue
        ? `${row.title as string} — data de fechamento passou (${row.expected_close_date as string})`
        : `${row.title as string} — data de fechamento é hoje`

      await admin.from('notifications').insert({
        account_id: row.account_id,
        user_id: (row.assigned_to as string | null) ?? row.user_id,
        type: 'deal_close_due',
        deal_id: row.id,
        contact_id: row.contact_id,
        title: isOverdue ? 'Fechamento atrasado' : 'Fechar hoje',
        body,
      })
    } catch (err) {
      console.error('[deal close date alert] notify failed:', err)
    }
    processed++
  }
  return processed
}

/**
 * Drains open deals that just entered a stage with `notify_phone` set
 * (migration 061) — sends a WhatsApp alert to every comma-separated
 * number configured on that stage (e.g. every connected salesperson's
 * own number, "avisar todo mundo quando cair um lead novo"). No
 * automation trigger exists for "a deal reached stage X" (every
 * existing trigger is message/conversation-centric), so this is its
 * own dedicated drain rather than routed through the automations
 * engine.
 *
 * Dedupe compares `stage_notify_sent_at` against `stage_entered_at`
 * (migration 056) instead of nulling it out on every stage change — a
 * deal that later re-enters the same notify-configured stage
 * re-arms the alert on its own the moment `stage_entered_at` moves
 * past the last `stage_notify_sent_at`, no extra reset trigger
 * needed. The claim re-checks `stage_entered_at` hasn't moved again
 * since we read it, so a deal dragged twice in quick succession can't
 * double-send.
 */
async function drainStageEntryNotifications(
  admin: ReturnType<typeof supabaseAdmin>,
): Promise<number> {
  const { data: stages } = await admin
    .from('pipeline_stages')
    .select('id, name, notify_phone')
    .not('notify_phone', 'is', null)

  if (!stages || stages.length === 0) return 0

  let processed = 0
  for (const stage of stages) {
    const phones = ((stage.notify_phone as string) ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    if (phones.length === 0) continue

    const { data: deals } = await admin
      .from('deals')
      .select(
        'id, account_id, user_id, contact_id, title, stage_entered_at, stage_notify_sent_at, contact:contacts(name)',
      )
      .eq('stage_id', stage.id as string)
      .eq('status', 'open')
      .limit(20)

    if (!deals || deals.length === 0) continue

    for (const deal of deals) {
      const sentAt = deal.stage_notify_sent_at as string | null
      const enteredAt = deal.stage_entered_at as string
      if (sentAt && sentAt >= enteredAt) continue // already notified for this stage entry

      const { data: claim } = await admin
        .from('deals')
        .update({ stage_notify_sent_at: new Date().toISOString() })
        .eq('id', deal.id)
        .eq('stage_entered_at', enteredAt)
        .select('id')
        .maybeSingle()
      if (!claim) continue

      const contact = Array.isArray(deal.contact) ? deal.contact[0] : deal.contact
      const contactName = (contact as { name?: string } | null)?.name || (deal.title as string)
      const text = `🔔 Novo lead: ${contactName} entrou em "${stage.name as string}"`

      for (const phone of phones) {
        try {
          const recipient = await findOrCreateInternalRecipient(
            admin,
            deal.account_id as string,
            deal.user_id as string,
            phone,
          )
          if (!recipient) continue
          await engineSendText({
            accountId: deal.account_id as string,
            userId: deal.user_id as string,
            conversationId: recipient.conversationId,
            contactId: recipient.contactId,
            text,
            aiGenerated: false,
          })
        } catch (err) {
          console.error('[stage entry notify] send failed:', phone, err)
        }
      }
      processed++
    }
  }
  return processed
}

/** `YYYY-MM-DD` and current hour (0-23), both in America/Sao_Paulo —
 *  the digest's send time ("18h") and its "one per day" dedup key are
 *  both anchored to that timezone regardless of where the server runs. */
function brazilTodayAndHour(): { today: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date())
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return {
    today: `${get('year')}-${get('month')}-${get('day')}`,
    // Intl can format midnight as "24" with hour12: false in some
    // environments — normalize so the >= 18 check below is never
    // fooled into thinking it's still "before 18h".
    hour: Number(get('hour')) % 24,
  }
}

function formatDigestSection(
  title: string,
  rows: TodayActivityRankingRow[],
  metric: keyof Omit<TodayActivityRankingRow, 'userId' | 'name'>,
): string {
  const ranked = rows.filter((r) => r[metric] > 0).sort((a, b) => b[metric] - a[metric])
  if (ranked.length === 0) return `*${title}*\nNinguém ainda.`
  const lines = ranked.map((r, i) => `${i + 1}. ${r.name} — ${r[metric]}`)
  return `*${title}*\n${lines.join('\n')}`
}

/**
 * Sends the daily WhatsApp activity digest (migration 065) once per
 * account per calendar day, after 18:00 America/Sao_Paulo. The 5-minute
 * cron poll means this can run up to ~12 times between 18:00 and
 * midnight before `daily_digest_last_sent_date` gets claimed on the
 * first due run — the claim below (conditional UPDATE + confirm via
 * the returned row) is what keeps that from sending N times.
 */
async function drainDailyDigest(admin: ReturnType<typeof supabaseAdmin>): Promise<number> {
  const { today, hour } = brazilTodayAndHour()
  if (hour < 18) return 0

  const { data: accounts } = await admin
    .from('accounts')
    .select('id, owner_user_id, daily_digest_phones, daily_digest_group_jid, daily_digest_last_sent_date')
    .eq('daily_digest_enabled', true)

  if (!accounts || accounts.length === 0) return 0

  let sent = 0
  for (const account of accounts) {
    const lastSent = account.daily_digest_last_sent_date as string | null
    if (lastSent === today) continue // already sent today

    const phones = ((account.daily_digest_phones as string) ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    const groupJid = account.daily_digest_group_jid as string | null
    if (phones.length === 0 && !groupJid) continue

    // Claim: only proceeds if this run is the first to flip the date
    // for today (the .or() also matches accounts that have never sent
    // one, where the column is still null).
    const { data: claim } = await admin
      .from('accounts')
      .update({ daily_digest_last_sent_date: today })
      .eq('id', account.id)
      .or(`daily_digest_last_sent_date.is.null,daily_digest_last_sent_date.neq.${today}`)
      .select('id')
      .maybeSingle()
    if (!claim) continue

    try {
      const accountId = account.id as string
      const ownerUserId = account.owner_user_id as string
      const [dayRows, monthRows] = await Promise.all([
        loadTodayActivityRanking(admin, accountId, 'today'),
        loadTodayActivityRanking(admin, accountId, 'month'),
      ])

      const [dd, mm, yyyy] = [today.slice(8, 10), today.slice(5, 7), today.slice(0, 4)]
      const text = [
        `📊 *Resumo do dia — ${dd}/${mm}/${yyyy}*`,
        '',
        formatDigestSection('1º contato hoje', dayRows, 'firstContacts'),
        '',
        formatDigestSection('Follow-up hoje', dayRows, 'followUps'),
        '',
        formatDigestSection('Fechados hoje', dayRows, 'dealsClosed'),
        '',
        `📅 *Acumulado no mês*`,
        formatDigestSection('1º contato', monthRows, 'firstContacts'),
        '',
        formatDigestSection('Follow-up', monthRows, 'followUps'),
        '',
        formatDigestSection('Fechados', monthRows, 'dealsClosed'),
      ].join('\n')

      for (const phone of phones) {
        try {
          const recipient = await findOrCreateInternalRecipient(admin, accountId, ownerUserId, phone)
          if (!recipient) continue
          await engineSendText({
            accountId,
            userId: ownerUserId,
            conversationId: recipient.conversationId,
            contactId: recipient.contactId,
            text,
            aiGenerated: false,
          })
        } catch (err) {
          console.error('[daily digest] send failed:', phone, err)
        }
      }

      // A WhatsApp group isn't a `contacts` row — sending to one goes
      // straight to the provider with the raw group JID (never through
      // sanitizePhoneForMeta, which would strip the "@g.us" suffix a
      // group id needs). UAZAPI-only; `resolveDefaultChannelForAccount`
      // returns undefined credentials for a Meta channel and this is
      // just skipped.
      if (groupJid) {
        try {
          const channel = await resolveDefaultChannelForAccount(admin, accountId)
          if (channel?.provider === 'uazapi' && channel.uazapiBaseUrl && channel.uazapiInstanceToken) {
            await sendUazapiText({
              baseUrl: channel.uazapiBaseUrl,
              instanceToken: channel.uazapiInstanceToken,
              to: groupJid,
              text,
            })
          }
        } catch (err) {
          console.error('[daily digest] group send failed:', groupJid, err)
        }
      }
      sent++
    } catch (err) {
      console.error('[daily digest] failed for account:', account.id, err)
    }
  }
  return sent
}

/**
 * Sends SDR IA first-contact messages for every account with both
 * accounts.sdr_ia_enabled AND sdr_ia_config.enabled true, respecting
 * each account's configured business hours and daily cap. Runs on
 * every cron tick (unlike the daily digest, this has no "once per
 * day" claim — each account's `sent_today`/`last_sent_date`
 * (migration 071) track real per-day volume, incremented atomically
 * per successful send via the `sdr_ia_register_sent` RPC — not a
 * per-tick counter.
 */
async function drainSdrIa(admin: ReturnType<typeof supabaseAdmin>): Promise<number> {
  const { today, hour } = brazilTodayAndHour()

  const { data: accounts } = await admin
    .from('accounts')
    .select('id, owner_user_id')
    .eq('sdr_ia_enabled', true)

  if (!accounts || accounts.length === 0) return 0

  let sent = 0
  for (const account of accounts) {
    const accountId = account.id as string
    const ownerUserId = account.owner_user_id as string

    const config = await getSdrIaConfig(admin, accountId)
    if (!config || !config.enabled) continue
    if (hour < config.hoursStart || hour >= config.hoursEnd) continue
    if (!config.leadTagId || !config.contactedTagId || !config.whatsappConfigId) continue

    const sentToday = config.lastSentDate === today ? config.sentToday : 0
    const remaining = config.dailyCap - sentToday
    if (remaining <= 0) continue

    const { data: candidates } = await admin.rpc('sdr_ia_next_candidates', {
      p_account_id: accountId,
      p_lead_tag_id: config.leadTagId,
      p_contacted_tag_id: config.contactedTagId,
      p_exclusion_tag_id: config.exclusionTagId,
      p_limit: remaining,
    })

    for (const candidate of candidates ?? []) {
      const contactId = candidate.contact_id as string

      // Claim BEFORE sending: the unique constraint on
      // contact_tags(contact_id, tag_id) is the atomic lock. The RPC's
      // exclusion check above is a plain SELECT, not a lock, so two
      // overlapping cron invocations (no infra-level overlap guard on
      // this endpoint) can both fetch the same untagged candidate.
      // Whichever call's addContactTagIfAbsent lands first wins the
      // claim; the loser sees `false` and must skip the send entirely
      // to avoid a duplicate WhatsApp message to the same lead. This
      // is the expected/normal skip path under concurrent runs, not an
      // error.
      let claimed: boolean
      try {
        claimed = await addContactTagIfAbsent(admin, {
          accountId,
          contactId,
          tagId: config.contactedTagId,
        })
      } catch (err) {
        console.error('[sdr-ia] failed to claim candidate (tag write):', contactId, err)
        continue
      }
      if (!claimed) continue // already claimed by another run — skip, don't send

      try {
        const conversationId = await findOrCreateConversationForChannel(
          admin,
          accountId,
          ownerUserId,
          contactId,
          config.whatsappConfigId,
        )
        const { variantIndex } = await sendSdrIaFirstContact(admin, {
          accountId,
          userId: ownerUserId,
          contactId,
          conversationId,
          config,
        })

        if (variantIndex !== null) {
          const variantName = variantTagName(variantIndex + 1)
          const { data: variantTag } = await admin
            .from('tags')
            .select('id')
            .eq('account_id', accountId)
            .ilike('name', variantName)
            .maybeSingle()
          if (variantTag) {
            await addContactTagIfAbsent(admin, { accountId, contactId, tagId: variantTag.id as string })
          }
        }
        sent++
        await admin.rpc('sdr_ia_register_sent', { p_account_id: accountId, p_today: today })
      } catch (err) {
        // The contact is already tagged as contacted (claimed above)
        // but the send itself failed here -- intentionally NOT
        // un-tagging: a send that times out client-side may still have
        // gone through provider-side, and un-tagging risks a retry
        // double-sending a message that already landed. Treat this as
        // a missed contact to investigate manually, not a retryable
        // failure.
        console.error(
          '[sdr-ia] contact was tagged as contacted but message may not have sent:',
          contactId,
          err,
        )
      }
    }
  }

  return sent
}
