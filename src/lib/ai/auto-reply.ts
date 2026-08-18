import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { isWithinBusinessHours, nextBusinessHourStart } from './business-hours'
import { createEventForAccount } from '@/lib/calendar/google'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    // Any real inbound message means the lead is no longer silent --
    // cancel whatever re-engagement nudge might be pending for this
    // conversation, regardless of what happens next in this dispatch
    // (a fresh one is scheduled below only if this turn ends in a
    // normal, non-handoff auto-reply).
    await db.from('conversation_followups').delete().eq('conversation_id', conversationId)

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    // Business hours: the model has no way to "hold" a reply and send
    // it later on its own — it only runs reactively, once, per
    // inbound. So this is enforced here, deterministically, instead
    // of trusting prompt text the model can't actually act on. An
    // off-hours inbound gets an immediate canned ack (not from the
    // LLM) and the real reply is deferred to the next window via
    // ai_pending_replies, drained by /api/automations/cron.
    if (
      config.businessHoursEnabled &&
      !isWithinBusinessHours({
        enabled: true,
        startHour: config.businessHoursStart,
        endHour: config.businessHoursEnd,
        timezone: config.businessHoursTimezone,
      })
    ) {
      await scheduleOffHoursReply(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        config,
      })
      return
    }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      timezone: config.businessHoursTimezone,
    })

    const { text, handoff, meetingNote, meetingAt, meetingEmail, notes, usage } =
      await generateReply({ config, systemPrompt, messages })

    // A meeting time was just confirmed this turn -- move the deal to
    // the pipeline's designated stage (if the account has one), record
    // what was agreed, (re)schedule attendance-confirmation reminders,
    // and — with an email and Calendar connected — create a real
    // event. Runs regardless of whether this turn also hands off to a
    // human. Best-effort: a missing deal/stage (no deal linked to this
    // contact, or the pipeline has no meeting_scheduled stage
    // configured) just means nothing moves.
    if (meetingNote) {
      await recordMeetingScheduled(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        meetingNote,
        meetingAt,
        meetingEmail,
        config,
      })
    }

    // A structured qualification summary was included this turn --
    // written into the deal's notes so a human sees a clean field-by-
    // field summary instead of the raw chat log, matching how leads
    // from the Apify/Meta/site-form bridge already arrive.
    if (notes) {
      await recordQualificationNotes(db, { accountId, contactId, notes })
    }

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
      }
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })

    // A normal (non-handoff) reply just went out -- if the lead goes
    // quiet from here, nudge them once in ~4 business hours. Any
    // inbound message (including their reply) cancels this via the
    // delete at the top of this function; the cron reschedules a 2nd
    // attempt for the next business day if the 1st also goes unanswered.
    if (config.followupEnabled) {
      await scheduleFollowup(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        attempt: 1,
        sendAt: clampToBusinessHours(new Date(Date.now() + 4 * 60 * 60_000), config),
        lastOutboundAt: new Date(),
      })
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

/**
 * Moves the deal linked to this conversation to the pipeline's
 * "meeting scheduled" stage (see migration 041), stamps what was
 * agreed, and — when a real date-time was parsed — (re)schedules the
 * day-before/hour-before reminders (migration 042). Silently does
 * nothing if there's no deal on this conversation, or the deal's
 * pipeline has no stage tagged for this — native to any account, but
 * only active once one is configured. Also covers rescheduling: this
 * runs again whenever the model confirms a new time (e.g. the lead
 * asked to move it after a reminder), simply overwriting the stage/
 * note and replacing any not-yet-sent reminders.
 */
