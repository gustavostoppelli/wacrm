// ============================================================
// O procedimento completo pra garantir que uma reuniao agendada
// pelo modelo realmente aconteceu de ponta a ponta: negocio -> etapa
// -> evento no Google Calendar -> mensagem com o link. Extraido de
// `recordMeetingScheduled` (auto-reply.ts) pra ser reusado tambem
// pelo job de reconciliacao diaria -- mesma logica, chamada tanto em
// tempo real quanto depois, retroativamente.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { findOpenDealForContact } from '@/lib/deals/find-or-create-open-deal'
import { createEventForAccount } from '@/lib/calendar/google'
import { engineSendText } from '@/lib/flows/meta-send'

export interface EnsureMeetingScheduledArgs {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  meetingNote: string
  meetingAt: string | null
  meetingEmail: string | null
  meetingEventLabel: string | null
  businessHoursTimezone: string
}

/**
 * Best-effort, idempotent: NUNCA lança, e nunca reenvia a mensagem do
 * link se o negocio ja tiver `meeting_link` (callers podem chamar de
 * novo em cima de um estado parcial sem medo de duplicar mensagem --
 * e exatamente o que o job de reconciliacao faz).
 */
export async function ensureMeetingScheduled(
  db: SupabaseClient,
  args: EnsureMeetingScheduledArgs,
): Promise<{ completed: boolean }> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    meetingNote,
    meetingAt,
    meetingEmail,
    meetingEventLabel,
    businessHoursTimezone,
  } = args

  const deal = await findOpenDealForContact(db, accountId, contactId, conversationId, configOwnerUserId)
  if (!deal) return { completed: false }

  // Idempotencia: se o negocio ja tem meeting_link (de uma chamada
  // anterior que ja criou o evento e mandou o link), nao recria o
  // evento no Calendar nem reenvia a mensagem -- so retorna completed
  // direto. Isso e o que permite o job de reconciliacao (proxima
  // task) chamar essa mesma funcao em cima de uma intencao que ja
  // teve sucesso parcial sem duplicar nada.
  const { data: existingDeal } = await db
    .from('deals')
    .select('meeting_link')
    .eq('id', deal.id)
    .maybeSingle()
  if (existingDeal?.meeting_link) {
    return { completed: true }
  }

  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', deal.pipeline_id)
    .eq('stage_role', 'meeting_scheduled')
    .maybeSingle()
  if (!stage) return { completed: false }

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

  let completed = false
  if (meetingAt && meetingEmail) {
    // "<label configurado> - <cliente/clínica>" -- the label comes
    // from ai_configs.meeting_event_label (Settings -> Agentes de IA),
    // not accounts.name: that column usually holds the owner's
    // personal name, not a brand name, so it isn't a reliable source
    // for this. Falls back to a generic "Diagnóstico" when unset.
    const summary = `${meetingEventLabel || 'Diagnóstico'} - ${deal.title}`

    const event = await createEventForAccount(db, accountId, {
      summary,
      start: new Date(meetingAt),
      end: new Date(new Date(meetingAt).getTime() + 30 * 60_000),
      attendeeEmail: meetingEmail,
      timeZone: businessHoursTimezone,
    }).catch((err) => {
      console.error('[meeting-scheduling] createEventForAccount failed:', err)
      return null
    })
    if (event) {
      update.meeting_link = event.meetLink
      update.calendar_event_id = event.id
      completed = true
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

  return { completed }
}
