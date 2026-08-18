import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import {
  dispatchInboundToAiReply,
  scheduleFollowup,
  clampToBusinessHours,
} from '@/lib/ai/auto-reply'
import { loadAiConfig } from '@/lib/ai/config'
import { engineSendText } from '@/lib/flows/meta-send'

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
  if (!due || due.length === 0) return NextResponse.json({ processed: 0 })

  let processed = 0
  for (const row of due) {
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

  return NextResponse.json({
    processed,
    ai_processed: aiProcessed,
    reminders_processed: remindersProcessed,
    followups_processed: followupsProcessed,
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
