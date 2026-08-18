import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { exchangeCodeForTokens, fetchUserEmail } from '@/lib/calendar/google'

/**
 * GET /api/calendar/google/callback
 *
 * Google redirects here after the admin approves (or denies) consent.
 * Verifies the state nonce against the cookie set by /connect, swaps
 * the code for tokens, and upserts the account's calendar_configs row.
 * Always redirects back into Settings — success/failure communicated
 * via query params the UI reads, never a bare error page.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  // Must resolve the same way /connect did when it built the
  // redirect_uri sent to Google (see getBaseUrl there) — `request.url`
  // alone reflects what Next.js sees *inside* the container behind the
  // reverse proxy (e.g. 0.0.0.0:3000), not the public domain, which
  // breaks both the token exchange (redirect_uri mismatch) and the
  // final redirect back into the app.
  const origin = getBaseUrl(request)
  const settingsUrl = (params: Record<string, string>) =>
    `${origin}/settings?tab=calendar&${new URLSearchParams(params).toString()}`

  const error = url.searchParams.get('error')
  if (error) {
    // User clicked "Cancel" on Google's consent screen, or Google
    // itself rejected the request — either way, no code to exchange.
    return NextResponse.redirect(settingsUrl({ calendar_error: error }))
  }

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) {
    return NextResponse.redirect(
      settingsUrl({ calendar_error: 'missing_code_or_state' }),
    )
  }

  let decoded: { accountId: string; nonce: string }
  try {
    decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'))
  } catch {
    return NextResponse.redirect(settingsUrl({ calendar_error: 'invalid_state' }))
  }

  const cookieNonce = request.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('calendar_oauth_state='))
    ?.split('=')[1]

  if (!cookieNonce || cookieNonce !== decoded.nonce) {
    return NextResponse.redirect(settingsUrl({ calendar_error: 'state_mismatch' }))
  }

  try {
    // Confirms the browser completing this round-trip is still logged
    // in as an admin of the SAME account the flow started from — the
    // state nonce alone proves "this round-trip wasn't forged", this
    // proves "and it's still this account's admin doing it".
    const { accountId, supabase } = await requireRole('admin')
    if (accountId !== decoded.accountId) {
      return NextResponse.redirect(settingsUrl({ calendar_error: 'account_mismatch' }))
    }

    const tokens = await exchangeCodeForTokens({ code, origin })
    const email = await fetchUserEmail(tokens.accessToken)

    const { error: upsertErr } = await supabase.from('calendar_configs').upsert(
      {
        account_id: accountId,
        provider: 'google',
        google_email: email,
        access_token: encrypt(tokens.accessToken),
        refresh_token: encrypt(tokens.refreshToken),
        token_expires_at: tokens.expiresAt.toISOString(),
      },
      { onConflict: 'account_id' },
    )
    if (upsertErr) {
      console.error('[calendar/google/callback] upsert failed:', upsertErr)
      return NextResponse.redirect(settingsUrl({ calendar_error: 'save_failed' }))
    }

    const res = NextResponse.redirect(settingsUrl({ calendar_connected: '1' }))
    res.cookies.delete('calendar_oauth_state')
    return res
  } catch (err) {
    console.error('[calendar/google/callback] error:', err)
    const code =
      err instanceof Error && 'status' in err && (err as { status: number }).status === 401
        ? 'not_logged_in'
        : 'exchange_failed'
    return NextResponse.redirect(settingsUrl({ calendar_error: code }))
  }
}

// Same resolution as src/app/api/calendar/google/connect/route.ts and
// src/app/api/uazapi/channels/route.ts — kept in sync manually, no
// shared helper exists in this codebase yet for this one function.
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
