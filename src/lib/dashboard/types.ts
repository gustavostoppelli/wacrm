// Shared result shapes the dashboard components consume. Centralised
// here so each component stays thin and the page-level loader wires
// them up without type gymnastics.

export interface MetricDelta {
  current: number
  previous: number
}

export interface MetricsBundle {
  activeConversations: MetricDelta
  newContactsToday: MetricDelta
  openDealsValue: number
  openDealsCount: number
  messagesSentToday: MetricDelta
}

export interface ConversationsSeriesPoint {
  day: string // YYYY-MM-DD local
  incoming: number
  outgoing: number
}

export interface PipelineStageSlice {
  id: string
  name: string
  color: string
  dealCount: number
  totalValue: number
}

export interface PipelineDonutData {
  stages: PipelineStageSlice[]
  totalValue: number
}

export interface ResponseTimeBucket {
  /** 0 = Mon … 6 = Sun (Monday-first). */
  dow: number
  /** Average first-response time in minutes. Null means no samples. */
  avgMinutes: number | null
  samples: number
}

export interface ResponseTimeSummary {
  buckets: ResponseTimeBucket[]
  thisWeekAvg: number | null
  lastWeekAvg: number | null
}

export type ActivityKind =
  | 'message'
  | 'deal'
  | 'broadcast'
  | 'automation'
  | 'contact'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** Primary line of text rendered in the feed. Pre-formatted. */
  text: string
  /** ISO timestamp the item happened at, drives relative-time + sort. */
  at: string
  /** Optional deep-link for the whole row (not all items have a target). */
  href?: string
}

/**
 * One (source, campaign) bucket in the campaign report — lets an account
 * compare which specific campaign/ad converts best, not just which broad
 * channel (`source`) does. `campaign` is null for rows with no value set
 * (organic WhatsApp, manually-created deals, or a source that doesn't
 * pass one through yet).
 */
export interface CampaignReportRow {
  source: string | null
  campaign: string | null
  totalDeals: number
  meetingScheduledCount: number
  wonCount: number
}

/**
 * Account-wide qualification funnel: total deals -> reached a meeting ->
 * won, plus the open/lost split. Computed fresh from `deals`/
 * `pipeline_stages` on every load, so dragging a card on the Kanban
 * (which just updates `deals.stage_id`/`status`) is reflected the next
 * time this query runs -- no separate sync step.
 */
export interface PipelineFunnelData {
  totalDeals: number
  reachedMeetingCount: number
  wonCount: number
  /** Of the won deals, how many had reached a meeting first. */
  wonFromMeetingCount: number
  lostCount: number
  openCount: number
}

export interface StageDwellTime {
  stageId: string
  stageName: string
  avgDays: number
  /** How many stage visits fed the average — low-confidence below ~5. */
  samples: number
}

/**
 * Second tier of Reports metrics, built on `deal_stage_history` +
 * `deals.closed_at` (migration 047). All computed fresh from current
 * DB state, same "no separate sync step" model as the funnel above.
 */
export interface FunnelInsightsData {
  /** Deal creation -> closed_at, only over won deals with a closed_at. */
  avgDaysToClose: number | null
  avgValueWon: number | null
  avgValueOpen: number | null
  /** Open deals sitting in the meeting-scheduled stage past the stall threshold. */
  stuckInMeetingCount: number
  stallThresholdDays: number
  avgTimeInStage: StageDwellTime[]
}
