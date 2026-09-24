// ============================================================
// SDR IA sending — creates/reuses the conversation on the account's
// CHOSEN channel (sdr_ia_config.whatsapp_config_id), then dispatches
// through the same automations-engine senders every other automated
// message already uses. No new WhatsApp-transport code here.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText, engineSendTemplate } from '@/lib/automations/meta-send'
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
    text: config.messageVariants[variantIndex],
  })
  return { variantIndex }
}
