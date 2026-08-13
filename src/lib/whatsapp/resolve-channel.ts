// ============================================================
// Resolve which WhatsApp channel (whatsapp_config row) a send should
// go through.
//
// Before multi-channel support (migration 037), every call site fetched
// "the account's whatsapp_config" directly via
// `.eq('account_id', accountId).single()`. That doesn't work once an
// account can have more than one channel — this module is the single
// place that decides which row to use, so `send-message.ts`,
// `flows/meta-send.ts`, `automations/meta-send.ts`, and
// `broadcast-core.ts` all agree.
//
// `resolveChannelForConversation` is the primary path: a conversation
// created after migration 037 carries `whatsapp_config_id`, so replies
// always go out on the same channel the inbound message arrived on.
// `resolveDefaultChannelForAccount` backs the two cases with no
// conversation to anchor on yet — a business-initiated send from the
// Contact view, and broadcasts — by picking the account's first
// channel. Once multi-channel UI ships (Fase 4) those call sites will
// take an explicit `channelId` instead of relying on this fallback.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { WhatsAppChannel } from '@/lib/whatsapp/provider'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConfigRow = any

/**
 * Decrypt the provider-specific credentials on a `whatsapp_config` row
 * and shape it into the transport-agnostic `WhatsAppChannel` the
 * provider layer expects.
 */
function toChannel(_db: SupabaseClient, row: ConfigRow): WhatsAppChannel {
  if (row.provider === 'uazapi') {
    return {
      id: row.id,
      accountId: row.account_id,
      provider: 'uazapi',
      uazapiBaseUrl: row.uazapi_base_url,
      uazapiInstanceToken: row.uazapi_instance_token
        ? decrypt(row.uazapi_instance_token)
        : undefined,
    }
  }

  // Meta (default).
  return {
    id: row.id,
    accountId: row.account_id,
    provider: 'meta',
    metaPhoneNumberId: row.phone_number_id,
    metaAccessToken: row.access_token ? decrypt(row.access_token) : undefined,
  }
}

/**
 * Resolve the channel a conversation should send through. Falls back
 * to the account's first channel when the conversation predates
 * migration 037 (or was created by a path that hasn't been updated to
 * stamp `whatsapp_config_id` yet) — identical to today's "the account's
 * one config" behaviour for every single-channel account.
 *
 * Returns `null` when the account has no usable channel at all — the
 * caller is responsible for turning that into its own error shape
 * (e.g. `SendMessageError('whatsapp_not_configured', ...)`).
 */
export async function resolveChannelForConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<WhatsAppChannel | null> {
  const { data: conversation } = await db
    .from('conversations')
    .select('whatsapp_config_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (conversation?.whatsapp_config_id) {
    const { data: row } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('id', conversation.whatsapp_config_id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (row) return toChannel(db, row)
    // Referenced channel was deleted (ON DELETE SET NULL hasn't run, or
    // a race) — fall through to the account default rather than fail.
  }

  return resolveDefaultChannelForAccount(db, accountId)
}

/**
 * Resolve "the" channel for an account with no conversation to anchor
 * on — business-initiated sends (Contact detail → Send template) and
 * broadcasts. Picks the oldest channel deterministically. Once Fase 4
 * ships a channel picker in the UI, these call sites will pass an
 * explicit `channelId` instead of relying on this.
 */
export async function resolveDefaultChannelForAccount(
  db: SupabaseClient,
  accountId: string
): Promise<WhatsAppChannel | null> {
  const { data: row } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!row) return null
  return toChannel(db, row)
}
