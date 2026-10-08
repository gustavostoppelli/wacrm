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
 * The contact's full name and first name for personalising the first
 * contact. A name that is really a phone number (contacts created from just
 * a number get the number as their name) counts as "no name". Any lookup
 * problem degrades to "no name": a missing name must never block a send.
 */
async function loadContactNames(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<{ fullName: string; firstName: string }> {
  try {
    const { data } = await db
      .from('contacts')
      .select('name')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    const name = String(data?.name ?? '').trim()
    if (!name || looksLikePhoneNumber(name)) return { fullName: '', firstName: '' }
    return { fullName: name, firstName: firstNameOf(name) }
  } catch {
    return { fullName: '', firstName: '' }
  }
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
  const { fullName, firstName } = await loadContactNames(db, accountId, contactId)

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
        firstName,
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
    // `{{vars.primeiro_nome}}` / `{{vars.nome}}` in a variant become the contact's names.
    text: interpolateText(config.messageVariants[variantIndex], {
      vars: { primeiro_nome: firstName, nome: fullName },
    }),
  })
  return { variantIndex }
}
