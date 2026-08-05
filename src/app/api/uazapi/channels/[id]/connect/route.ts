import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { connectInstance } from '@/lib/whatsapp/uazapi-api'

/**
 * POST /api/uazapi/channels/[id]/connect
 *
 * Starts (or restarts) the QR-code connection flow for a UAZAPI
 * channel. Returns a QR code (base64 PNG) or pairing code for the UI
 * to display — the caller then polls GET .../status until UAZAPI
 * reports the phone as connected. Optionally accepts `{ phone }` in
 * the body to request a pairing code instead of a QR image (see
 * UAZAPI's own `/instance/connect` semantics).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await context.params

    const { data: channel, error: fetchError } = await supabase
      .from('whatsapp_config')
      .select('uazapi_base_url, uazapi_instance_token')
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('provider', 'uazapi')
      .maybeSingle()

    if (fetchError || !channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }

    let phone: string | undefined
    try {
      const body = await request.json()
      phone = typeof body?.phone === 'string' ? body.phone : undefined
    } catch {
      // Empty body is fine — defaults to QR code.
    }

    const result = await connectInstance({
      baseUrl: channel.uazapi_base_url,
      instanceToken: decrypt(channel.uazapi_instance_token),
      phone,
    })

    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof Error && !('status' in error)) {
      // A raw UAZAPI fetch error (not one of requireRole's typed
      // errors) — surface it so the UI can show what went wrong
      // instead of a generic 500.
      return NextResponse.json({ error: error.message }, { status: 502 })
    }
    return toErrorResponse(error)
  }
}
