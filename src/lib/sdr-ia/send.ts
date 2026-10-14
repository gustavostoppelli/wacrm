// ============================================================
// SDR IA sending — creates/reuses the conversation on the account's
// CHOSEN channel (sdr_ia_config.whatsapp_config_id), then dispatches
// through the same automations-engine senders every other automated
// message already uses. No new WhatsApp-transport code here.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText, engineSendTemplate } from '@/lib/automations/meta-send'
import { interpolateText } from '@/lib/automations/interpolate'
import { looksLikePhoneNumber } from '@/lib/whatsapp/phone-utils'
import type { SdrIaConfig } from './config'

/**
 * Minimum minutes between two successful sends for the same account
 * (migration 083). Without this, `drainSdrIa` fetched up to the
 * whole remaining `dailyCap` in one cron tick and sent to all of
 * them back-to-back -- e.g. all 5 of the day's messages landing
 * within the same minute, the first tick after business hours open.
 * A burst like that reads more like a bot than a person working
 * through a list, which matters more than usual here: SDR IA's
 * default send mode is free-form text through an unofficial
 * WhatsApp channel, the highest-risk configuration this product
 * supports. Not (yet) configurable per account -- a flat constant
 * until there's a real reason to tune it per client.
 */
export const MIN_MINUTES_BETWEEN_SDR_IA_SENDS = 20

/**
 * True when enough time has passed since `lastSentAt` to allow
 * another send right now (or `lastSentAt` is null -- never sent,
 * nothing to space against). Pure and trivially testable on its
 * own; `drainSdrIa` uses it to skip an account for this cron tick
 * without touching the send/candidate logic at all.
 */
export function isSendSpacingSatisfied(lastSentAt: string | null, now: Date): boolean {
  if (!lastSentAt) return true
  const elapsedMinutes = (now.getTime() - new Date(lastSentAt).getTime()) / 60_000
  return elapsedMinutes >= MIN_MINUTES_BETWEEN_SDR_IA_SENDS
}

/**
 * Finds the existing conversation between this contact and this
 * SPECIFIC channel, or creates one. Unlike
 * `findOrCreateInternalRecipient` (automations/engine.ts), which picks
 * the account's DEFAULT channel, SDR IA must always use the channel
 * configured in the wizard (often a dedicated number, kept separate
 * from the main support/lead number on purpose — see the sdr-frio
 * SKILL.md's "número dedicado" rationale).
 */
export async function findOrCreateConversationForChannel(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  contactId: string,
  channelId: string,
): Promise<string> {
  const { data: existing } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('whatsapp_config_id', channelId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (existing) return existing.id as string

  const { data: created, error } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      whatsapp_config_id: channelId,
    })
    .select('id')
    .single()

  if (error || !created) {
    throw new Error(`Failed to create conversation for contact ${contactId}: ${error?.message}`)
  }
  return created.id as string
}


/** First word of a name ("Maria da Silva" -> "Maria"); '' when empty. */
export function firstNameOf(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? ''
}

/**
 * Turns a custom field's label ("Especialidade", "Cidade de Origem")
 * into the key a `{{vars.x}}` token uses — lowercase, spaces to
 * underscores. Not configurable: whatever the account names the
 * field in Settings → Campos e Tags IS the token, by design — a
 * future client sets this up themselves without needing a developer,
 * which is the whole point (see 2026-10-13 conversation: personali-
 * zation by name/clinic/specialty needs to be self-serve, not
 * something Fuse hardcodes per client).
 */
export function customFieldVarKey(fieldName: string): string {
  return fieldName.trim().toLowerCase().replace(/\s+/g, '_')
}

/**
 * "Bom dia" / "Boa tarde" / "Boa noite" for the moment of the send,
 * in America/Sao_Paulo (same timezone the cron's hours window uses).
 * Exposed as the `{{vars.saudacao}}` token.
 */
export function greetingFor(now: Date): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' }).format(now),
  )
  if (hour < 12) return 'Bom dia'
  if (hour < 18) return 'Boa tarde'
  return 'Boa noite'
}

/**
 * All the `{{vars.*}}` tokens available to personalize a message for
 * this contact: `primeiro_nome`/`nome` (contact name — a name that's
 * really a phone number, from a contact created with just a number,
 * counts as no name), `empresa` (contacts.company), plus one entry
 * per custom field this account has defined in Settings → Campos e
 * Tags that has a value set for this contact (key = customFieldVarKey
 * of the field's label). A built-in name always wins if a custom
 * field happens to share its key. Any lookup problem degrades that
 * piece to '' rather than throwing: personalization data must never
 * block a send.
 */