async function recordMeetingScheduled(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    configOwnerUserId: string
    meetingNote: string
    meetingAt: string | null
    meetingEmail: string | null
    config: AiConfig
  },
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    meetingNote,
    meetingAt,
    meetingEmail,
    config,
  } = args

  const deal = await findOpenDealForContact(db, accountId, contactId, conversationId)
  if (!deal) return

  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', deal.pipeline_id)
    .eq('stage_role', 'meeting_scheduled')
    .maybeSingle()
  if (!stage) return

  const update: Record<string, unknown> = { stage_id: stage.id, meeting_note: meetingNote }
  if (meetingAt) update.meeting_scheduled_at = meetingAt

  // Save the email onto the contact record too (not just used to
  // build the calendar invite below) so it shows up on the contact
  // card even if Calendar isn't connected for this account.
  if (meetingEmail) {
    const { data: contact } = await db
      .from('contacts')
      .select('email')
      .eq('id', contactId)
      .maybeSingle()
    if (!contact?.email) {
      await db.from('contacts').update({ email: meetingEmail }).eq('id', contactId)
    }
  }

  if (meetingAt && meetingEmail) {
    // "Diagnóstico <conta> - <cliente/clínica>" -- generic (any
    // account's own name goes here, not hardcoded), so the event
    // title is recognizable in Google Calendar regardless of who's
    // using it.
    const { data: account } = await db
      .from('accounts')
      .select('name')
      .eq('id', accountId)
      .maybeSingle()
    const summary = account?.name
      ? `Diagnóstico ${account.name} - ${deal.title}`
      : `Diagnóstico - ${deal.title}`

    const event = await createEventForAccount(db, accountId, {
      summary,
      start: new Date(meetingAt),
      end: new Date(new Date(meetingAt).getTime() + 30 * 60_000),
      attendeeEmail: meetingEmail,
      timeZone: config.businessHoursTimezone,
    }).catch((err) => {
      console.error('[ai auto-reply] createEventForAccount failed:', err)
      return null
    })
    if (event) {
      update.meeting_link = event.meetLink
      update.calendar_event_id = event.id
    }
  }

  await db.from('deals').update(update).eq('id', deal.id)

  // The model's own reply (already sent by the caller) can't include
  // the Meet link -- it doesn't exist yet at generation time, since
  // creating it depends on this same turn's tag being parsed first.
  // Send it as a short follow-up instead of trying to inject it into
  // the model's text after the fact.
  if (update.meeting_link) {
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: `Aqui está o link da nossa reunião: ${update.meeting_link}`,
      aiGenerated: true,
    })

    // Only asked once the event is actually confirmed -- doesn't block
    // scheduling, just enriches the deal for whoever preps the meeting.
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: 'Só mais uma coisa pra fechar: pode me passar o nome da clínica, o site ou o Instagram? Assim já vamos analisar o contexto e preparar um diagnóstico completo pra nossa reunião.',
      aiGenerated: true,
    })
  }

  if (meetingAt && config.meetingRemindersEnabled) {
    await scheduleMeetingReminders(db, {
      accountId,
      dealId: deal.id,
      conversationId,
      contactId,
      configOwnerUserId,
      meetingAt: new Date(meetingAt),
      config,
    })
  }
}

/**
 * Writes a structured qualification summary into the deal's notes
 * (overwriting — the model is instructed to send the *cumulative*
 * summary each time, not a delta, so last-write-wins is correct).
 * Same best-effort "no open deal yet" no-op as recordMeetingScheduled.
 */
async function recordQualificationNotes(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; notes: string },
): Promise<void> {
  const { accountId, contactId, notes } = args
  const deal = await findOpenDealForContact(db, accountId, contactId, null)
  if (!deal) return
  await db.from('deals').update({ notes }).eq('id', deal.id)
}

/**
 * Deals created via the public API (the Apify/Meta/site-form bridge —
 * see POST /api/v1/deals) only ever get `contact_id` set, never
 * `conversation_id`: the conversation itself is created separately,
 * whenever the contact's first WhatsApp message actually arrives, so
 * nothing links the two at creation time. Matching on
 * `conversation_id` alone would silently never find a deal for any
 * real lead, so this always resolves by contact -- `status = 'open'`
 * picks the live deal over an already won/lost one if the contact has
 * history. When `conversationId` is given and the found deal doesn't
 * have one yet, opportunistically backfills it.
 */
