/**
 * Instagram Graph API client — OAuth (Facebook Login for Business) +
 * the handful of Graph endpoints this integration needs. Plain REST
 * `fetch` calls, no SDK — mirrors src/lib/calendar/google.ts and
 * src/lib/whatsapp/meta-api.ts, the two existing examples of this
 * codebase's house style for talking to an external OAuth provider.
 *
 * Reuses the SAME Meta App as the WhatsApp Cloud API integration
 * (META_APP_ID / META_APP_SECRET) — no second app to register. See
 * docs/superpowers/specs/2026-09-24-instagram-integration-design.md.
 */

const GRAPH_API_VERSION = "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const FACEBOOK_OAUTH_AUTHORIZE_URL = `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`;

// Least privilege for what this feature does: list the user's Pages,
// read their Instagram Business account, and receive comment/DM
// webhooks. No content-publishing or ads scopes.
const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_manage_comments",
  "instagram_manage_messages",
];

export class InstagramGraphError extends Error {
  constructor(message: string, public status: number = 502) {
    super(message);
    this.name = "InstagramGraphError";
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new InstagramGraphError(
      `${name} is not set — the Instagram integration is not configured on this deployment.`,
      500,
    );
  }
  return v;
}

/** Redirect URI Meta sends the user back to after consent. Must match
 *  what's registered in the Meta App's "Valid OAuth Redirect URIs". */
export function instagramRedirectUri(origin: string): string {
  return `${origin}/api/instagram/oauth/callback`;
}

/** Step 1: build the URL that starts the consent flow. */
export function buildInstagramAuthorizeUrl(args: { origin: string; state: string }): string {
  const clientId = requireEnv("META_APP_ID");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: instagramRedirectUri(args.origin),
    response_type: "code",
    scope: SCOPES.join(","),
    state: args.state,
  });
  return `${FACEBOOK_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/** Step 2: exchange the one-time `code` for a short-lived user token. */
export async function exchangeCodeForUserToken(args: {
  code: string;
  origin: string;
}): Promise<{ accessToken: string }> {
  const clientId = requireEnv("META_APP_ID");
  const clientSecret = requireEnv("META_APP_SECRET");
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: instagramRedirectUri(args.origin),
    code: args.code,
  });
  const res = await fetch(`${GRAPH_API_BASE}/oauth/access_token?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new InstagramGraphError(`Instagram token exchange failed: ${res.status} ${body}`, 502);
  }
  const data = (await res.json()) as { access_token: string };
  return { accessToken: data.access_token };
}

/** Step 3: swap the short-lived user token for a long-lived one
 *  (~60 days). Page tokens derived from it (fetchPagesWithInstagram)
 *  inherit this long lifetime. */
export async function exchangeForLongLivedToken(args: {
  shortLivedToken: string;
}): Promise<{ accessToken: string; expiresInSeconds: number | null }> {
  const clientId = requireEnv("META_APP_ID");
  const clientSecret = requireEnv("META_APP_SECRET");
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: clientId,
    client_secret: clientSecret,
    fb_exchange_token: args.shortLivedToken,
  });
  const res = await fetch(`${GRAPH_API_BASE}/oauth/access_token?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new InstagramGraphError(`Instagram long-lived token exchange failed: ${res.status} ${body}`, 502);
  }
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  // Meta's fb_exchange_token response can omit `expires_in` entirely for
  // a long-lived Page-derived token (they often don't expire). Callers
  // must not blindly do `Date.now() + expiresInSeconds * 1000` on this —
  // that produces `Date(NaN)`, which throws on `.toISOString()`. Kept
  // here (closest to the ambiguity's source, Meta's response shape)
  // rather than pushed onto every caller to re-derive the same guard.
  const expiresInSeconds = typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
    ? data.expires_in
    : null;
  return { accessToken: data.access_token, expiresInSeconds };
}

export interface InstagramPage {
  pageId: string;
  pageName: string;
  /** Page access token — this, not the user token, is what every
   *  later Graph call (webhook subscription, comment/message reads)
   *  authenticates with. */
  pageAccessToken: string;
  igUserId: string;
  igUsername: string | null;
}

interface RawPage {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string };
}

/** Step 4: list the user's Facebook Pages, keeping only the ones with
 *  an Instagram Business account linked — a Page without one can't be
 *  used for this integration at all. */
export async function fetchPagesWithInstagram(args: {
  userAccessToken: string;
}): Promise<InstagramPage[]> {
  const params = new URLSearchParams({
    fields: "id,name,access_token,instagram_business_account{id,username}",
    access_token: args.userAccessToken,
  });
  const res = await fetch(`${GRAPH_API_BASE}/me/accounts?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new InstagramGraphError(`Fetching Facebook Pages failed: ${res.status} ${body}`, 502);
  }
  const data = (await res.json()) as { data: RawPage[] };
  return data.data
    .filter((p): p is RawPage & { instagram_business_account: { id: string; username?: string } } =>
      Boolean(p.instagram_business_account?.id),
    )
    .map((p) => ({
      pageId: p.id,
      pageName: p.name,
      pageAccessToken: p.access_token,
      igUserId: p.instagram_business_account.id,
      igUsername: p.instagram_business_account.username ?? null,
    }));
}

/** Step 5: subscribe the Page to the `comments` and `messages` webhook
 *  fields — without this, the App-level webhook never receives
 *  anything for this specific Page/IG account, even once verified. */
export async function subscribePageToInstagramWebhooks(args: {
  pageId: string;
  pageAccessToken: string;
}): Promise<void> {
  const params = new URLSearchParams({
    subscribed_fields: "comments,messages",
    access_token: args.pageAccessToken,
  });
  const res = await fetch(`${GRAPH_API_BASE}/${args.pageId}/subscribed_apps?${params.toString()}`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new InstagramGraphError(`Instagram webhook subscription failed: ${res.status} ${body}`, 502);
  }
}

/** Health check used by the connection-monitoring cron (Task 9): a
 *  lightweight call that fails once the Page token has been revoked
 *  or the Page admin removed FuseHub's access. */
export async function verifyInstagramToken(args: {
  igUserId: string;
  pageAccessToken: string;
}): Promise<boolean> {
  const params = new URLSearchParams({ fields: "id", access_token: args.pageAccessToken });
  const res = await fetch(`${GRAPH_API_BASE}/${args.igUserId}?${params.toString()}`);
  return res.ok;
}

/** Fetch a commenter/DM sender's @username for display — best-effort,
 *  only used to enrich a newly created contact; a failure here must
 *  never block contact creation. */
export async function fetchInstagramUsername(args: {
  igsid: string;
  pageAccessToken: string;
}): Promise<string | null> {
  const params = new URLSearchParams({ fields: "username", access_token: args.pageAccessToken });
  const res = await fetch(`${GRAPH_API_BASE}/${args.igsid}?${params.toString()}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { username?: string };
  return data.username ?? null;
}
