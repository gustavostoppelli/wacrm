// ============================================================
// SDR IA cadence — the part that makes this ONE feature instead of
// "first message only": msg1 → (2+ days, no reply) msg2 → (6+ days,
// no reply) msg3 → (3+ days, no reply) exhausted, with the deal
// moving Novo Lead → Primeiro → Segundo → Terceiro Contato → Lead
// Frio Esgotado along the way. Same state machine the external
// sdr-frio script documents (opensquad/skills/sdr-frio/SKILL.md),
// now native: tags carry the state, the deal's column mirrors it.
//
// A lead that REPLIES at any point leaves the cadence for good —
// from there the AI agent owns the conversation (and the generic
// 4h/next-day nudges of conversation_followups apply, as for any
// other conversation).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText } from '@/lib/automations/meta-send'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { findOrCreateConversationForChannel, loadContactPersonalizationVars } from './send'
import { getSdrIaConfig, type SdrIaConfig } from './config'
import { resolveOrCreateTagId } from './tags'

export const CADENCE_DAYS = {
  /** msg1 sent, no reply → msg2 */
  msg2AfterDays: 2,
  /** msg2 sent, no reply → msg3 */
  msg3AfterDays: 6,
  /** msg3 sent, no reply → exhausted (nothing more is sent) */
  exhaustAfterDays: 3,
} as const

export const CADENCE_TAGS = {
  msg2: 'SDR IA - tentativa 2',
  msg3: 'SDR IA - tentativa 3',
  exhausted: 'SDR IA - esgotado',
} as const

const DAY_MS = 24 * 60 * 60_000

export type CadenceStep = 'msg2' | 'msg3' | 'exhaust'

export interface CadenceState {
  now: Date
  /** When the lead was claimed for msg1 (contacted tag created_at). */
  t1At: Date
  t2At: Date | null
  t3At: Date | null
  exhaustedAt: Date | null
  /** Any customer message since msg1 — the lead is out of the cadence. */
  replied: boolean
}

/** Pure decision: which cadence step (if any) is due for this lead. */
export function dueCadenceStep(s: CadenceState): CadenceStep | null {
  if (s.replied || s.exhaustedAt) return null
  const ageDays = (from: Date) => (s.now.getTime() - from.getTime()) / DAY_MS
  if (s.t3At) return ageDays(s.t3At) >= CADENCE_DAYS.exhaustAfterDays ? 'exhaust' : null
  if (s.t2At) return ageDays(s.t2At) >= CADENCE_DAYS.msg3AfterDays ? 'msg3' : null
  return ageDays(s.t1At) >= CADENCE_DAYS.msg2AfterDays ? 'msg2' : null
}

/** Texts adapted from opensquad/skills/sdr-frio/mensagens-followup. */
export function cadenceText(step: 'msg2' | 'msg3', empresa: string): string {
  const name = empresa.trim()
  if (step === 'msg2') {
    return `Oi de novo! Ainda não consegui falar com ${name || 'vocês'}. Esse número está certo, ou tem outro melhor pra te encontrar?`
  }
  return `Oi${name ? `, ${name}` : ''}! Você sabe quantos pacientes a clínica perde por mês só por falta de uma captação estruturada? Deixo aqui nosso site pra você conhecer: fusegrowth.com.br. Qualquer coisa, me chama.`
}

// ---------- deal columns ----------

const STAGE_RANK: Record<string, number> = {
  'novo lead': 0,
  'primeiro contato': 1,
  'segundo contato': 2,
  'terceiro contato': 3,
  'lead frio esgotado': 4,
}

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

/**
 * Moves the contact's OPEN deals forward along the SDR columns, in the
 * deal's own pipeline. Never moves a deal that is in any other column
 * (a human advanced it: Reunião Agendada, Qualificado…) and never moves
 * backwards. Returns how many deals moved.
 */
