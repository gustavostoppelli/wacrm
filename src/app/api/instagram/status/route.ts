import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getInstagramStatus, getInstagramConfig } from '@/lib/instagram/config'

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
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase.from('instagram_config').delete().eq('account_id', accountId)
    if (error) {
      console.error('[instagram/status DELETE] failed:', error)
      return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
