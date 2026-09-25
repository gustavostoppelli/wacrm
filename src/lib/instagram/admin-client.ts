import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for Instagram config writes.
// Mirrors src/lib/automations/admin-client.ts and src/lib/ai/admin-client.ts.
//
// `instagram_config` only has a SELECT RLS policy (migration 075) — the
// OAuth callback, the disconnect route and the webhook handler all need
// to write it (or read across accounts, for the webhook), which the
// user-session SSR client can never do under RLS. Every caller must
// scope its own writes with `.eq('account_id', accountId)` — this
// client has no RLS to fall back on.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
