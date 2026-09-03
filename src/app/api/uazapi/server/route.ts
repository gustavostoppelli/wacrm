import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'

/**
 * GET /api/uazapi/server
 *
 * Whether this account already has a saved UAZAPI server (migration
 * 059). Never returns the admin token — only enough for the UI to
 * decide whether "Add channel" needs to ask for credentials or can
 * skip straight to a name + QR code.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const { data, error } = await supabase
      .from('accounts')
      .select('uazapi_admin_base_url, uazapi_admin_token')
      .eq('id', accountId)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: 'Failed to load server config' }, { status: 500 })
    }

    return NextResponse.json({
      configured: !!(data?.uazapi_admin_base_url && data?.uazapi_admin_token),
      base_url: data?.uazapi_admin_base_url || null,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/**
 * POST /api/uazapi/server
 *
 * Saves (or replaces) the account's UAZAPI server credentials.
 * Every "Add channel" call after this reuses them automatically — see
 * POST /api/uazapi/channels — so a new teammate connecting their own
 * number never needs to see this admin token.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const body = await request.json()
    const { base_url, admin_token } = body as { base_url?: string; admin_token?: string }
    if (!base_url?.trim() || !admin_token?.trim()) {
      return NextResponse.json(
        { error: 'base_url and admin_token are required' },
        { status: 400 },
      )
    }

    const { error } = await supabase
      .from('accounts')
      .update({
        uazapi_admin_base_url: base_url.trim(),
        uazapi_admin_token: encrypt(admin_token.trim()),
      })
      .eq('id', accountId)

    if (error) {
      return NextResponse.json({ error: 'Failed to save server config' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