async function findOpenDealForContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string | null,
): Promise<{ id: string; pipeline_id: string; title: string } | null> {
  const { data: deal } = await db
    .from('deals')
    .select('id, pipeline_id, title, conversation_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!deal) return null

  if (conversationId && !deal.conversation_id) {
    await db.from('deals').update({ conversation_id: conversationId }).eq('id', deal.id)
  }

  return deal
}

/**
 * Adjusts a candidate reminder moment into business hours: if it
 * already falls inside the window, it's used as-is (this is how the
 * hour-before reminder normally lands, since meetings are themselves
 * booked in business hours); otherwise it's pushed forward to the
 * next window open (this is the common case for the day-before
 * reminder, which literally computed as "meeting time minus 24h" can
 * land at any hour).
 */
export function clampToBusinessHours(
  at: Date,
  config: AiConfig,
): Date {
  const bh = {
    enabled: true,
    startHour: config.businessHoursStart,
    endHour: config.businessHoursEnd,
    timezone: config.businessHoursTimezone,
  }
  if (!config.businessHoursEnabled || isWithinBusinessHours(bh, at)) return at
  return nextBusinessHourStart(bh, at)
}

/**
 * Replaces any not-yet-sent reminders for this deal with two fresh
 * ones: exactly 1 hour before the meeting, and 1 day before adjusted
 * into business hours (see clampToBusinessHours). Skips a reminder
 * whose computed time has already passed (e.g. the meeting is being
 * confirmed less than 24h out).
 */
async function scheduleMeetingReminders(
  db: SupabaseClient,
  args: {
    accountId: string
    dealId: string
    conversationId: string
    contactId: string
    configOwnerUserId: string
    meetingAt: Date
    config: AiConfig
  },
): Promise<void> {
  const { accountId, dealId, conversationId, contactId, configOwnerUserId, meetingAt, config } =
    args

  const hourBefore = clampToBusinessHours(
    new Date(meetingAt.getTime() - 60 * 60_000),
    config,
  )
  const dayBefore = clampToBusinessHours(
    new Date(meetingAt.getTime() - 24 * 60 * 60_000),
    config,
  )

  // The meeting time may have just changed (reschedule) — drop
  // whatever wasn't sent yet and recompute from scratch.
  await db.from('deal_meeting_reminders').delete().eq('deal_id', dealId).is('sent_at', null)

  const now = Date.now()
  const rows = [
    { kind: 'day_before', send_at: dayBefore },
    { kind: 'hour_before', send_at: hourBefore },
  ]
    .filter((r) => r.send_at.getTime() > now)
    .map((r) => ({
      account_id: accountId,
      deal_id: dealId,
      conversation_id: conversationId,
      contact_id: contactId,
      config_owner_user_id: configOwnerUserId,
      kind: r.kind,
      send_at: r.send_at.toISOString(),
    }))

  if (rows.length > 0) {
    await db.from('deal_meeting_reminders').insert(rows)
  }
}

/**
 * Schedules (or replaces) the pending re-engagement nudge for this
 * conversation. `UNIQUE(conversation_id)` means only one can be
 * outstanding at a time -- delete-then-insert rather than upsert
 * because `attempt` and `last_outbound_at` both need to move together
 * whenever this is called again.
 */
export async function scheduleFollowup(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    configOwnerUserId: string
    attempt: 1 | 2
    sendAt: Date
    lastOutboundAt: Date
  },
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId, attempt, sendAt, lastOutboundAt } =
    args
  await db.from('conversation_followups').delete().eq('conversation_id', conversationId)
  await db.from('conversation_followups').insert({
    account_id: accountId,
    conversation_id: conversationId,
    contact_id: contactId,
    config_owner_user_id: configOwnerUserId,
    attempt,
    send_at: sendAt.toISOString(),
    last_outbound_at: lastOutboundAt.toISOString(),
  })
}

const DEFAULT_OFF_HOURS_MESSAGE =
  'Recebemos seu contato! Vamos te responder assim que abrirmos, no próximo horário comercial.'

/**
 * Sends the off-hours ack (once per "wave" -- not on every message the
 * lead sends while we're closed) and queues a wake-up row so the real
 * AI reply fires automatically once business hours open, without a
 * human having to do anything.
 */
async function scheduleOffHoursReply(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    configOwnerUserId: string
    config: AiConfig
  },
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId, config } = args

  const { data: existingPending } = await db
    .from('ai_pending_replies')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('status', 'pending')
    .maybeSingle()
  if (existingPending) return // already acked and queued for this off-hours wave

  const scheduledFor = nextBusinessHourStart({
    enabled: true,
    startHour: config.businessHoursStart,
    endHour: config.businessHoursEnd,
    timezone: config.businessHoursTimezone,
  })

  // Best-effort insert-first: if this races another inbound for the
  // same conversation, the UNIQUE(conversation_id) constraint makes
  // the loser's insert fail harmlessly -- and the loser then also
  // skips the ack send below, so we still never double-ack.
  const { error: insertErr } = await db.from('ai_pending_replies').insert({
    account_id: accountId,
    conversation_id: conversationId,
    contact_id: contactId,
    config_owner_user_id: configOwnerUserId,
    scheduled_for: scheduledFor.toISOString(),
  })
  if (insertErr) return // lost the race, or a real error -- either way, don't double-ack

  await engineSendText({
    accountId,
    userId: configOwnerUserId,
    conversationId,
    contactId,
    text: config.offHoursMessage?.trim() || DEFAULT_OFF_HOURS_MESSAGE,
    aiGenerated: true,
  })
}
