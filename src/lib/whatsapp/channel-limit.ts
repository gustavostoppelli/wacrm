// ============================================================
// Per-account WhatsApp channel limit (migration 067).
//
// Shared between every channel-creation path (UAZAPI, Meta) so the
// cap can't be bypassed by using one provider instead of another.
// `accounts.whatsapp_channel_limit` defaults to 1 for every new
// account of the sellable product; raising a specific account's limit
// is a plain SQL UPDATE (see the migration's comment), never a code
// change or something exposed in the customer's own Settings UI.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ChannelLimitResult {
  ok: boolean
  limit: number
  count: number
}

export async function checkWhatsappChannelLimit(
  db: SupabaseClient,
  accountId: string,
): Promise<ChannelLimitResult> {
  const [accountRes, countRes] = await Promise.all([
    db.from('accounts').select('whatsapp_channel_limit').eq('id', accountId).maybeSingle(),
    db.from('whatsapp_config').select('id', { count: 'exact', head: true }).eq('account_id', accountId),
  ])

  const limit = (accountRes.data?.whatsapp_channel_limit as number | undefined) ?? 1
  const count = countRes.count ?? 0

  return { ok: count < limit, limit, count }
}
