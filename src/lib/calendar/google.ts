import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * Google Calendar integration — OAuth + free/busy + event creation.
 *
 * Plain REST calls against Google's OAuth2 and Calendar v3 endpoints
 * (no `googleapis` SDK — mirrors how the rest of this codebase talks
 * to Meta/UAZAPI: direct `fetch`, small typed wrappers).
 *
 * One Google Cloud OAuth client is registered by the FuseHub operator
 * (GOOGLE_CALENDAR_CLIENT_ID/SECRET below) — every account then just
 * clicks "Connect Google Calendar" and authorizes with their own
 * Google account, like "Sign in with Google" on any SaaS. No account
 * needs its own Google Cloud project.
 */

const GOOGLE_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'

// Read-only + event-write scope. Deliberately not the broader
// `calendar` scope's other surfaces (settings, ACLs) — least privilege
// for what this feature actually does (check free/busy, create events).
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'openid',
  'email',
]

export class CalendarError extends Error {
  constructor(message: string, public status: number = 500) {
    super(message)
    this.name = 'CalendarError'
  }
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    throw new CalendarError(
      `${name} is not set — Google Calendar integration is not configured on this deployment.`,
    )
  }
  return v
}

/** Redirect URI Google sends the user back to after consent. Must be
 *  registered verbatim in the Google Cloud OAuth client. */
export function calendarRedirectUri(origin: string): string {
  return `${origin}/api/calendar/google/callback`
}

/** Step 1: build the URL that starts the consent flow. `state` carries
 *  the account_id (and a CSRF nonce) through the redirect round-trip —
 *  Google echoes it back untouched on the callback. */
export function buildAuthorizeUrl(args: { origin: string; state: string }): string {
  const clientId = requireEnv('GOOGLE_CALENDAR_CLIENT_ID')
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: calendarRedirectUri(args.origin),
    response_type: 'code',
    // offline + consent: without both, Google only issues a
    // refresh_token on the *first-ever* authorization for that user —
    // a re-connect after a revoke would silently come back with no
    // refresh_token otherwise.
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES.join(' '),
    state: args.state,
  })
  return `${GOOGLE_OAUTH_AUTHORIZE_URL}?${params.toString()}`
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope: string
}

/** Step 2: exchange the one-time `code` from the callback for tokens. */
export async function exchangeCodeForTokens(args: {
  code: string
  origin: string
}): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
  const clientId = requireEnv('GOOGLE_CALENDAR_CLIENT_ID')
  const clientSecret = requireEnv('GOOGLE_CALENDAR_CLIENT_SECRET')

  const res = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: args.code,
      grant_type: 'authorization_code',
      redirect_uri: calendarRedirectUri(args.origin),
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new CalendarError(`Google token exchange failed: ${res.status} ${body}`, 502)
  }
  const data = (await res.json()) as TokenResponse
  if (!data.refresh_token) {
    // Happens when the user has a prior grant Google still remembers
    // and `prompt=consent` somehow didn't force a fresh one. Surface
    // clearly rather than saving a config that can silently die in an
    // hour when the access token expires.
    throw new CalendarError(
      'Google did not return a refresh_token. Revoke FuseHub\'s access at myaccount.google.com/permissions and try connecting again.',
      502,
    )
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  }
}

/** Fetch the connected account's email, for display in Settings. */
export async function fetchUserEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return null
  const data = (await res.json()) as { email?: string }
  return data.email ?? null
}

export interface CalendarConfigRow {
  id: string
  access_token: string
  refresh_token: string
  token_expires_at: string
  calendar_id: string
}

/**
 * Resolve a usable (non-expired) access token for the account, storing
 * a fresh encrypted one back to the DB if the stored one is stale.
 * Every calendar operation should go through this rather than reading
 * `access_token` off the row directly.
 */
