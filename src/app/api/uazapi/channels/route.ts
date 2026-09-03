import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { createInstance, registerWebhook } from '@/lib/whatsapp/uazapi-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * POST /api/uazapi/channels
 *
 * Connect a new UAZAPI (QR-code) WhatsApp channel. `base_url` +
 * `admin_token` are only required the very first time an account adds
 * a channel — that call also saves them (encrypted) onto the account
 * row (migration 059), so every later channel reuses the saved server
 * automatically and the caller only ever needs to pass `name`. This
 * is what lets an admin add a teammate's channel (or let the teammate
 * add their own, since this route is admin-role-gated either way)
 * without ever handing over the UAZAPI admin token itself — see
 * POST/GET /api/uazapi/server for the explicit "configure the server"
 * path.
 *
 * The admin token is used ONLY for this one `/instance/create` call
 * and is never persisted on the channel itself — the resulting
 * per-instance token returned by UAZAPI is what gets stored
 * (encrypted) and used for every later operation on that channel.
 *
 * On success this also registers wacrm's webhook URL with the new
 * UAZAPI instance so inbound messages start flowing — see
 * `/api/uazapi/webhook`. Connecting the actual WhatsApp number (QR
 * scan) happens in a separate step — POST .../connect.
 *
 * Optional `assigned_to` (a user id, must belong to this account)
 * reserves the channel for one teammate — they can then complete the
 * QR pairing themselves (POST/GET .../connect and .../status accept
 * 'agent' role for their own assigned channel, migration 060) without
 * ever needing admin access. Creating the channel itself stays
 * admin-only regardless — that's the intended control point for an
 * account that bills per connected number.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const body = await request.json()
    const { name, assigned_to } = body as { name?: string; assigned_to?: string }
    let { base_url, admin_token } = body as { base_url?: string; admin_token?: string }

    if (assigned_to) {
      // `assigned_to` is an auth.users id (matches whatsapp_config's FK
      // and auth.uid() in the RLS policy) — profiles.user_id, not
      // profiles.id, is the column that holds that value.
      const { data: assignee } = await supabase
        .from('profiles')
        .select('id')
        .eq('user_id', assigned_to)
        .eq('account_id', accountId)
        .maybeSingle()
      if (!assignee) {
        return NextResponse.json(
          { error: 'assigned_to must be a member of this account' },
          { status: 400 },
        )
      }
    }

    if (!base_url?.trim() || !admin_token?.trim()) {
      // Fall back to the account's saved server (migration 059).
      const { data: account } = await supabase
        .from('accounts')
        .select('uazapi_admin_base_url, uazapi_admin_token')
        .eq('id', accountId)
        .maybeSingle()

      if (!account?.uazapi_admin_base_url || !account?.uazapi_admin_token) {
        return NextResponse.json(
          {
            error:
              'No UAZAPI server configured for this account yet. Provide base_url and admin_token once (or use POST /api/uazapi/server).',
          },
          { status: 400 },
        )
      }
      base_url = account.uazapi_admin_base_url
      admin_token = decrypt(account.uazapi_admin_token)
    } else {
      // First time these credentials are seen for this account (or an
      // explicit override) — save them so the next channel skips this.
      await supabase
        .from('accounts')
        .update({
          uazapi_admin_base_url: base_url.trim(),
          uazapi_admin_token: encrypt(admin_token.trim()),
        })
        .eq('id', accountId)
    }

    // At this point both are always set — either they came in valid on
    // the body, or the fallback above returned early when neither the
    // body nor the account had them. Rebinding to non-optional consts
    // avoids sprinkling `!` at every use below.
    const resolvedBaseUrl = base_url!
    const resolvedAdminToken = admin_token!

    let instance
    try {
      instance = await createInstance({ baseUrl: resolvedBaseUrl, adminToken: resolvedAdminToken, name })
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
        assigned_to: assigned_to || null,
        uazapi_base_url: resolvedBaseUrl,
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
        baseUrl: resolvedBaseUrl,
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
