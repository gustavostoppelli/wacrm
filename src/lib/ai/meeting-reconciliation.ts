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
import { scheduleMeetingReminders } from './auto-reply'
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
  /** Intencoes fechadas sem nenhuma tentativa de retry e SEM nenhuma
   *  mensagem mandada pro lead, porque a causa era permanente pra essa
   *  conta -- `ensureMeetingScheduled` devolveu `no_stage` (pipeline
   *  sem etapa `meeting_scheduled` configurada) ou `no_calendar`
   *  (conta nunca conectou o Google Calendar) -- ou porque um humano
   *  ja fechou (ganhou/perdeu) o negocio deste contato depois que a
   *  intencao foi gravada (ver nota do Important #2 abaixo). Nenhum
   *  desses casos se resolve sozinho retentando amanha, e mandar o
   *  "vamos reagendar?" seria uma mensagem errada pro lead. */
  notApplicable: number
}

/**
 * Negocio aberto do contato, so com os campos de reuniao -- usado pra
 * checar, ANTES de mandar o "vamos reagendar?", se a reuniao desta
 * intencao ja foi de fato confirmada (o negocio ja tem `meeting_link`
 * pra exatamente este `meeting_at`) e so a propria linha de
 * ai_meeting_intents que nunca foi marcada resolvida -- ex.: um crash
 * entre o evento ser criado no Calendar e o update que resolve a
 * intencao rodar. Mandar "vamos reagendar?" nesse caso seria uma
 * mensagem falsa pro lead, que ja tem a reuniao confirmada.
 */
async function findMatchingMeetingLinkOnOpenDeal(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; meetingAt: string },
): Promise<boolean> {
  const { data: deal } = await db
    .from('deals')
    .select('meeting_link, meeting_scheduled_at')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!deal?.meeting_link || !deal.meeting_scheduled_at) return false
  return Date.parse(deal.meeting_scheduled_at as string) === Date.parse(args.meetingAt)
}

/**
 * True quando o contato NAO tem negocio aberto, mas tem pelo menos um
 * negocio ja fechado (ganho ou perdido) -- aproximacao deliberada do
 * caso real do Important #2 (um humano fechou o negocio original
 * enquanto a intencao ainda estava pendente, ex.: esperando o Calendar
 * reconectar). O ideal seria so contar como "fechado DEPOIS desta
 * intencao" comparando datas, mas essa versao mais simples cobre o
 * mesmo risco pratico -- retentar nunca deveria criar um negocio NOVO
 * "WhatsApp Direto" do zero pra ressuscitar a presenca desse lead no
 * pipeline quando ja existe uma decisao humana tomada sobre ele.
 */
async function contactHasOnlyClosedDeals(
  db: SupabaseClient,
  args: { accountId: string; contactId: string },
): Promise<boolean> {
  const { data: openDeal } = await db
    .from('deals')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .eq('status', 'open')
    .limit(1)
    .maybeSingle()
  if (openDeal) return false

  const { data: closedDeal } = await db
    .from('deals')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .neq('status', 'open')
    .limit(1)
    .maybeSingle()
  return !!closedDeal
}

/**
 * Read-only version of the two permanent-gap checks `ensureMeetingScheduled`
 * itself discovers (as a side effect of actually trying): no Calendar
 * connected for the account, or -- when the contact already has an
 * open deal -- that deal's pipeline has no `meeting_scheduled` stage
 * configured. Used by the STALE branch below, which deliberately never
 * calls `ensureMeetingScheduled` (that would mean creating a backdated
 * Calendar event) but still needs to know, before sending the "let's
 * reschedule?" message, whether this account can never complete the
 * booking at all.
 *
 * Deliberately does NOT call `findOpenDealForContact` (which CREATES a
 * deal when none exists) -- a missing deal isn't a permanent block by
 * itself (one could still be created on a future retry), so this only
 * checks the stage when an open deal already exists. No open deal at
 * all just means this check can't rule anything out -- falls through
 * to `false` (not provably permanent), same as before this fix.
 */
async function isPermanentlyUnschedulable(
  db: SupabaseClient,
  args: { accountId: string; contactId: string },
): Promise<boolean> {
  const { data: calendarConfig } = await db
    .from('calendar_configs')
    .select('id')
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (!calendarConfig) return true

  const { data: openDeal } = await db
    .from('deals')
    .select('pipeline_id')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!openDeal) return false

  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', openDeal.pipeline_id as string)
    .eq('stage_role', 'meeting_scheduled')
    .maybeSingle()
  return !stage
}

