import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getInstagramStatus, getInstagramConfig } from '@/lib/instagram/config'
import { supabaseAdmin } from '@/lib/instagram/admin-client'

/**
 * GET /api/instagram/status
 *
 * Whether this account can access the Instagram integration
 * (accounts.instagram_enabled) plus its current connection, if any.
 * The Settings → Instagram panel uses this to decide between the
 * locked view and the real connect/connected UI — checked
 * server-side, same reasoning as /api/sdr-ia/status.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const enabled = await getInstagramStatus(supabase, accountId)
    const config = enabled ? await getInstagramConfig(supabase, accountId) : null
    return NextResponse.json({ enabled, config })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/**
 * DELETE /api/instagram/status  (admin+)
 *
 * Disconnects the account's Instagram connection. Does not attempt to
 * revoke the token on Meta's side (there is no dedicated Graph API
 * call for a Page-issued token) — deleting the row is sufficient:
 * this integration only ever reads config off this table, so with the
 * row gone the webhook simply logs "no instagram_config" and discards
 * future events for that ig_user_id (Task 7).
 */
export async function DELETE() {
  try {
    const { accountId } = await requireRole('admin')
    // Service-role client, not the user-session one: migration 075
    // grants instagram_config only a SELECT RLS policy, so the
    // user-session client's delete is silently filtered to 0 rows by
    // RLS with no error — the route would report success while the
    // connection (and its webhook dispatch) stays live. Scoped to
    // accountId, same as the callback route's writes.
    const { error } = await supabaseAdmin().from('instagram_config').delete().eq('account_id', accountId)
    if (error) {
      console.error('[instagram/status DELETE] failed:', error)
      return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
