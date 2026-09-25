// src/lib/instagram/config.ts
// ============================================================
// Instagram per-account config (migration 075).
//
// Two independent gates, same split as SDR IA (src/lib/sdr-ia/config.ts):
//   - accounts.instagram_enabled — whether this account may connect
//     Instagram at all (visibility gate; set via SQL by Fuse today).
//   - instagram_config row existing with status='connected' — whether
//     the account actually has a live connection right now.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export interface InstagramConfig {
  accountId: string
  pageId: string
  igUserId: string
  igUsername: string | null
  status: 'connected' | 'disconnected'
  connectedAt: string
  /** Null when the webhook subscription call at connect time failed —
   *  the connection is saved, but no events will ever arrive for it
   *  until the account disconnects and reconnects. */
  webhookSubscribedAt: string | null
}

export async function getInstagramStatus(db: SupabaseClient, accountId: string): Promise<boolean> {
  const { data } = await db
    .from('accounts')
    .select('instagram_enabled')
    .eq('id', accountId)
    .maybeSingle()
  return !!data?.instagram_enabled
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromRow(row: any): InstagramConfig {
  return {
    accountId: row.account_id,
    pageId: row.page_id,
    igUserId: row.ig_user_id,
    igUsername: row.ig_username,
    status: row.status,
    connectedAt: row.connected_at,
    webhookSubscribedAt: row.webhook_subscribed_at ?? null,
  }
}

export async function getInstagramConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<InstagramConfig | null> {
  const { data } = await db
    .from('instagram_config')
    .select('account_id, page_id, ig_user_id, ig_username, status, connected_at, webhook_subscribed_at')
    .eq('account_id', accountId)
    .maybeSingle()
  return data ? fromRow(data) : null
}
