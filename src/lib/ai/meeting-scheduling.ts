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

/**
 * Por que uma tentativa terminou como terminou -- a distincao que
 * importa pra quem chama isso retroativamente (o job de reconciliacao
 * diaria): algumas razoes sao permanentes pra essa conta (retentar
 * amanha nunca vai resolver) e outras sao genuinamente transitorias
 * (vale a pena tentar de novo no proximo dia).
 *
 *  - `completed`: escreveu tudo (ou ja estava tudo escrito, idempotente).
 *  - `no_deal`: `findOpenDealForContact` nao achou nem conseguiu criar
 *    um negocio -- pode ser uma falha transitoria de banco, vale retry.
 *  - `no_stage`: ha negocio, mas o pipeline dele nao tem etapa
 *    `stage_role = 'meeting_scheduled'` configurada -- isso e um
 *    problema de configuracao da conta, PERMANENTE ate um humano
 *    configurar a etapa. Retentar todo dia nunca resolve sozinho.
 *  - `no_calendar`: a conta nao tem Google Calendar conectado
 *    (`createEventForAccount` devolveu `null` -- sem linha em
 *    `calendar_configs`). Tambem PERMANENTE ate alguem reconectar.
 *  - `event_creation_failed`: o Calendar ESTA conectado, mas criar
 *    este evento especifico falhou (erro de rede, API fora do ar).
 *    Isso sim e plausivelmente transitorio -- vale retry.
 */
export type EnsureMeetingScheduledReason =
  | 'completed'
  | 'no_deal'
  | 'no_stage'
  | 'no_calendar'
  | 'event_creation_failed'
  /** `meetingAt` ou `meetingEmail` nao vieram desta chamada -- nunca
   *  chegou a tentar criar o evento. So acontece na chamada em tempo
   *  real (auto-reply.ts pode chamar isso mesmo sem hora/e-mail
   *  ainda); o job de reconciliacao nunca passa por aqui, porque so
   *  grava uma ai_meeting_intents quando os dois ja vieram presentes. */
  | 'no_meeting_details'

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
  /** Ver `EnsureMeetingScheduledReason` -- distingue falha permanente
   *  (conta nunca vai completar isso) de transitoria (vale retentar). */
  reason: EnsureMeetingScheduledReason
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
    const { error } = await db
      .from('ai_meeting_intents')
      .update({ resolved_at: new Date().toISOString(), resolution: 'completed' })
      .eq('id', intentId)
    if (error) {
      console.error('[meeting-scheduling] ai_meeting_intents resolve update failed:', error)
    }
  }

  const deal = await findOpenDealForContact(db, accountId, contactId, conversationId, configOwnerUserId)
  if (!deal) return { completed: false, dealId: null, reason: 'no_deal' }

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
    return { completed: true, dealId: deal.id, reason: 'completed' }
  }

  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', deal.pipeline_id)
    .eq('stage_role', 'meeting_scheduled')
    .maybeSingle()
  if (!stage) return { completed: false, dealId: null, reason: 'no_stage' }

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
  // Tracked separately from "event came back null" -- `createEventForAccount`
  // returns `null` (no throw) when the account simply has no
  // calendar_configs row (never connected Google Calendar), but THROWS
  // when a connection exists and the API call itself failed (network
  // blip, Google down, token revoked mid-call). Those two outcomes
  // need different `reason`s below: one is a permanent account-config
  // gap, the other is plausibly transient and worth retrying.
  let calendarAttemptThrew = false
  let event: Awaited<ReturnType<typeof createEventForAccount>> = null
  if (meetingAt && meetingEmail) {
    // "<label configurado> - <cliente/clínica>" -- the label comes
    // from ai_configs.meeting_event_label (Settings -> Agentes de IA),
    // not accounts.name: that column usually holds the owner's
    // personal name, not a brand name, so it isn't a reliable source
    // for this. Falls back to a generic "Diagnóstico" when unset.
    const summary = `${meetingEventLabel || 'Diagnóstico'} - ${deal.title}`

    try {
      event = await createEventForAccount(db, accountId, {
        summary,
        start: new Date(meetingAt),
        end: new Date(new Date(meetingAt).getTime() + 30 * 60_000),
        attendeeEmail: meetingEmail,
        timeZone: businessHoursTimezone,
      })
    } catch (err) {
      console.error('[meeting-scheduling] createEventForAccount failed:', err)
      calendarAttemptThrew = true
    }
    if (event) {
      update.meeting_link = event.meetLink
      update.calendar_event_id = event.id
      completed = true
    }
  }

  let reason: EnsureMeetingScheduledReason
  if (completed) {
    reason = 'completed'
  } else if (calendarAttemptThrew) {
    reason = 'event_creation_failed'
  } else if (meetingAt && meetingEmail) {
    // Attempted, resolved cleanly to `null` -- no calendar_configs row
    // for this account at all.
    reason = 'no_calendar'
  } else {
    reason = 'no_meeting_details'
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

  return { completed, dealId: deal.id, reason }
}