async function loadContactPersonalizationVars(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<Record<string, string>> {
  const vars: Record<string, string> = { primeiro_nome: '', nome: '', empresa: '', saudacao: greetingFor(new Date()) }

  try {
    const { data } = await db
      .from('contacts')
      .select('name, company')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    const name = String(data?.name ?? '').trim()
    if (name && !looksLikePhoneNumber(name)) {
      vars.nome = name
      vars.primeiro_nome = firstNameOf(name)
    }
    vars.empresa = String(data?.company ?? '').trim()
  } catch {
    // keep the '' defaults above
  }

  try {
    const { data: customValues } = await db
      .from('contact_custom_values')
      .select('value, custom_fields!inner(field_name, account_id)')
      .eq('contact_id', contactId)
      .eq('custom_fields.account_id', accountId)
    for (const row of (customValues ?? []) as Array<{ value: string | null; custom_fields: { field_name: string } | { field_name: string }[] }>) {
      const fieldInfo = Array.isArray(row.custom_fields) ? row.custom_fields[0] : row.custom_fields
      const key = fieldInfo?.field_name ? customFieldVarKey(fieldInfo.field_name) : ''
      if (key && !(key in vars)) vars[key] = String(row.value ?? '').trim()
    }
  } catch {
    // custom fields are best-effort too
  }

  return vars
}

/** Distinct `{{n}}` placeholders in a Meta template body. */
export function countTemplateVariables(body: string): number {
  return new Set(body.match(/\{\{\s*\d+\s*\}\}/g) ?? []).size
}

/**
 * Body parameters for a template. Meta rejects a template send whose number
 * of parameters doesn't match the template, so a first name is passed ONLY
 * when the approved template has exactly one variable ({{1}}). Anything
 * else (no variable, several, template not found) sends with no parameters,
 * exactly as before.
 */
async function templateParamsFor(
  db: SupabaseClient,
  accountId: string,
  templateName: string,
  language: string | null,
  firstName: string,
): Promise<string[] | undefined> {
  try {
    let q = db
      .from('message_templates')
      .select('body_text')
      .eq('account_id', accountId)
      .eq('name', templateName)
    if (language) q = q.eq('language', language)
    const { data } = await q.limit(1).maybeSingle()
    if (!data?.body_text || countTemplateVariables(String(data.body_text)) !== 1) return undefined
    // An empty parameter is rejected by Meta, so fall back to a neutral word.
    return [firstName || 'você']
  } catch {
    return undefined
  }
}

export interface SendSdrIaFirstContactArgs {
  accountId: string
  userId: string
  contactId: string
  conversationId: string
  config: SdrIaConfig
}

export async function sendSdrIaFirstContact(
  db: SupabaseClient,
  args: SendSdrIaFirstContactArgs,
): Promise<{ variantIndex: number | null }> {
  const { accountId, userId, contactId, conversationId, config } = args
  const vars = await loadContactPersonalizationVars(db, accountId, contactId)

  if (config.sendMode === 'template') {
    if (!config.templateName) {
      throw new Error('sdr_ia_config.template_name is required when send_mode is template')
    }
    await engineSendTemplate({
      accountId,
      userId,
      conversationId,
      contactId,
      templateName: config.templateName,
      language: config.templateLanguage ?? undefined,
      params: await templateParamsFor(
        db,
        accountId,
        config.templateName,
        config.templateLanguage,
        vars.primeiro_nome,
      ),
    })
    return { variantIndex: null }
  }

  if (config.messageVariants.length === 0) {
    throw new Error('sdr_ia_config.message_variants is empty for send_mode text')
  }
  const variantIndex = Math.floor(Math.random() * config.messageVariants.length)
  await engineSendText({
    accountId,
    userId,
    conversationId,
    contactId,
    // `{{vars.primeiro_nome}}` / `{{vars.nome}}` / `{{vars.empresa}}`,
    // plus one `{{vars.<campo>}}` per custom field this account has
    // defined (Settings → Campos e Tags) with a value for this contact.
    text: interpolateText(config.messageVariants[variantIndex], { vars }),
  })
  return { variantIndex }
}
