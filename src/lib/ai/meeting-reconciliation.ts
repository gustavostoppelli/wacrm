// ============================================================
// Job diario: revisita toda ai_meeting_intents nao resolvida dos
// ultimos 14 dias e tenta completar o que faltou (negocio -> etapa
// -> calendario -> link), ou -- se o horario da reuniao ja passou
// de forma significativa -- pede pro lead reagendar em vez de criar
// um evento retroativo. Nunca reenvia a mensagem do link duas vezes
// (ensureMeetingScheduled garante isso: so manda quando preenche
// meeting_link agora).
//
// Antes de tudo isso, cada intencao NAO RESOLVIDA e checada contra
// TODAS as intencoes da mesma conversa (resolvidas ou nao). Toda vez
// que o modelo reemite a tag de reuniao -- inclusive num
// reagendamento bem-sucedido depois -- nasce uma linha NOVA em
// ai_meeting_intents (Tasks 3/4). Uma linha MAIS ANTIGA da mesma
// conversa pode continuar nao resolvida (ex.: falhou porque o
// Calendar estava desconectado na hora) mesmo depois que uma
// intencao MAIS NOVA da mesma conversa/negocio ja teve sucesso e ja
// foi marcada `resolution: 'completed'` -- ou seja, essa intencao
// nova e mais correta simplesmente NAO aparece numa query filtrada
// por `resolved_at IS NULL`, porque ela ja foi resolvida. Filtrar o
// "existe uma mais nova?" apenas dentro do conjunto nao-resolvido
// deixa passar exatamente esse caso: a intencao antiga vira um
// "grupo de 1" sozinha, sai ilesa da checagem e e retentada de
// verdade. Como a guarda de idempotencia do ensureMeetingScheduled so
// trava quando o horario bate EXATAMENTE, reprocessar a intencao
// antiga com um horario DIFERENTE do que esta hoje no negocio
// dispararia um reagendamento DE VERDADE -- um novo evento no
// Calendar, o `meeting_scheduled_at` do negocio voltando pro horario
// velho, um novo link mandado -- sobrescrevendo silenciosamente a
// reuniao que o lead ja tinha confirmado num horario diferente. Ou,
// se a intencao antiga estiver a mais de 3h do seu meeting_at, o lead
// recebe um "vamos reagendar?" confuso sobre uma reuniao que na
// verdade ja esta confirmada, só que em outro horario.
//
// Por isso a query abaixo busca duas coisas: as intencoes nao
// resolvidas (candidatas a retry) E, separadamente, pra cada
// conversation_id com candidata, TODAS as intencoes dessa mesma
// conversa (resolvida ou nao) dentro da janela de lookback -- so pra
// comparar created_at. Uma candidata que tenha qualquer intencao mais
// nova (resolvida ou nao) pra mesma conversa e superada direto: nunca
// chama ensureMeetingScheduled, nunca manda mensagem.
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
  if (intents.length === 0) return result

  // Segunda consulta, SEM o filtro de nao-resolvida: pra cada
  // conversation_id que apareceu acima, busca TODAS as intencoes
  // dessa conversa na mesma janela de lookback -- resolvidas ou nao
  // -- so pra comparar created_at. E essa comparacao contra o
  // universo completo (nao so o nao-resolvido) que detecta o caso
  // real do hazard: uma intencao mais nova que ja teve sucesso e ja
  // foi marcada 'completed' em `ensureMeetingScheduled`.
  const conversationIds = Array.from(new Set(intents.map((row) => row.conversation_id as string)))
  const { data: siblings, error: siblingsError } = await db
    .from('ai_meeting_intents')
    .select('id, conversation_id, created_at')
    .in('conversation_id', conversationIds)
    .gte('created_at', lookbackFrom)
  if (siblingsError || !siblings) {
    // Sem conseguir checar se existe irma mais nova (resolvida ou
    // nao), nao e seguro decidir supersede nem retry -- o risco e
    // justamente reagendar por engano uma reuniao que outra intencao
    // ja resolveu corretamente. Conta tudo como pendente e tenta de
    // novo no proximo tick.
    console.error('[meeting-reconciliation] failed to list sibling intents for supersede check:', siblingsError)
    result.stillPending = intents.length
    return result
  }

  const latestCreatedAtByConversation = new Map<string, number>()
  for (const row of siblings) {
    const key = row.conversation_id as string
    const t = new Date(row.created_at as string).getTime()
    const current = latestCreatedAtByConversation.get(key)
    if (current === undefined || t > current) latestCreatedAtByConversation.set(key, t)
  }

  const candidates: Record<string, unknown>[] = []
  for (const row of intents) {
    const rowCreatedAt = new Date(row.created_at as string).getTime()
    const latestCreatedAt = latestCreatedAtByConversation.get(row.conversation_id as string) ?? rowCreatedAt

    if (latestCreatedAt > rowCreatedAt) {
      // Existe uma intencao mais nova (resolvida ou nao) pra mesma
      // conversa -- esta aqui esta obsoleta. Supera direto, sem
      // chamar ensureMeetingScheduled e sem enviar mensagem nenhuma.
      const { error: supersedeError } = await db
        .from('ai_meeting_intents')
        .update({ resolved_at: now.toISOString(), resolution: 'superseded' })
        .eq('id', row.id as string)
      if (supersedeError) {
        console.error('[meeting-reconciliation] failed to supersede stale intent:', row.id, supersedeError)
        result.stillPending += 1
        continue
      }
      result.superseded += 1
      continue
    }

    candidates.push(row)
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