async function getValidAccessToken(
  db: import('@supabase/supabase-js').SupabaseClient,
  config: CalendarConfigRow,
): Promise<string> {
  const expiresAt = new Date(config.token_expires_at)
  // 60s safety margin so a token that's about to expire mid-request
  // doesn't get used.
  if (expiresAt.getTime() - Date.now() > 60_000) {
    return decrypt(config.access_token)
  }

  const clientId = requireEnv('GOOGLE_CALENDAR_CLIENT_ID')
  const clientSecret = requireEnv('GOOGLE_CALENDAR_CLIENT_SECRET')
  const refreshToken = decrypt(config.refresh_token)

  const res = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new CalendarError(
      `Google token refresh failed (the connection may have been revoked): ${res.status} ${body}`,
      502,
    )
  }
  const data = (await res.json()) as TokenResponse
  const newExpiresAt = new Date(Date.now() + data.expires_in * 1000)

  await db
    .from('calendar_configs')
    .update({
      access_token: encrypt(data.access_token),
      token_expires_at: newExpiresAt.toISOString(),
    })
    .eq('id', config.id)

  return data.access_token
}

export interface BusyInterval {
  start: string // ISO 8601
  end: string
}

/** Query Google's free/busy API for the given window. Returns the
 *  busy intervals only — callers subtract these from candidate slots
 *  themselves (freeBusy doesn't accept a list of candidates, just a
 *  window). */
export async function getBusyIntervals(
  db: import('@supabase/supabase-js').SupabaseClient,
  config: CalendarConfigRow,
  window: { timeMin: Date; timeMax: Date },
): Promise<BusyInterval[]> {
  const accessToken = await getValidAccessToken(db, config)
  const res = await fetch(`${GOOGLE_CALENDAR_API}/freeBusy`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      timeMin: window.timeMin.toISOString(),
      timeMax: window.timeMax.toISOString(),
      items: [{ id: config.calendar_id }],
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new CalendarError(`Google freeBusy query failed: ${res.status} ${body}`, 502)
  }
  const data = await res.json()
  return data.calendars?.[config.calendar_id]?.busy ?? []
}

export interface CreateEventArgs {
  summary: string
  description?: string
  start: Date
  end: Date
  attendeeEmail?: string
  /** IANA timezone (e.g. 'America/Sao_Paulo'). Google requires one
   *  alongside dateTime for the event to render in the right local
   *  time for both organizer and attendee. */
  timeZone: string
}

export interface CreatedEvent {
  id: string
  htmlLink: string
  meetLink: string | null
}

/** Create a real event on the connected calendar, with a Google Meet
 *  link (mirrors what the site form's Apps Script already does via
 *  `Calendar.Events.insert` — same outcome, different auth model). */
export async function createEvent(
  db: import('@supabase/supabase-js').SupabaseClient,
  config: CalendarConfigRow,
  args: CreateEventArgs,
): Promise<CreatedEvent> {
  const accessToken = await getValidAccessToken(db, config)
  const res = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(config.calendar_id)}/events?conferenceDataVersion=1&sendUpdates=all`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        summary: args.summary,
        description: args.description,
        start: { dateTime: args.start.toISOString(), timeZone: args.timeZone },
        end: { dateTime: args.end.toISOString(), timeZone: args.timeZone },
        attendees: args.attendeeEmail ? [{ email: args.attendeeEmail }] : undefined,
        conferenceData: {
          createRequest: {
            requestId: `fusehub-${Date.now()}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      }),
    },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new CalendarError(`Google event creation failed: ${res.status} ${body}`, 502)
  }
  const data = await res.json()
  return {
    id: data.id,
    htmlLink: data.htmlLink,
    meetLink: data.hangoutLink ?? null,
  }
}

/**
 * Convenience wrapper for callers that only have an `accountId` (the
 * AI Agent's auto-reply flow, in particular) — loads the account's
 * calendar_configs row and creates the event, or returns `null` if
 * the account hasn't connected Google Calendar. Never throws for
 * "not connected"; does throw (via createEvent/getValidAccessToken)
 * for a real API failure with a connection that exists.
 */
export async function createEventForAccount(
  db: import('@supabase/supabase-js').SupabaseClient,
  accountId: string,
  args: CreateEventArgs,
): Promise<CreatedEvent | null> {
  const { data: config } = await db
    .from('calendar_configs')
    .select('id, access_token, refresh_token, token_expires_at, calendar_id')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!config) return null
  return createEvent(db, config as CalendarConfigRow, args)
}
