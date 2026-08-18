import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/calendar/google
 *
 * Any member may read connection status. Tokens are never returned —
 * only whether a connection exists and which email it's connected to,
 * for display in Settings.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('calendar_configs')
      .select('google_email, calendar_id, created_at')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[calendar/google GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load calendar status' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ connected: false })
    return NextResponse.json({ connected: true, ...data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/calendar/google  (admin+)
 *
 * Disconnects — deletes the stored (encrypted) tokens. Does not revoke
 * the grant on Google's side; the admin can also do that at
 * myaccount.google.com/permissions if they want to fully cut access.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase
      .from('calendar_configs')
      .delete()
      .eq('account_id', accountId)
    if (error) {
      console.error('[calendar/google DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
