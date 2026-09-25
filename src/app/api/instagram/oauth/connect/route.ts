// src/app/api/instagram/oauth/connect/route.ts
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { buildInstagramAuthorizeUrl } from '@/lib/instagram/graph-api'
import crypto from 'crypto'

/**
 * GET /api/instagram/oauth/connect  (admin+)
 *
 * Kicks off Facebook Login for Business. Redirects to Meta; the user
 * lands back on /api/instagram/oauth/callback after authorizing.
 * Follows the exact state/CSRF pattern already used by
 * /api/calendar/google/connect: the account id + a nonce go into a
 * base64url `state` param, and the nonce is mirrored into a
 * short-lived httpOnly cookie so the callback can confirm the redirect
 * wasn't forged.
 */
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('admin')

    const nonce = crypto.randomBytes(16).toString('hex')
    const state = Buffer.from(JSON.stringify({ accountId, nonce })).toString('base64url')

    const url = buildInstagramAuthorizeUrl({ origin: getBaseUrl(request), state })

    const res = NextResponse.redirect(url)
    res.cookies.set('instagram_oauth_state', nonce, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 600,
      path: '/api/instagram/oauth',
    })
    return res
  } catch (err) {
    return toErrorResponse(err)
  }
}

// Same resolution as src/app/api/calendar/google/connect/route.ts and
// src/app/api/uazapi/channels/route.ts — no shared helper exists in
// this codebase yet for this one function, kept in sync manually.
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
