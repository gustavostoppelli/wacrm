import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { buildAuthorizeUrl } from '@/lib/calendar/google'
import crypto from 'crypto'

/**
 * GET /api/calendar/google/connect  (admin+)
 *
 * Kicks off the Google OAuth consent flow. Redirects the browser to
 * Google; the user lands back on /api/calendar/google/callback after
 * authorizing.
 *
 * `state` carries this account's id through the round-trip, and its
 * nonce is mirrored into a short-lived httpOnly cookie so the callback
 * can verify the redirect wasn't forged (classic OAuth login-mixup
 * CSRF: without this, an attacker could complete their own consent
 * flow and trick a logged-in admin into visiting the resulting
 * callback URL, connecting the attacker's calendar to the victim's
 * account).
 */
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('admin')

    const nonce = crypto.randomBytes(16).toString('hex')
    const state = Buffer.from(JSON.stringify({ accountId, nonce })).toString(
      'base64url',
    )

    const url = buildAuthorizeUrl({ origin: getBaseUrl(request), state })

    const res = NextResponse.redirect(url)
    res.cookies.set('calendar_oauth_state', nonce, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 600, // 10 min — plenty for a consent screen, short enough to limit replay
      path: '/api/calendar/google',
    })
    return res
  } catch (err) {
    return toErrorResponse(err)
  }
}

// Mirrors the resolution used by src/app/api/uazapi/channels/route.ts —
// no shared helper exists in this codebase for it yet, small enough to
// duplicate rather than introduce a new shared module for one line of
// logic.
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
