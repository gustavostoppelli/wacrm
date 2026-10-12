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
  /** Quando vem de uma ai_meeting_intents já gravada (tempo real logo
   *  após criá-la, ou a reconciliação revisitando uma antiga), marca
   *  essa linha resolvida ao completar com sucesso. */
  intentId: string | null
}

export interface EnsureMeetingScheduledResult {
  completed: boolean
  /**
   * Id do negocio cujas etapa/campos de reuniao foram de fato escritos
   * (ou ja estavam, de uma chamada idempotente anterior) -- `null`
   * quando nao ha negocio nenhum, OU quando a conta nao tem etapa
   * `meeting_scheduled` configurada (nada foi escrito). Callers (hoje:
   * o agendamento de lembretes em auto-reply.ts) usam isso pra decidir
   * se os campos do negocio sao reais, nao stale/vazios, antes de
   * depender deles.
   */
  dealId: string | null
}

/**
 * Best-effort, idempotent: NUNCA lança, e nunca recria o evento no
 * Calendar nem reenvia a mensagem do link se o negocio ja tiver
 * `meeting_link` E `meeting_scheduled_at` gravado pra exatamente este
 * `meetingAt` (callers podem chamar de novo em cima de um estado
 * parcial sem medo de duplicar mensagem -- e exatamente o que o job
 * de reconciliacao faz). Um reagendamento de verdade -- `meetingAt`
 * diferente do que esta gravado -- NAO e idempotente: o modelo reemite
 * a tag tanto pra confirmar quanto pra remarcar (ver defaults.ts), e
 * esse caminho precisa passar pelo fluxo normal de novo (novo evento,
 * stage/nota atualizados, link reenviado).
 */
export async function ensureMeetingScheduled(
  db: SupabaseClient,
  args: EnsureMeetingScheduledArgs,
): Promise<EnsureMeetingScheduledResult> {
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
    intentId,
  } = args

  const markIntentResolved = async (): Promise<void> => {
    if (!intentId) return
    await db
      .from('ai_meeting_intents')
      .update({ resolved_at: new Date().toISOString(), resolution: 'completed' })
      .eq('id', intentId)
  }

  const deal = await findOpenDealForContact(db, accountId, contactId, conversationId, configOwnerUserId)
  if (!deal) return { completed: false, dealId: null }

  // Idempotencia: so e "ja completo" quando o negocio ja tem
  // meeting_link E o meeting_scheduled_at gravado e exatamente o
  // mesmo INSTANTE do meetingAt desta chamada. Comparado via
  // Date.parse, nunca como string: o Postgres/PostgREST devolve
  // meeting_scheduled_at como "2026-10-13T13:00:00+00:00", enquanto o
  // meetingAt em tempo real vem do toISOString() do modelo
  // ("2026-10-13T13:00:00.000Z") -- mesmo instante, string diferente,
  // entao "===" bateria sempre false e esta guarda nunca funcionaria
  // de verdade em producao. `meetingAt` null nunca compara igual a
  // nada, entao nunca ha short-circuit nesse caso -- cai no fluxo
  // normal abaixo, igual ao comportamento pre-extracao.
  const { data: existingDeal } = await db
    .from('deals')
    .select('meeting_link, meeting_scheduled_at')
    .eq('id', deal.id)
    .maybeSingle()
  if (
    meetingAt &&
    existingDeal?.meeting_link &&
    existingDeal.meeting_scheduled_at &&
    Date.parse(existingDeal.meeting_scheduled_at as string) === Date.parse(meetingAt)
  ) {
    await markIntentResolved()
    return { completed: true, dealId: deal.id }
  }

  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', deal.pipeline_id)
    .eq('stage_role', 'meeting_scheduled')
    .maybeSingle()
  if (!stage) return { completed: false, dealId: null }

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

  if (completed) {
    await markIntentResolved()
  }

  return { completed, dealId: deal.id }
}