async function markIntentNotApplicable(
  db: SupabaseClient,
  intentId: string,
  now: Date,
): Promise<void> {
  const { error } = await db
    .from('ai_meeting_intents')
    .update({ resolved_at: now.toISOString(), resolution: 'not_applicable' })
    .eq('id', intentId)
  if (error) {
    console.error('[meeting-reconciliation] failed to close not-applicable intent:', intentId, error)
  }
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
    notApplicable: 0,
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

    // Important #2: a human may have already closed out (won/lost) the
    // contact's deal while this intent sat unresolved (e.g. waiting on
    // Calendar to reconnect). This must run BEFORE the stale/normal
    // branch below, not only inside the normal-retry branch: a
    // same-day booking made in the morning is routinely already past
    // the 3h stale threshold by the time the job first sees it (the
    // cron runs once a day), so the stale branch is a common path, not
    // a rare one -- and it used to send its "let's reschedule?"
    // message without ever checking this. Retrying in that situation
    // would create a brand-new "WhatsApp Direto" deal via
    // findOpenDealForContact and move it into the meeting-scheduled
    // stage -- resurrecting a closed lead's pipeline presence nobody
    // asked for; sending the stale message would be telling a lead a
    // human already closed out to reschedule a meeting nobody is
    // going to take.
    try {
      const closedByHuman = await contactHasOnlyClosedDeals(db, {
        accountId: intent.account_id as string,
        contactId: intent.contact_id as string,
      })
      if (closedByHuman) {
        await markIntentNotApplicable(db, intent.id as string, now)
        result.notApplicable += 1
        continue
      }
    } catch (err) {
      console.error('[meeting-reconciliation] closed-deal check failed:', intent.id, err)
      result.stillPending += 1
      continue
    }

    const meetingAt = new Date(intent.meeting_at as string)
    const hoursPast = (now.getTime() - meetingAt.getTime()) / (1000 * 60 * 60)

    if (hoursPast > STALE_AFTER_HOURS) {
      try {
        // Safety check before telling the lead their meeting might be
        // off: the deal may already have THIS exact meeting confirmed
        // (meeting_link + meeting_scheduled_at matching this intent's
        // meeting_at) -- e.g. a crash between the Calendar event being
        // created and the resolve-update running on ensureMeetingScheduled's
        // side. Telling an already-confirmed lead to reschedule would
        // be actively wrong, so this closes the intent as completed
        // and sends nothing instead.
        const alreadyConfirmed = await findMatchingMeetingLinkOnOpenDeal(db, {
          accountId: intent.account_id as string,
          contactId: intent.contact_id as string,
          meetingAt: intent.meeting_at as string,
        })
        if (alreadyConfirmed) {
          const { error: resolveError } = await db
            .from('ai_meeting_intents')
            .update({ resolved_at: now.toISOString(), resolution: 'completed' })
            .eq('id', intent.id as string)
          if (resolveError) {
            console.error('[meeting-reconciliation] failed to resolve already-confirmed intent:', intent.id, resolveError)
            result.stillPending += 1
          } else {
            result.completed += 1
          }
          continue
        }

        // Same permanent-gap check the normal retry branch gets for
        // free from ensureMeetingScheduled's own `no_stage`/`no_calendar`
        // reasons -- this branch never calls ensureMeetingScheduled
        // (that would mean creating a backdated Calendar event for a
        // meeting time already hours in the past), so it needs its own
        // read-only check for the same two permanent, account-level
        // gaps. Without this, an account with no Calendar connected or
        // no meeting_scheduled stage would get the false "let's
        // reschedule?" the very first time its intent is checked --
        // often the SAME day it was created, since the cron only runs
        // once daily and a same-day afternoon booking is frequently
        // already >3h stale by the next run.
        const permanentlyBlocked = await isPermanentlyUnschedulable(db, {
          accountId: intent.account_id as string,
          contactId: intent.contact_id as string,
        })
        if (permanentlyBlocked) {
          await markIntentNotApplicable(db, intent.id as string, now)
          result.notApplicable += 1
          continue
        }

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

      if (outcome.reason === 'no_stage' || outcome.reason === 'no_calendar') {
        // Permanent, account-level gap (no meeting_scheduled stage
        // configured, or Calendar never connected) -- retrying
        // tomorrow will never fix this, and eventually hitting the
        // stale-after-3h branch above would send the lead a confusing
        // "let's reschedule?" about a flow this account was never
        // going to complete. Close it out now instead.
        await markIntentNotApplicable(db, intent.id as string, now)
        result.notApplicable += 1
      } else if (outcome.completed) {
        result.completed += 1

        // Important #1: only the live wrapper (recordMeetingScheduled
        // in auto-reply.ts) used to schedule attendance reminders. A
        // booking completed only by this retroactive retry never got
        // them, even though the meeting is just as real. Mirror the
        // live wrapper's gating exactly: needs the config flag on AND
        // a real dealId from this call.
        if (config && config.meetingRemindersEnabled && outcome.dealId) {
          await scheduleMeetingReminders(db, {
            accountId: intent.account_id as string,
            dealId: outcome.dealId,
            conversationId: intent.conversation_id as string,
            contactId: intent.contact_id as string,
            configOwnerUserId: intent.config_owner_user_id as string,
            meetingAt: new Date(intent.meeting_at as string),
            config,
          })
        }
      } else {
        // no_deal / event_creation_failed / no_meeting_details --
        // plausibly transient, keep retrying on future runs.
        result.stillPending += 1
      }
    } catch (err) {
      console.error('[meeting-reconciliation] retry failed:', intent.id, err)
      result.stillPending += 1
    }
  }

  return result
}
