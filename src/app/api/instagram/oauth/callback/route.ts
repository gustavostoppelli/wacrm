// src/app/api/instagram/oauth/callback/route.ts
import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  exchangeCodeForUserToken,
  exchangeForLongLivedToken,
  fetchPagesWithInstagram,
  subscribePageToInstagramWebhooks,
} from '@/lib/instagram/graph-api'
import { getInstagramStatus } from '@/lib/instagram/config'
import { supabaseAdmin } from '@/lib/instagram/admin-client'

/**
 * GET /api/instagram/oauth/callback
 *
 * Meta redirects here after the admin approves (or denies) consent.
 * Verifies the state nonce against the cookie set by /connect, swaps
 * the code for a long-lived Page token, and upserts instagram_config.
 * Always redirects back into Settings — success/failure communicated
 * via query params, same pattern as the Google Calendar callback.
 *
 * If the account has more than one eligible Page, this connects the
 * FIRST one Meta returns and reports how many were available via
 * `instagram_pages_found` — picking among several Pages is out of
 * scope for this phase (see design spec, "fora de escopo").
 */
export async function GET(request: Request) {
  const origin = getBaseUrl(request)
  const settingsUrl = (params: Record<string, string>) =>
    `${origin}/settings?tab=instagram&${new URLSearchParams(params).toString()}`

  const url = new URL(request.url)
  const error = url.searchParams.get('error')
  if (error) {
    return NextResponse.redirect(settingsUrl({ instagram_error: error }))
  }

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) {
    return NextResponse.redirect(settingsUrl({ instagram_error: 'missing_code_or_state' }))
  }

  let decoded: { accountId: string; nonce: string }
  try {
    decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'))
  } catch {
    return NextResponse.redirect(settingsUrl({ instagram_error: 'invalid_state' }))
  }

  const cookieNonce = request.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('instagram_oauth_state='))
    ?.split('=')[1]

  if (!cookieNonce || cookieNonce !== decoded.nonce) {
    return NextResponse.redirect(settingsUrl({ instagram_error: 'state_mismatch' }))
  }

  try {
    const { accountId, supabase, userId } = await requireRole('admin')
    if (accountId !== decoded.accountId) {
      return NextResponse.redirect(settingsUrl({ instagram_error: 'account_mismatch' }))
    }

    // Re-check the visibility gate here too, not just at /connect — a
    // user could reach this callback directly (e.g. a stale bookmark,
    // or a race with Fuse flipping the flag mid-flow) even if they
    // never got a valid "Conectar" link (finding IMPORTANT 7).
    const enabled = await getInstagramStatus(supabase, accountId)
    if (!enabled) {
      return NextResponse.redirect(settingsUrl({ instagram_error: 'not_enabled' }))
    }

    const { accessToken: shortLivedToken } = await exchangeCodeForUserToken({ code, origin })
    const { accessToken: longLivedUserToken, expiresInSeconds } = await exchangeForLongLivedToken({
      shortLivedToken,
    })
    const pages = await fetchPagesWithInstagram({ userAccessToken: longLivedUserToken })

    if (pages.length === 0) {
      return NextResponse.redirect(settingsUrl({ instagram_error: 'no_instagram_business_account' }))
    }

    const chosen = pages[0]

    // Writes below use the service-role client, not the user-session
    // `supabase` from requireRole: migration 075 only grants
    // instagram_config a SELECT RLS policy, so the SSR client's
    // upsert/update/delete are silently blocked (or 42501) under RLS.
    // `requireRole('admin')` above already did the authorization check
    // — every write here is still scoped to `accountId` so a bug here
    // can never touch another tenant's row.
    const db = supabaseAdmin()

    const { error: upsertErr } = await db.from('instagram_config').upsert(
      {
        account_id: accountId,
        user_id: userId,
        page_id: chosen.pageId,
        ig_user_id: chosen.igUserId,
        ig_username: chosen.igUsername,
        access_token: encrypt(chosen.pageAccessToken),
        // expiresInSeconds is null when Meta's response omitted
        // expires_in (common for a long-lived Page-derived token,
        // which often doesn't expire) — store null rather than
        // computing Date(NaN), which throws on toISOString().
        token_expires_at:
          expiresInSeconds != null ? new Date(Date.now() + expiresInSeconds * 1000).toISOString() : null,
        status: 'connected',
        connected_at: new Date().toISOString(),
      },
      { onConflict: 'account_id' },
    )
    if (upsertErr) {
      console.error('[instagram/oauth/callback] upsert failed:', upsertErr)
      return NextResponse.redirect(settingsUrl({ instagram_error: 'save_failed' }))
    }

    try {
      await subscribePageToInstagramWebhooks({ pageId: chosen.pageId, pageAccessToken: chosen.pageAccessToken })
      await db
        .from('instagram_config')
        .update({ webhook_subscribed_at: new Date().toISOString() })
        .eq('account_id', accountId)
    } catch (err) {
      // Non-fatal: the connection is saved either way. The Settings
      // panel (Task 8/IMPORTANT 9) surfaces "webhook not subscribed
      // yet" if this column stays null, same spirit as WhatsApp's
      // last_registration_error.
      console.warn('[instagram/oauth/callback] webhook subscription failed (non-fatal):', err)
    }

    const res = NextResponse.redirect(
      settingsUrl({
        instagram_connected: '1',
        instagram_pages_found: String(pages.length),
      }),
    )
    res.cookies.delete('instagram_oauth_state')
    return res
  } catch (err) {
    console.error('[instagram/oauth/callback] error:', err)
    const code =
      err instanceof Error && 'status' in err && (err as { status: number }).status === 401
        ? 'not_logged_in'
        : 'exchange_failed'
    return NextResponse.redirect(settingsUrl({ instagram_error: code }))
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