export async function moveSdrDealStage(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  targetName: string,
): Promise<number> {
  const targetRank = STAGE_RANK[norm(targetName)]
  if (targetRank === undefined) return 0

  const { data: deals } = await db
    .from('deals')
    .select('id, stage_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'open')
  if (!deals || deals.length === 0) return 0

  const stageIds = [...new Set(deals.map((d) => d.stage_id as string))]
  const { data: curStages } = await db
    .from('pipeline_stages')
    .select('id, name, pipeline_id')
    .in('id', stageIds)
  const curById = new Map((curStages ?? []).map((s) => [s.id as string, s]))

  let moved = 0
  for (const deal of deals) {
    const cur = curById.get(deal.stage_id as string)
    if (!cur) continue
    const curRank = STAGE_RANK[norm(String(cur.name))]
    if (curRank === undefined || curRank >= targetRank) continue

    const { data: pipelineStages } = await db
      .from('pipeline_stages')
      .select('id, name')
      .eq('pipeline_id', cur.pipeline_id as string)
    const target = (pipelineStages ?? []).find((s) => norm(String(s.name)) === norm(targetName))
    if (!target) continue

    const { error } = await db
      .from('deals')
      .update({ stage_id: target.id })
      .eq('id', deal.id as string)
      .eq('account_id', accountId)
    if (!error) moved++
  }
  return moved
}

// ---------- who is an SDR IA lead ----------

/** The account's SDR IA config when this contact was cold-contacted by it, else null. */
export async function getSdrIaConfigIfLead(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<SdrIaConfig | null> {
  const config = await getSdrIaConfig(db, accountId)
  if (!config?.contactedTagId) return null
  const { data } = await db
    .from('contact_tags')
    .select('contact_id')
    .eq('contact_id', contactId)
    .eq('tag_id', config.contactedTagId)
    .maybeSingle()
  return data ? config : null
}

/**
 * Context block for the AI agent's system prompt on a cold-contacted
 * lead. The agent otherwise sees ONLY the chat messages — no CRM notes,
 * city or origin — so without this it cannot tell the conversation was
 * opened by us and falls back to the form-lead script.
 */
export async function buildSdrLeadContextBlock(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<string | null> {
  const config = await getSdrIaConfigIfLead(db, accountId, contactId)
  if (!config) return null

  const vars = await loadContactPersonalizationVars(db, accountId, contactId)
  let local = vars.local ?? ''
  if (!local) {
    const { data: deal } = await db
      .from('deals')
      .select('city')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .not('city', 'is', null)
      .limit(1)
      .maybeSingle()
    local = String(deal?.city ?? '').replace(/\/[A-Za-z]{2}\s*$/, '').trim()
  }

  const lines = [
    '# CONTEXTO DESTE LEAD (fonte oficial, vale mais que qualquer suposição)',
    'Esta conversa é um CONTATO FRIO iniciado por nós (a Fuse), via prospecção ativa. A pessoa NÃO nos procurou, NÃO preencheu formulário e NÃO respondeu a anúncio. Siga a seção "Contato frio iniciado pela Fuse" do prompt.',
    `Nome do contato: ${vars.nome || '(desconhecido)'}`,
    `Clínica/médico abordado: ${vars.empresa || '(desconhecido)'}`,
  ]
  if (vars.especialidade) lines.push(`Especialidade: ${vars.especialidade}`)
  lines.push(
    local && local !== 'sua região'
      ? `[LOCAL] para a mensagem: ${local}`
      : '[LOCAL]: não informado. Apague a frase "Inclusive aqui em [LOCAL]."',
  )
  lines.push(
    'Quem responde pode ser a recepção ou uma assistente, não o médico. O nome do contato acima é do médico/clínica abordado, não de quem está escrevendo.',
  )
  return lines.join('\n')
}

// ---------- the cadence runner ----------

interface TagRow {
  contact_id: string
  created_at: string
}

async function tagRows(db: SupabaseClient, tagId: string): Promise<Map<string, Date>> {
  const { data } = await db
    .from('contact_tags')
    .select('contact_id, created_at')
    .eq('tag_id', tagId)
    .limit(1000)
  return new Map(((data ?? []) as TagRow[]).map((r) => [r.contact_id, new Date(r.created_at)]))
}

export interface CadenceRunArgs {
  accountId: string
  ownerUserId: string
  config: SdrIaConfig
  now: Date
  /** False when the daily cap or send spacing forbids a send this tick:
   *  exhausting silent leads (no send) still runs. */
  sendAllowed: boolean
}

/**
 * One cadence pass for one account. Exhausts leads whose last message
 * went unanswered long enough (no send), and — when allowed — sends the
 * single oldest due msg2/msg3. Returns whether a message was sent.
 */
export async function runSdrIaCadence(db: SupabaseClient, args: CadenceRunArgs): Promise<boolean> {
  const { accountId, ownerUserId, config, now, sendAllowed } = args
  if (!config.contactedTagId || !config.whatsappConfigId) return false

  const t2TagId = await resolveOrCreateTagId(db, accountId, ownerUserId, CADENCE_TAGS.msg2)
  const t3TagId = await resolveOrCreateTagId(db, accountId, ownerUserId, CADENCE_TAGS.msg3)
  const exTagId = await resolveOrCreateTagId(db, accountId, ownerUserId, CADENCE_TAGS.exhausted)

  const [t1, t2, t3, ex] = await Promise.all([
    tagRows(db, config.contactedTagId),
    tagRows(db, t2TagId),
    tagRows(db, t3TagId),
    tagRows(db, exTagId),
  ])

  const due: Array<{ contactId: string; step: CadenceStep; since: Date }> = []
  for (const [contactId, t1At] of t1) {
    if (ex.has(contactId)) continue
    const state = {
      now,
      t1At,
      t2At: t2.get(contactId) ?? null,
      t3At: t3.get(contactId) ?? null,
      exhaustedAt: null,
      replied: false,
    }
    // Cheap pre-filter on the timeline alone; reply/ownership checks
    // (a query each) only run for leads whose step is actually due.
    const step = dueCadenceStep(state)
    if (!step) continue
    due.push({ contactId, step, since: state.t3At ?? state.t2At ?? t1At })
  }
  due.sort((a, b) => a.since.getTime() - b.since.getTime())

  let sent = false
  for (const item of due) {
    if (item.step !== 'exhaust' && (!sendAllowed || sent)) continue

    const { data: conv } = await db
      .from('conversations')
      .select('id, assigned_agent_id, ai_autoreply_disabled')
      .eq('account_id', accountId)
      .eq('contact_id', item.contactId)
      .eq('whatsapp_config_id', config.whatsappConfigId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!conv) continue

    // Any customer message since msg1 means the lead answered: the AI
    // agent owns it from here, the cadence stays out for good.
    const { count: replies } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conv.id as string)
      .eq('sender_type', 'customer')
      .gt('created_at', (t1.get(item.contactId) as Date).toISOString())
    if ((replies ?? 0) > 0) continue
    if (conv.assigned_agent_id || conv.ai_autoreply_disabled) continue

    if (item.step === 'exhaust') {
      await addContactTagIfAbsent(db, { accountId, contactId: item.contactId, tagId: exTagId })
      await moveSdrDealStage(db, accountId, item.contactId, 'Lead Frio Esgotado')
      continue
    }

    const vars = await loadContactPersonalizationVars(db, accountId, item.contactId)
    // Claim first (the unique tag row is the lock), same posture as msg1.
    const claimed = await addContactTagIfAbsent(db, {
      accountId,
      contactId: item.contactId,
      tagId: item.step === 'msg2' ? t2TagId : t3TagId,
    })
    if (!claimed) continue
    try {
      const conversationId = await findOrCreateConversationForChannel(
        db,
        accountId,
        ownerUserId,
        item.contactId,
        config.whatsappConfigId,
      )
      await engineSendText({
        accountId,
        userId: ownerUserId,
        conversationId,
        contactId: item.contactId,
        text: cadenceText(item.step, vars.empresa),
      })
      await moveSdrDealStage(
        db,
        accountId,
        item.contactId,
        item.step === 'msg2' ? 'Segundo Contato' : 'Terceiro Contato',
      )
      sent = true
    } catch (err) {
      console.error('[sdr-ia cadence] send failed:', item.contactId, err)
    }
  }
  return sent
}
