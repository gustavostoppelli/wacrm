import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { createInstance, registerWebhook } from '@/lib/whatsapp/uazapi-api'
import { encrypt } from '@/lib/whatsapp/encryption'

/**
 * POST /api/uazapi/channels
 *
 * Connect a new UAZAPI (QR-code) WhatsApp channel. Bring-your-own
 * server, same model as Meta's BYO access_token: the caller pastes
 * their UAZAPI server's `base_url` + `admin_token` (from their own
 * self-hosted UAZAPI instance or subscription) once. The admin token
 * is used ONLY for this one `/instance/create` call and is never
 * persisted — the resulting per-instance token returned by UAZAPI is
 * what gets stored (encrypted) and used for every later operation.
 *
 * On success this also registers wacrm's webhook URL with the new
 * UAZAPI instance so inbound messages start flowing — see
 * `/api/uazapi/webhook`. Connecting the actual WhatsApp number (QR
 * scan) happens in a separate step — POST .../connect.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const body = await request.json()
    const { base_url, admin_token, name } = body as {
      base_url?: string
      admin_token?: string
      name?: string
    }

    if (!base_url || !admin_token) {
      return NextResponse.json(
        { error: 'base_url and admin_token are required' },
        { status: 400 }
      )
    }

    let instance
    try {
      instance = await createInstance({ baseUrl: base_url, adminToken: admin_token, name })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown UAZAPI error'
      return NextResponse.json({ error: `UAZAPI error: ${message}` }, { status: 400 })
    }
    if (!instance.token || !instance.id) {
      return NextResponse.json(
        { error: 'UAZAPI did not return an instance token — check base_url/admin_token' },
        { status: 502 }
      )
    }

    const webhookSecret = crypto.randomBytes(24).toString('hex')

    const { data: row, error: insertError } = await supabase
      .from('whatsapp_config')
      .insert({
        account_id: accountId,
        user_id: userId,
        provider: 'uazapi',
        name: name || null,
        uazapi_base_url: base_url,
        uazapi_instance_id: instance.id,
        uazapi_instance_token: encrypt(instance.token),
        uazapi_webhook_secret: webhookSecret,
        status: 'disconnected',
      })
      .select('id, name, status')
      .single()

    if (insertError || !row) {
      console.error('[uazapi/channels] insert error:', insertError)
      return NextResponse.json({ error: 'Failed to save channel' }, { status: 500 })
    }

    // Best-effort: a failed webhook registration doesn't block the
    // channel from being created — the "Not receiving messages?" state
    // is surfaced by GET .../status the same way Meta's
    // `last_registration_error` surfaces an unregistered number.
    try {
      const origin = getBaseUrl(request)
      await registerWebhook({
        baseUrl: base_url,
        instanceToken: instance.token,
        webhookUrl: `${origin}/api/uazapi/webhook?ch=${row.id}&key=${webhookSecret}`,
      })
    } catch (err) {
      console.warn('[uazapi/channels] webhook registration failed (non-fatal):', err)
    }

    return NextResponse.json({ success: true, channel: row })
  } catch (error) {
    return toErrorResponse(error)
  }
}

function getBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwardedHost) return `${forwardedProto || 'https'}://${forwardedHost}`
  const host = request.headers.get('host')?.trim()
  const proto = new URL(request.url).protocol.replace(':', '')
  return `${proto}://${host}`
}
