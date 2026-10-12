// ============================================================
// Job diario: revisita toda ai_meeting_intents nao resolvida dos
// ultimos 14 dias e tenta completar o que faltou (negocio -> etapa
// -> calendario -> link), ou -- se o horario da reuniao ja passou
// de forma significativa -- pede pro lead reagendar em vez de criar
// um evento retroativo. Nunca reenvia a mensagem do link duas vezes
// (ensureMeetingScheduled garante isso: so manda quando preenche
// meeting_link agora).
//
// Antes de tudo isso, agrupa as intencoes nao resolvidas por
// conversation_id. Toda vez que o modelo reemite a tag de reuniao --
// inclusive num reagendamento bem-sucedido depois -- nasce uma linha
// NOVA em ai_meeting_intents (Tasks 3/4). Uma linha MAIS ANTIGA da
// mesma conversa pode continuar nao resolvida (ex.: falhou porque o
// Calendar estava desconectado na hora) mesmo depois que uma
// intencao MAIS NOVA da mesma conversa/negocio ja teve sucesso com
// outro horario. Se este job disputasse (retry) toda intencao nao
// resolvida na ordem de criacao, ele poderia reprocessar essa
// intencao antiga DEPOIS que a nova ja tivesse sido bem-sucedida -- e
// como a guarda de idempotencia do ensureMeetingScheduled so trava
// quando o horario bate EXATAMENTE, reprocessar uma intencao antiga
// com um horario DIFERENTE (mais antigo) do que esta hoje no negocio
// dispararia um reagendamento DE VERDADE, voltando silenciosamente a
// reuniao do lead pro horario antigo e obsoleto. Dois revisores
// independentes (Tasks 3 e 4) flagaram esse risco pra quem quer que
// construisse este job -- por isso o agrupamento abaixo roda ANTES
// do loop de retry/stale-reschedule, e so a intencao mais nova de
// cada conversa chega la. As demais sao marcadas 'superseded' direto,
// sem chamar ensureMeetingScheduled e sem mandar mensagem nenhuma.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { ensureMeetingScheduled } from './meeting-scheduling'
import { loadAiConfig } from './config'
import { engineSendText } from '@/lib/flows/meta-send'

const GRACE_MINUTES_BEFORE_RETRY = 15
const STALE_AFTER_HOURS = 3
const LOOKBACK_DAYS = 14

export interface ReconcileMeetingIntentsResult {
  completed: number
  rescheduled: number
  stillPending: number
  /** Intencoes mais antigas da mesma conversa, superadas por uma
   *  intencao mais nova e marcadas resolvidas sem nenhuma tentativa
   *  de retry/reagendamento (ver nota acima). */
  superseded: number
}

export async function reconcileMeetingIntents(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<ReconcileMeetingIntentsResult> {
  const result: ReconcileMeetingIntentsResult = {
    completed: 0,
    rescheduled: 0,
    stillPending: 0,
    superseded: 0,
  }

  const lookbackFrom = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60_000).toISOString()
  const { data: intents, error } = await db
    .from('ai_meeting_intents')
    .select('id, account_id, conversation_id, contact_id, config_owner_user_id, meeting_at, meeting_email, meeting_note, created_at')
    .is('resolved_at', null)
    .gte('created_at', lookbackFrom)
    .order('created_at', { ascending: true })
  if (error || !intents) {
    console.error('[meeting-reconciliation] failed to list unresolved intents:', error)
    return result
  }

  // Agrupa por conversation_id. Pra cada grupo com mais de uma
  // intencao nao resolvida, mantem so a de created_at mais recente
  // como candidata ao loop normal abaixo; todas as outras sao
  // superadas aqui mesmo.
  const byConversation = new Map<string, Record<string, unknown>[]>()
  for (const row of intents) {
    const key = row.conversation_id as string
    const group = byConversation.get(key)
    if (group) group.push(row)
    else byConversation.set(key, [row])
  }

  const candidates: Record<string, unknown>[] = []
  for (const group of byConversation.values()) {
    if (group.length === 1) {
      candidates.push(group[0])
      continue
    }

    let newest = group[0]
    for (const row of group) {
      if (new Date(row.created_at as string).getTime() > new Date(newest.created_at as string).getTime()) {
        newest = row
      }
    }

    for (const row of group) {
      if (row === newest) continue
      const { error: supersedeError } = await db
        .from('ai_meeting_intents')
        .update({ resolved_at: now.toISOString(), resolution: 'superseded' })
        .eq('id', row.id as string)
      if (supersedeError) {
        console.error('[meeting-reconciliation] failed to supersede stale intent:', row.id, supersedeError)
        continue
      }
      result.superseded += 1
    }

    candidates.push(newest)
  }

  for (const intent of candidates) {
    const createdAt = new Date(intent.created_at as string)
    if (now.getTime() - createdAt.getTime() < GRACE_MINUTES_BEFORE_RETRY * 60_000) {
      continue // pode estar em andamento agora mesmo -- não disputa
    }

    const meetingAt = new Date(intent.meeting_at as string)
    const hoursPast = (now.getTime() - meetingAt.getTime()) / (1000 * 60 * 60)

    if (hoursPast > STALE_AFTER_HOURS) {
      try {
        await engineSendText({
          accountId: intent.account_id as string,
          userId: intent.config_owner_user_id as string,
          conversationId: intent.conversation_id as string,
          contactId: intent.contact_id as string,
          text: 'Oi! Não consegui confirmar certinho o horário da nossa reunião anterior. Podemos reagendar? Me diga um dia e horário bons pra você.',
          aiGenerated: true,
        })
        await db
          .from('ai_meeting_intents')
          .update({ resolved_at: now.toISOString(), resolution: 'stale_rescheduled' })
          .eq('id', intent.id as string)
        result.rescheduled += 1
      } catch (err) {
        console.error('[meeting-reconciliation] stale reschedule message failed:', intent.id, err)
        result.stillPending += 1
      }
      continue
    }

    try {
      const config = await loadAiConfig(db, intent.account_id as string)
      const outcome = await ensureMeetingScheduled(db, {
        accountId: intent.account_id as string,
        conversationId: intent.conversation_id as string,
        contactId: intent.contact_id as string,
        configOwnerUserId: intent.config_owner_user_id as string,
        meetingNote: (intent.meeting_note as string) ?? '',
        meetingAt: intent.meeting_at as string,
        meetingEmail: intent.meeting_email as string,
        meetingEventLabel: config?.meetingEventLabel ?? null,
        businessHoursTimezone: config?.businessHoursTimezone ?? 'America/Sao_Paulo',
        intentId: intent.id as string,
      })
      if (outcome.completed) result.completed += 1
      else result.stillPending += 1
    } catch (err) {
      console.error('[meeting-reconciliation] retry failed:', intent.id, err)
      result.stillPending += 1
    }
  }

  return result
}
