# Integração com Instagram (gatilhos de automação) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a FuseHub account connect its Instagram Business account via official Meta OAuth (no password ever touches wacrm) and use "comment on a post" / "Direct message received" as triggers in the existing automations engine — no Instagram reply, no unified inbox.

**Architecture:** Reuses the Meta App already configured for WhatsApp (`META_APP_ID`/`META_APP_SECRET`), following this codebase's existing Google Calendar OAuth pattern (`src/app/api/calendar/google/{connect,callback}`) almost verbatim, swapped to Meta's endpoints. A new `instagram_config` table (mirrors `whatsapp_config`) stores one encrypted long-lived Page token per account. A single Meta-level webhook resolves the account from the incoming `ig_user_id`, finds-or-creates a phone-less contact, and calls the existing `runAutomationsForTrigger()` — zero changes to how automations execute, only two new `trigger_type` values recognized by `triggerMatches()`.

**Tech Stack:** Next.js App Router API routes, Supabase/Postgres (RLS via `is_account_member`), Meta Graph API v21.0 (plain `fetch`, no SDK — matches `meta-api.ts`/`google.ts` style), Vitest.

## Global Constraints

- No login/password anywhere for Instagram — OAuth only, exactly like the spec requires (`docs/superpowers/specs/2026-09-24-instagram-integration-design.md`, decision 4).
- Reuse `META_APP_ID`/`META_APP_SECRET` — do not create a second Meta App.
- One Instagram connection per `account_id` (spec doesn't call for multiple; `instagram_config.account_id` gets a UNIQUE constraint).
- No trigger for "new follower" (spec decision, already agreed with the user — not officially available).
- No automation action sends anything back through Instagram in this phase.
- `accounts.instagram_enabled` defaults to `false`; only flipped by direct SQL, same convention as `accounts.sdr_ia_enabled` (migration 070).
- Every new table gets RLS via `is_account_member(account_id)`, matching every other tenant-scoped table in this repo.
- Secrets (`access_token`) stored with `encrypt()`/`decrypt()` from `src/lib/whatsapp/encryption.ts` — no new encryption scheme.
- Webhook signature verification reuses `verifyMetaWebhookSignature()` from `src/lib/whatsapp/webhook-signature.ts` unchanged.
- OAuth state/CSRF follows the exact cookie-nonce + base64url-JSON pattern already used by `src/app/api/calendar/google/connect/route.ts` — no new signing scheme invented.

---

### Task 1: Database migration — `instagram_config`, `accounts.instagram_enabled`, nullable `contacts.phone`

**Files:**
- Create: `supabase/migrations/075_instagram_integration.sql`
- Modify: `src/types/index.ts` (Contact type, new InstagramConfig-adjacent types)

**Interfaces:**
- Produces: table `instagram_config` (columns below), column `accounts.instagram_enabled`, `contacts.phone` now nullable, `contacts.instagram_id` / `contacts.instagram_username` columns, unique partial index `idx_contacts_account_instagram_id`, table `instagram_webhook_events` (dedupe).

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- 075_instagram_integration.sql — Instagram as an automation trigger
--
-- See docs/superpowers/specs/2026-09-24-instagram-integration-design.md
-- for the full design. Summary: connect an Instagram Business account
-- via official Meta OAuth (reusing the same Meta App as WhatsApp), and
-- let "comment on a post" / "Direct message received" fire the
-- existing automations engine. No reply capability, no unified inbox.
-- ============================================================

-- 1) Visibility gate — same one-column-per-account-setting convention
--    as accounts.sdr_ia_enabled (migration 070).
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS instagram_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN accounts.instagram_enabled IS
  'Whether this account can connect Instagram as an automation trigger source. Default false for the sellable product baseline; flipped per-account via direct SQL, same as accounts.sdr_ia_enabled.';

-- 2) The connection itself. One row per account (UNIQUE(account_id)) —
--    this phase supports a single connected Instagram Business account
--    per account, not a multi-channel list like whatsapp_config.
CREATE TABLE IF NOT EXISTS instagram_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  ig_user_id TEXT NOT NULL UNIQUE,
  ig_username TEXT,
  -- Long-lived PAGE access token (not the user token) — encrypted at
  -- rest via src/lib/whatsapp/encryption.ts, same AES-256-GCM
  -- convention as whatsapp_config.access_token.
  access_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected')),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  webhook_subscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instagram_config_ig_user_id ON instagram_config(ig_user_id);

ALTER TABLE instagram_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instagram_config_select ON instagram_config;
CREATE POLICY instagram_config_select ON instagram_config
  FOR SELECT USING (is_account_member(account_id));
-- No client-side write policies — only the OAuth callback and the
-- disconnect route (both service-role) ever write this table, same
-- convention as conversation_reactivations (migration 073).

-- 3) Contacts can now exist without a phone number — an Instagram
--    commenter/DM sender never has one. `phone_normalized` (migration
--    022) is a GENERATED column over `phone`; NULL phone yields NULL
--    phone_normalized, which the existing partial unique index
--    (`WHERE phone_normalized <> ''`) already excludes — no conflict.
ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS instagram_id TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS instagram_username TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_instagram_id
  ON contacts (account_id, instagram_id)
  WHERE instagram_id IS NOT NULL;

COMMENT ON COLUMN contacts.instagram_id IS
  'Instagram-scoped ID (IGSID) of the commenter/DM sender this contact was created from. NULL for contacts that never touched the Instagram integration.';

-- 4) Webhook event dedupe — Meta redelivers "at least once". Insert
--    the event key before processing; a unique-violation means it was
--    already handled, so the caller skips it. Same idea as the Asaas
--    webhook's subscription_id uniqueness.
CREATE TABLE IF NOT EXISTS instagram_webhook_events (
  event_key TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- [ ] **Step 2: Update the `Contact` type**

In `src/types/index.ts`, find `export interface Contact {` (around line 99) and change:

```typescript
export interface Contact {
  id: string;
  user_id: string;
  account_id: string;
  phone: string;
```

to:

```typescript
export interface Contact {
  id: string;
  user_id: string;
  account_id: string;
  /** Nullable since migration 075 — an Instagram-only contact (created
   *  from a comment or Direct message) has no phone number. */
  phone: string | null;
  /** Instagram-scoped ID (IGSID) this contact was created from, if any
   *  (migration 075). */
  instagram_id?: string | null;
  instagram_username?: string | null;
```

- [ ] **Step 3: Run the migration against the local/dev database**

Ask the user to run the SQL in `supabase/migrations/075_instagram_integration.sql` in the Supabase SQL editor (same manual-apply flow used for every migration this session), or run it via whatever local migration runner the project uses if one is configured. Confirm success before continuing — the next step's `tsc` check doesn't need the live database, but every later task's manual testing does.

- [ ] **Step 4: Run the type checker and fix fallout from the nullable `phone`**

Run: `npx tsc --noEmit`

`contacts.phone` changing from `string` to `string | null` will surface every call site that assumed it was always a string. For each error TypeScript reports:
- If it's a template string or a function whose parameter accepts `string | null | undefined` already (e.g. `normalizePhone`, `sanitizePhoneForMeta` in `src/lib/whatsapp/phone-utils.ts` — both already guard `if (!phone) return ''`), the error is just a type mismatch — pass `contact.phone ?? ''` instead of `contact.phone`.
- If it's a DB insert/update building a row that requires `phone: string`, change that local type to `phone: string | null` to match.
- Do not add runtime behavior changes beyond null-safety — this step is a mechanical type fix, not a feature change.

Repeat `npx tsc --noEmit` until it reports zero errors.

- [ ] **Step 5: Run the full test suite to confirm nothing broke**

Run: `npx vitest run`
Expected: same pass count as before this task (check `git stash` diff if unsure), no new failures. The 5 pre-existing `date-utils.test.ts` failures are unrelated and expected.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/075_instagram_integration.sql src/types/index.ts
git commit -m "Adiciona migracao base da integracao com Instagram (config, flag, contato sem telefone)"
```

---

### Task 2: Instagram Graph API client

**Files:**
- Create: `src/lib/instagram/graph-api.ts`
- Test: `src/lib/instagram/graph-api.test.ts`

**Interfaces:**
- Consumes: `process.env.META_APP_ID`, `process.env.META_APP_SECRET` (already required by the rest of the codebase — see `src/lib/whatsapp/webhook-signature.ts` and `src/lib/whatsapp/template-header-handle.ts`).
- Produces:
  - `instagramRedirectUri(origin: string): string`
  - `buildInstagramAuthorizeUrl(args: { origin: string; state: string }): string`
  - `class InstagramGraphError extends Error { status: number }`
  - `exchangeCodeForUserToken(args: { code: string; origin: string }): Promise<{ accessToken: string }>`
  - `exchangeForLongLivedToken(args: { shortLivedToken: string }): Promise<{ accessToken: string; expiresInSeconds: number }>`
  - `interface InstagramPage { pageId: string; pageName: string; pageAccessToken: string; igUserId: string; igUsername: string | null }`
  - `fetchPagesWithInstagram(args: { userAccessToken: string }): Promise<InstagramPage[]>`
  - `subscribePageToInstagramWebhooks(args: { pageId: string; pageAccessToken: string }): Promise<void>`
  - `verifyInstagramToken(args: { igUserId: string; pageAccessToken: string }): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/instagram/graph-api.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildInstagramAuthorizeUrl,
  instagramRedirectUri,
  exchangeCodeForUserToken,
  exchangeForLongLivedToken,
  fetchPagesWithInstagram,
  subscribePageToInstagramWebhooks,
  verifyInstagramToken,
  InstagramGraphError,
} from "./graph-api";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, META_APP_ID: "app123", META_APP_SECRET: "secret123" };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("instagramRedirectUri", () => {
  it("builds the callback URL under /api/instagram/oauth/callback", () => {
    expect(instagramRedirectUri("https://fusehub.fusegrowth.com.br")).toBe(
      "https://fusehub.fusegrowth.com.br/api/instagram/oauth/callback",
    );
  });
});

describe("buildInstagramAuthorizeUrl", () => {
  it("includes the app id, redirect_uri, required scopes, and state", () => {
    const url = buildInstagramAuthorizeUrl({ origin: "https://x.test", state: "abc123" });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://www.facebook.com");
    expect(parsed.searchParams.get("client_id")).toBe("app123");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://x.test/api/instagram/oauth/callback");
    expect(parsed.searchParams.get("state")).toBe("abc123");
    const scopes = parsed.searchParams.get("scope")?.split(",") ?? [];
    expect(scopes).toEqual(
      expect.arrayContaining([
        "pages_show_list",
        "pages_read_engagement",
        "instagram_basic",
        "instagram_manage_comments",
        "instagram_manage_messages",
      ]),
    );
  });
});

describe("exchangeCodeForUserToken", () => {
  it("returns the access token on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "short-token", token_type: "bearer", expires_in: 3600 }),
      }),
    );
    const result = await exchangeCodeForUserToken({ code: "the-code", origin: "https://x.test" });
    expect(result.accessToken).toBe("short-token");
  });

  it("throws InstagramGraphError on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad code" }),
    );
    await expect(
      exchangeCodeForUserToken({ code: "bad", origin: "https://x.test" }),
    ).rejects.toThrow(InstagramGraphError);
  });
});

describe("exchangeForLongLivedToken", () => {
  it("returns the long-lived token and its expiry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "long-token", token_type: "bearer", expires_in: 5184000 }),
      }),
    );
    const result = await exchangeForLongLivedToken({ shortLivedToken: "short-token" });
    expect(result.accessToken).toBe("long-token");
    expect(result.expiresInSeconds).toBe(5184000);
  });
});

describe("fetchPagesWithInstagram", () => {
  it("returns only pages that have an instagram_business_account linked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "page-1",
              name: "Clinica X",
              access_token: "page-token-1",
              instagram_business_account: { id: "ig-1", username: "clinicax" },
            },
            { id: "page-2", name: "No IG here", access_token: "page-token-2" },
          ],
        }),
      }),
    );
    const pages = await fetchPagesWithInstagram({ userAccessToken: "long-token" });
    expect(pages).toEqual([
      {
        pageId: "page-1",
        pageName: "Clinica X",
        pageAccessToken: "page-token-1",
        igUserId: "ig-1",
        igUsername: "clinicax",
      },
    ]);
  });
});

describe("subscribePageToInstagramWebhooks", () => {
  it("posts to /{pageId}/subscribed_apps with the page token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal("fetch", fetchMock);
    await subscribePageToInstagramWebhooks({ pageId: "page-1", pageAccessToken: "page-token-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/page-1/subscribed_apps");
    expect(String(url)).toContain("access_token=page-token-1");
    expect(init.method).toBe("POST");
  });

  it("throws InstagramGraphError on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "no permission" }),
    );
    await expect(
      subscribePageToInstagramWebhooks({ pageId: "page-1", pageAccessToken: "bad" }),
    ).rejects.toThrow(InstagramGraphError);
  });
});

describe("verifyInstagramToken", () => {
  it("returns true when the Graph API accepts the token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "ig-1" }) }));
    expect(await verifyInstagramToken({ igUserId: "ig-1", pageAccessToken: "tok" })).toBe(true);
  });

  it("returns false when the Graph API rejects the token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "expired" }));
    expect(await verifyInstagramToken({ igUserId: "ig-1", pageAccessToken: "tok" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/instagram/graph-api.test.ts`
Expected: FAIL — `./graph-api` does not exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/instagram/graph-api.ts
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
}): Promise<{ accessToken: string; expiresInSeconds: number }> {
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
  const data = (await res.json()) as { access_token: string; expires_in: number };
  return { accessToken: data.access_token, expiresInSeconds: data.expires_in };
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/instagram/graph-api.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add src/lib/instagram/graph-api.ts src/lib/instagram/graph-api.test.ts
git commit -m "Adiciona cliente da Instagram Graph API (OAuth + paginas + assinatura de webhook)"
```

---

### Task 3: Instagram config data layer

**Files:**
- Create: `src/lib/instagram/config.ts`

**Interfaces:**
- Consumes: `SupabaseClient` from `@supabase/supabase-js`.
- Produces:
  - `interface InstagramConfig { accountId: string; pageId: string; igUserId: string; igUsername: string | null; status: 'connected' | 'disconnected'; connectedAt: string }`
  - `getInstagramStatus(db: SupabaseClient, accountId: string): Promise<boolean>` (reads `accounts.instagram_enabled`)
  - `getInstagramConfig(db: SupabaseClient, accountId: string): Promise<InstagramConfig | null>`

- [ ] **Step 1: Write the implementation** (thin data-access module, mirrors `src/lib/sdr-ia/config.ts`'s `getSdrIaStatus` — no test file needed for this one, same as its model, since it's a pure passthrough over Supabase covered end-to-end by the route tests in later tasks)

```typescript
// src/lib/instagram/config.ts
// ============================================================
// Instagram per-account config (migration 075).
//
// Two independent gates, same split as SDR IA (src/lib/sdr-ia/config.ts):
//   - accounts.instagram_enabled — whether this account may connect
//     Instagram at all (visibility gate; set via SQL by Fuse today).
//   - instagram_config row existing with status='connected' — whether
//     the account actually has a live connection right now.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export interface InstagramConfig {
  accountId: string
  pageId: string
  igUserId: string
  igUsername: string | null
  status: 'connected' | 'disconnected'
  connectedAt: string
}

export async function getInstagramStatus(db: SupabaseClient, accountId: string): Promise<boolean> {
  const { data } = await db
    .from('accounts')
    .select('instagram_enabled')
    .eq('id', accountId)
    .maybeSingle()
  return !!data?.instagram_enabled
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromRow(row: any): InstagramConfig {
  return {
    accountId: row.account_id,
    pageId: row.page_id,
    igUserId: row.ig_user_id,
    igUsername: row.ig_username,
    status: row.status,
    connectedAt: row.connected_at,
  }
}

export async function getInstagramConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<InstagramConfig | null> {
  const { data } = await db
    .from('instagram_config')
    .select('account_id, page_id, ig_user_id, ig_username, status, connected_at')
    .eq('account_id', accountId)
    .maybeSingle()
  return data ? fromRow(data) : null
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/instagram/config.ts
git commit -m "Adiciona camada de dados da configuracao do Instagram"
```

---

### Task 4: OAuth connect + callback routes

**Files:**
- Create: `src/app/api/instagram/oauth/connect/route.ts`
- Create: `src/app/api/instagram/oauth/callback/route.ts`

**Interfaces:**
- Consumes: `requireRole` / `toErrorResponse` from `@/lib/auth/account`; `buildInstagramAuthorizeUrl`, `exchangeCodeForUserToken`, `exchangeForLongLivedToken`, `fetchPagesWithInstagram`, `subscribePageToInstagramWebhooks` from `@/lib/instagram/graph-api` (Task 2); `encrypt` from `@/lib/whatsapp/encryption`.
- Produces: `GET /api/instagram/oauth/connect` (redirect), `GET /api/instagram/oauth/callback` (redirect back into `/settings?tab=instagram`).

- [ ] **Step 1: Write `connect/route.ts`**

```typescript
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
```

- [ ] **Step 2: Write `callback/route.ts`**

```typescript
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

    const { accessToken: shortLivedToken } = await exchangeCodeForUserToken({ code, origin })
    const { accessToken: longLivedUserToken, expiresInSeconds } = await exchangeForLongLivedToken({
      shortLivedToken,
    })
    const pages = await fetchPagesWithInstagram({ userAccessToken: longLivedUserToken })

    if (pages.length === 0) {
      return NextResponse.redirect(settingsUrl({ instagram_error: 'no_instagram_business_account' }))
    }

    const chosen = pages[0]

    const { error: upsertErr } = await supabase.from('instagram_config').upsert(
      {
        account_id: accountId,
        user_id: userId,
        page_id: chosen.pageId,
        ig_user_id: chosen.igUserId,
        ig_username: chosen.igUsername,
        access_token: encrypt(chosen.pageAccessToken),
        token_expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
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
      await supabase
        .from('instagram_config')
        .update({ webhook_subscribed_at: new Date().toISOString() })
        .eq('account_id', accountId)
    } catch (err) {
      // Non-fatal: the connection is saved either way. The Settings
      // panel (Task 8) surfaces "webhook not subscribed yet" if this
      // column stays null, same spirit as WhatsApp's
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
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual verification (documented for whoever tests this against real Meta credentials)**

Automated testing of a live 3-party OAuth redirect isn't practical here — record in the task's PR/commit description that `GET /api/instagram/oauth/connect` needs a manual end-to-end click-through against a real Meta App + a Business-linked Instagram account before this is considered done, matching how the WhatsApp/Calendar OAuth flows in this repo were verified.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/instagram/oauth/connect/route.ts src/app/api/instagram/oauth/callback/route.ts
git commit -m "Adiciona fluxo OAuth de conexao do Instagram (connect + callback)"
```

---

### Task 5: Instagram-only contact find-or-create

**Files:**
- Create: `src/lib/contacts/instagram-dedupe.ts`
- Test: `src/lib/contacts/instagram-dedupe.test.ts`

**Interfaces:**
- Consumes: `SupabaseClient`.
- Produces: `findOrCreateInstagramContact(db: SupabaseClient, accountId: string, args: { igsid: string; username: string | null }): Promise<{ id: string }>`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/contacts/instagram-dedupe.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { findOrCreateInstagramContact } from "./instagram-dedupe";

function makeDb(overrides: { existing?: { id: string } | null; insertResult?: { id: string } } = {}) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: overrides.existing ?? null, error: null });
  const eqChain = { maybeSingle };
  const select = vi.fn(() => ({
    eq: vi.fn(() => ({ eq: vi.fn(() => eqChain) })),
  }));
  const insertSingle = vi.fn().mockResolvedValue({
    data: overrides.insertResult ?? { id: "new-contact-1" },
    error: null,
  });
  const insertSelect = vi.fn(() => ({ single: insertSingle }));
  const insert = vi.fn(() => ({ select: insertSelect }));
  return {
    from: vi.fn(() => ({ select, insert })),
    _spies: { select, insert, maybeSingle, insertSingle },
  };
}

describe("findOrCreateInstagramContact", () => {
  it("returns the existing contact when one matches instagram_id", async () => {
    const db = makeDb({ existing: { id: "existing-1" } });
    const result = await findOrCreateInstagramContact(db as never, "acc-1", {
      igsid: "igsid-123",
      username: "joana",
    });
    expect(result).toEqual({ id: "existing-1" });
    expect(db._spies.insert).not.toHaveBeenCalled();
  });

  it("creates a phone-less contact when none matches", async () => {
    const db = makeDb({ existing: null, insertResult: { id: "new-contact-1" } });
    const result = await findOrCreateInstagramContact(db as never, "acc-1", {
      igsid: "igsid-456",
      username: "pedro",
    });
    expect(result).toEqual({ id: "new-contact-1" });
    expect(db._spies.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acc-1",
        instagram_id: "igsid-456",
        instagram_username: "pedro",
        phone: null,
        name: "pedro",
      }),
    );
  });

  it("falls back to the igsid as the name when no username is available", async () => {
    const db = makeDb({ existing: null, insertResult: { id: "new-contact-2" } });
    await findOrCreateInstagramContact(db as never, "acc-1", { igsid: "igsid-789", username: null });
    expect(db._spies.insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: "igsid-789", instagram_username: null }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/contacts/instagram-dedupe.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/contacts/instagram-dedupe.ts
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Find-or-create a contact from an Instagram event (comment or DM),
 * keyed by the Instagram-scoped id (IGSID) rather than phone — mirrors
 * findExistingContact (src/lib/contacts/dedupe.ts), which keys off
 * phone instead. Never has a phone number: the two dedupe paths are
 * deliberately separate rather than unified, since they use different
 * uniqueness keys (migration 075's idx_contacts_account_instagram_id
 * vs migration 022's idx_contacts_account_phone_normalized).
 */
export async function findOrCreateInstagramContact(
  db: SupabaseClient,
  accountId: string,
  args: { igsid: string; username: string | null },
): Promise<{ id: string }> {
  const { data: existing } = await db
    .from("contacts")
    .select("id")
    .eq("account_id", accountId)
    .eq("instagram_id", args.igsid)
    .maybeSingle();

  if (existing) return { id: existing.id as string };

  const { data: created, error } = await db
    .from("contacts")
    .insert({
      account_id: accountId,
      phone: null,
      instagram_id: args.igsid,
      instagram_username: args.username,
      name: args.username ?? args.igsid,
    })
    .select("id")
    .single();

  if (error || !created) {
    throw new Error(`Failed to create Instagram contact ${args.igsid}: ${error?.message}`);
  }
  return { id: created.id as string };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/contacts/instagram-dedupe.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/contacts/instagram-dedupe.ts src/lib/contacts/instagram-dedupe.test.ts
git commit -m "Adiciona find-or-create de contato a partir de evento do Instagram"
```

---

### Task 6: New automation trigger types (types, engine, validation)

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/automations/engine.ts`
- Modify: `src/lib/automations/validate.ts`
- Modify: `src/lib/automations/trigger-meta.ts`
- Modify: `src/lib/automations/engine.test.ts`

**Interfaces:**
- Produces: `AutomationTriggerType` gains `'instagram_comment_received' | 'instagram_dm_received'`; `triggerMatches()` handles both; `TRIGGER_META` has entries for both.

- [ ] **Step 1: Add the trigger types to `src/types/index.ts`**

Find the `AutomationTriggerType` union (around line 531) and add the two new values before the closing `;`:

```typescript
export type AutomationTriggerType =
  | 'new_message_received'
  | 'first_inbound_message'
  | 'keyword_match'
  | 'new_contact_created'
  | 'conversation_assigned'
  | 'tag_added'
  | 'time_based'
  | 'interactive_reply'
  | 'webhook_received'
  /** Someone commented on a connected Instagram post (migration 075).
   *  Optionally scoped by keyword via trigger_config, same shape as
   *  KeywordMatchTriggerConfig — but unlike keyword_match, an empty/
   *  absent keywords list matches EVERY comment (see triggerMatches). */
  | 'instagram_comment_received'
  /** Someone sent a Direct message to the connected Instagram account
   *  (migration 075). No filter config in this phase. */
  | 'instagram_dm_received';
```

Add a reusable config type near `KeywordMatchTriggerConfig` (around line 578):

```typescript
export interface InstagramCommentTriggerConfig {
  /** Empty/absent = match every comment. Non-empty = same substring/
   *  word matching as KeywordMatchTriggerConfig. */
  keywords?: string[];
  match_type?: 'exact' | 'contains' | 'word';
  case_sensitive?: boolean;
}
```

Add it to the `AutomationTriggerConfig` union (around line 603):

```typescript
export type AutomationTriggerConfig =
  | Record<string, never>
  | KeywordMatchTriggerConfig
  | TagTriggerConfig
  | TimeBasedTriggerConfig
  | InteractiveReplyTriggerConfig
  | WebhookTriggerConfig
  | InstagramCommentTriggerConfig
  | Record<string, unknown>;
```

- [ ] **Step 2: Write the failing tests for `triggerMatches`**

Add to `src/lib/automations/engine.test.ts`, right after the existing `describe("triggerMatches — keyword_match", ...)` block:

```typescript
describe("triggerMatches — instagram_comment_received", () => {
  function automation(cfg: Record<string, unknown> = {}): Automation {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "ig comment",
      trigger_type: "instagram_comment_received",
      trigger_config: cfg,
      is_active: true,
    } as unknown as Automation;
  }

  it("matches any comment when no keywords are configured", () => {
    expect(triggerMatches(automation(), { message_text: "qualquer coisa" })).toBe(true);
    expect(triggerMatches(automation({ keywords: [] }), { message_text: "qualquer coisa" })).toBe(true);
  });

  it("matches only comments containing a configured keyword", () => {
    const a = automation({ keywords: ["quero"], match_type: "contains" });
    expect(triggerMatches(a, { message_text: "eu quero saber mais" })).toBe(true);
    expect(triggerMatches(a, { message_text: "adorei o post" })).toBe(false);
  });
});

describe("triggerMatches — instagram_dm_received", () => {
  it("always matches — no filter config in this phase", () => {
    const automation = {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "ig dm",
      trigger_type: "instagram_dm_received",
      trigger_config: {},
      is_active: true,
    } as unknown as Automation;
    expect(triggerMatches(automation, { message_text: "oi" })).toBe(true);
    expect(triggerMatches(automation, undefined)).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/automations/engine.test.ts -t "instagram"`
Expected: FAIL — `triggerMatches` falls through to `return true` today for `instagram_comment_received` regardless of keywords (the keyword-filtering test fails), and `instagram_dm_received` isn't a recognized case yet (though it happens to pass by the same fallthrough — the important failing case is the keyword filter).

- [ ] **Step 4: Implement the new branch in `triggerMatches`**

In `src/lib/automations/engine.ts`, add this branch right after the existing `keyword_match` block (after line 771's closing `}`):

```typescript
  // Same substring/word matching as keyword_match, but inverted
  // default: an Instagram comment automation with NO keywords
  // configured fires on every comment (the common "just tag whoever
  // comments" case), whereas keyword_match with no keywords matches
  // nothing (see above) — the config is opt-IN filtering here, not a
  // required one.
  if (automation.trigger_type === 'instagram_comment_received') {
    const cfg = automation.trigger_config as InstagramCommentTriggerConfig
    if (!cfg?.keywords || cfg.keywords.length === 0) return true
    const text = (ctx?.message_text ?? '').toString()
    if (!text) return false
    if (cfg.match_type === 'word') {
      return cfg.keywords.some((raw) => matchesWholeWord(text, raw, cfg.case_sensitive))
    }
    const haystack = cfg.case_sensitive ? text : text.toLowerCase()
    return cfg.keywords.some((raw) => {
      const k = cfg.case_sensitive ? raw : raw.toLowerCase()
      return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
    })
  }
```

Add `InstagramCommentTriggerConfig` to the type-only import at the top of the file (alongside `KeywordMatchTriggerConfig`):

```typescript
import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  InstagramCommentTriggerConfig,
  InteractiveReplyTriggerConfig,
  ...
```

`instagram_dm_received` needs no branch — like `new_message_received` and `first_inbound_message` today, it falls through to the function's final `return true`, which is exactly "always matches."

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/automations/engine.test.ts`
Expected: PASS (full file, not just the new cases — confirms nothing else regressed)

- [ ] **Step 6: Add validation (optional keyword sanity check)**

In `src/lib/automations/validate.ts`, add a branch after the `interactive_reply` block (before the final `return issues`):

```typescript
  } else if (triggerType === 'instagram_comment_received') {
    // Keywords are optional here (empty = match everything), but if
    // present they follow the same "no blank entries" rule as
    // keyword_match.
    const k = cfg.keywords
    if (k !== undefined) {
      if (!Array.isArray(k)) {
        issues.push({ path: 'trigger.keywords', message: 'keywords must be an array' })
      } else if (k.some((v) => typeof v !== 'string' || v.trim() === '')) {
        issues.push({ path: 'trigger.keywords', message: 'keywords cannot be empty strings' })
      }
    }
  }
```

- [ ] **Step 7: Add `TRIGGER_META` entries**

In `src/lib/automations/trigger-meta.ts`, add to the `TRIGGER_META` record (after `webhook_received`):

```typescript
  instagram_comment_received: {
    label: 'Instagram Comment',
    pillClass: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300',
  },
  instagram_dm_received: {
    label: 'Instagram Direct',
    pillClass: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300',
  },
```

- [ ] **Step 8: Run the full test suite and type-check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: zero type errors; same pass count as before plus the new `instagram_comment_received`/`instagram_dm_received` cases; the 5 pre-existing `date-utils.test.ts` failures unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/types/index.ts src/lib/automations/engine.ts src/lib/automations/engine.test.ts src/lib/automations/validate.ts src/lib/automations/trigger-meta.ts
git commit -m "Adiciona os gatilhos instagram_comment_received e instagram_dm_received ao motor de automacoes"
```

---

### Task 7: Webhook route — receive Instagram events

**Files:**
- Create: `src/app/api/instagram/webhook/route.ts`
- Test: `src/app/api/instagram/webhook/route.test.ts`

**Interfaces:**
- Consumes: `verifyMetaWebhookSignature` (`@/lib/whatsapp/webhook-signature`), `findOrCreateInstagramContact` (Task 5), `fetchInstagramUsername` (Task 2), `runAutomationsForTrigger` (`@/lib/automations/engine`), `decrypt` (`@/lib/whatsapp/encryption`).
- Produces: `GET /api/instagram/webhook` (handshake), `POST /api/instagram/webhook` (event ingestion).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/app/api/instagram/webhook/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

const h = vi.hoisted(() => ({
  state: {
    configRow: null as null | { account_id: string; access_token: string },
    insertedEvents: [] as string[],
    eventAlreadyExists: false,
    runCalls: [] as unknown[],
    contactId: "contact-1",
  },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "instagram_config") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: h.state.configRow, error: null }),
            }),
          }),
        };
      }
      if (table === "instagram_webhook_events") {
        return {
          insert: (row: { event_key: string }) => ({
            then: (resolve: (v: unknown) => void) => {
              h.state.insertedEvents.push(row.event_key);
              resolve(
                h.state.eventAlreadyExists
                  ? { error: { code: "23505" } }
                  : { error: null },
              );
              return Promise.resolve();
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: (v: string) => v.replace("encrypted:", ""),
}));

vi.mock("@/lib/contacts/instagram-dedupe", () => ({
  findOrCreateInstagramContact: vi.fn(async () => ({ id: h.state.contactId })),
}));

vi.mock("@/lib/instagram/graph-api", () => ({
  fetchInstagramUsername: vi.fn(async () => "joana"),
}));

vi.mock("@/lib/automations/engine", () => ({
  runAutomationsForTrigger: vi.fn(async (input: unknown) => {
    h.state.runCalls.push(input);
  }),
}));

import { GET, POST } from "./route";
import { runAutomationsForTrigger } from "@/lib/automations/engine";

const APP_SECRET = "test-app-secret";

function sign(body: string): string {
  return "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex");
}

beforeEach(() => {
  process.env.META_APP_SECRET = APP_SECRET;
  h.state.configRow = { account_id: "acc-1", access_token: "encrypted:page-token" };
  h.state.insertedEvents = [];
  h.state.eventAlreadyExists = false;
  h.state.runCalls = [];
  vi.clearAllMocks();
});

describe("GET /api/instagram/webhook", () => {
  it("echoes hub.challenge on a valid verify request", async () => {
    const req = new Request(
      "https://x.test/api/instagram/webhook?hub.mode=subscribe&hub.challenge=123&hub.verify_token=any",
    );
    const res = await GET(req);
    expect(await res.text()).toBe("123");
    expect(res.status).toBe(200);
  });
});

describe("POST /api/instagram/webhook", () => {
  it("rejects a request with an invalid signature", async () => {
    const body = JSON.stringify({ object: "instagram", entry: [] });
    const req = new Request("https://x.test/api/instagram/webhook", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": "sha256=deadbeef" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(runAutomationsForTrigger).not.toHaveBeenCalled();
  });

  it("fires instagram_comment_received for a comment event", async () => {
    const body = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-1",
          changes: [
            {
              field: "comments",
              value: { from: { id: "igsid-123" }, id: "comment-1", text: "quero saber mais" },
            },
          ],
        },
      ],
    });
    const req = new Request("https://x.test/api/instagram/webhook", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": sign(body) },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0)); // let the deferred processing settle
    expect(h.state.runCalls).toContainEqual(
      expect.objectContaining({
        accountId: "acc-1",
        triggerType: "instagram_comment_received",
        contactId: "contact-1",
        context: { message_text: "quero saber mais" },
      }),
    );
  });

  it("fires instagram_dm_received for a messaging event", async () => {
    const body = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-1",
          messaging: [
            { sender: { id: "igsid-456" }, message: { mid: "msg-1", text: "oi, tudo bem?" } },
          ],
        },
      ],
    });
    const req = new Request("https://x.test/api/instagram/webhook", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": sign(body) },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.state.runCalls).toContainEqual(
      expect.objectContaining({
        accountId: "acc-1",
        triggerType: "instagram_dm_received",
        contactId: "contact-1",
        context: { message_text: "oi, tudo bem?" },
      }),
    );
  });

  it("skips an event it has already processed (dedupe)", async () => {
    h.state.eventAlreadyExists = true;
    const body = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-1",
          changes: [{ field: "comments", value: { from: { id: "igsid-1" }, id: "comment-dup", text: "oi" } }],
        },
      ],
    });
    const req = new Request("https://x.test/api/instagram/webhook", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": sign(body) },
    });
    await POST(req);
    await new Promise((r) => setTimeout(r, 0));
    expect(runAutomationsForTrigger).not.toHaveBeenCalled();
  });

  it("discards an event whose ig_user_id has no matching instagram_config", async () => {
    h.state.configRow = null;
    const body = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-unknown",
          changes: [{ field: "comments", value: { from: { id: "igsid-1" }, id: "comment-2", text: "oi" } }],
        },
      ],
    });
    const req = new Request("https://x.test/api/instagram/webhook", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": sign(body) },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(runAutomationsForTrigger).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/api/instagram/webhook/route.test.ts`
Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Write the implementation**

```typescript
// src/app/api/instagram/webhook/route.ts
import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { findOrCreateInstagramContact } from '@/lib/contacts/instagram-dedupe'
import { fetchInstagramUsername } from '@/lib/instagram/graph-api'
import { runAutomationsForTrigger } from '@/lib/automations/engine'

// See docs/superpowers/specs/2026-09-24-instagram-integration-design.md.
// Payload shapes below follow Meta's documented Instagram Messaging
// webhook format (comments mirror the Graph API "comments" field;
// messaging mirrors the Messenger Platform shape Instagram DMs reuse)
// — like the UAZAPI webhook's own payload comments in this codebase,
// this is best-effort until confirmed against a live delivery.

export const maxDuration = 30

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

interface CommentChangeValue {
  from?: { id: string; username?: string }
  id: string
  text?: string
}

interface MessagingEvent {
  sender?: { id: string }
  message?: { mid: string; text?: string }
}

interface InstagramWebhookEntry {
  id: string
  changes?: Array<{ field: string; value: CommentChangeValue }>
  messaging?: MessagingEvent[]
}

interface InstagramWebhookBody {
  object?: string
  entry?: InstagramWebhookEntry[]
}

// GET - Meta's one-time subscription verification.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const challenge = searchParams.get('hub.challenge')
  if (mode !== 'subscribe' || !challenge) {
    return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 })
  }
  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
}

// POST - Receive comment/DM events.
export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[instagram/webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: InstagramWebhookBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Ack Meta immediately (same reasoning as the WhatsApp webhook's
  // after() usage) — real processing happens after the response is
  // sent, but the runtime is kept alive until it finishes.
  after(async () => {
    try {
      await processWebhook(body)
    } catch (error) {
      console.error('[instagram/webhook] processing failed:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(body: InstagramWebhookBody) {
  if (!body.entry) return
  const db = supabaseAdmin()

  for (const entry of body.entry) {
    const igUserId = entry.id

    for (const change of entry.changes ?? []) {
      if (change.field !== 'comments') continue
      await handleEvent(db, {
        igUserId,
        igsid: change.value.from?.id,
        eventKey: `comment:${change.value.id}`,
        text: change.value.text ?? '',
        triggerType: 'instagram_comment_received',
      })
    }

    for (const messagingEvent of entry.messaging ?? []) {
      if (!messagingEvent.message?.mid) continue
      await handleEvent(db, {
        igUserId,
        igsid: messagingEvent.sender?.id,
        eventKey: `dm:${messagingEvent.message.mid}`,
        text: messagingEvent.message.text ?? '',
        triggerType: 'instagram_dm_received',
      })
    }
  }
}

async function handleEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  args: {
    igUserId: string
    igsid: string | undefined
    eventKey: string
    text: string
    triggerType: 'instagram_comment_received' | 'instagram_dm_received'
  },
) {
  if (!args.igsid) return

  // Dedupe first — Meta redelivers "at least once". A unique-violation
  // on insert means this exact event was already handled.
  const { error: dedupeError } = await db
    .from('instagram_webhook_events')
    .insert({ event_key: args.eventKey })
  if (dedupeError) {
    if (dedupeError.code === '23505') return // already processed
    console.error('[instagram/webhook] dedupe insert failed:', dedupeError)
    return
  }

  const { data: config } = await db
    .from('instagram_config')
    .select('account_id, access_token')
    .eq('ig_user_id', args.igUserId)
    .maybeSingle()
  if (!config) {
    console.warn('[instagram/webhook] no instagram_config for ig_user_id', args.igUserId)
    return
  }

  const pageAccessToken = decrypt(config.access_token)
  const username = await fetchInstagramUsername({ igsid: args.igsid, pageAccessToken }).catch(
    () => null,
  )

  const { id: contactId } = await findOrCreateInstagramContact(db, config.account_id, {
    igsid: args.igsid,
    username,
  })

  await runAutomationsForTrigger({
    accountId: config.account_id,
    triggerType: args.triggerType,
    contactId,
    context: { message_text: args.text },
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/api/instagram/webhook/route.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no new failures beyond the 5 pre-existing unrelated ones.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/instagram/webhook/route.ts src/app/api/instagram/webhook/route.test.ts
git commit -m "Adiciona webhook do Instagram (comentario e direct disparam automacoes)"
```

---

### Task 8: Connection status/disconnect API

**Files:**
- Create: `src/app/api/instagram/status/route.ts`

**Interfaces:**
- Consumes: `requireRole`, `toErrorResponse` (`@/lib/auth/account`), `getInstagramStatus`, `getInstagramConfig` (Task 3).
- Produces: `GET /api/instagram/status` → `{ enabled: boolean; config: InstagramConfig | null }`; `DELETE /api/instagram/status` (admin+) disconnects.

- [ ] **Step 1: Write the implementation** (thin route, same shape as `src/app/api/sdr-ia/status/route.ts` — no dedicated test file, consistent with that precedent, since it's a direct passthrough with no branching logic worth a unit test beyond what route conventions already cover)

```typescript
// src/app/api/instagram/status/route.ts
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getInstagramStatus, getInstagramConfig } from '@/lib/instagram/config'

/**
 * GET /api/instagram/status
 *
 * Whether this account can access the Instagram integration
 * (accounts.instagram_enabled) plus its current connection, if any.
 * The Settings → Instagram panel uses this to decide between the
 * locked view and the real connect/connected UI — checked
 * server-side, same reasoning as /api/sdr-ia/status.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const enabled = await getInstagramStatus(supabase, accountId)
    const config = enabled ? await getInstagramConfig(supabase, accountId) : null
    return NextResponse.json({ enabled, config })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/**
 * DELETE /api/instagram/status  (admin+)
 *
 * Disconnects the account's Instagram connection. Does not attempt to
 * revoke the token on Meta's side (there is no dedicated Graph API
 * call for a Page-issued token) — deleting the row is sufficient:
 * this integration only ever reads config off this table, so with the
 * row gone the webhook simply logs "no instagram_config" and discards
 * future events for that ig_user_id (Task 7).
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase.from('instagram_config').delete().eq('account_id', accountId)
    if (error) {
      console.error('[instagram/status DELETE] failed:', error)
      return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/instagram/status/route.ts
git commit -m "Adiciona rota de status/desconexao do Instagram"
```

---

### Task 9: Settings UI — connect panel + locked view + navigation

**Files:**
- Create: `src/components/settings/instagram-config-panel.tsx`
- Modify: `src/components/settings/settings-sections.ts`
- Modify: `src/app/(dashboard)/settings/page.tsx`
- Modify: `messages/pt.json`, `messages/en.json`, `messages/ko.json`

**Interfaces:**
- Consumes: `GET /api/instagram/status`, `DELETE /api/instagram/status`, `GET /api/instagram/oauth/connect` (Tasks 4, 8), `supportWhatsAppUrl` (`@/lib/support`).
- Produces: a mounted `InstagramConfigPanel` component reachable at `/settings?tab=instagram`.

- [ ] **Step 1: Add the `instagram` section**

In `src/components/settings/settings-sections.ts`:

```typescript
import {
  Bell,
  CalendarDays,
  Coins,
  Compass,
  FileText,
  Instagram,
  KeyRound,
  LayoutGrid,
  Palette,
  PlugZap,
  Shield,
  Tags,
  User,
  UsersRound,
  Webhook,
  Zap,
  type LucideIcon,
} from 'lucide-react';
```

Add `'instagram'` to `SETTINGS_SECTIONS`, right after `'whatsapp'`:

```typescript
export const SETTINGS_SECTIONS = [
  'overview',
  'getting-started',
  'profile',
  'security',
  'appearance',
  'whatsapp',
  'instagram',
  'calendar',
  ...
```

Add its metadata to `SECTION_META`, right after `whatsapp`:

```typescript
  instagram: { id: 'instagram', label: 'Instagram', icon: Instagram, group: 'workspace' },
```

- [ ] **Step 2: Write `InstagramConfigPanel`**

```typescript
// src/components/settings/instagram-config-panel.tsx
"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Instagram as InstagramIcon, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { supportWhatsAppUrl } from "@/lib/support";

interface InstagramConfig {
  igUserId: string;
  igUsername: string | null;
  status: "connected" | "disconnected";
  connectedAt: string;
}

interface StatusResponse {
  enabled: boolean;
  config: InstagramConfig | null;
}

/**
 * Settings → Instagram. Mirrors the WhatsApp panel's shape: a locked
 * marketing view for accounts without accounts.instagram_enabled
 * (mirrors SdrIaLockedView), and a connect/connected view for accounts
 * that do have it.
 */
export function InstagramConfigPanel() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);

  const load = () => {
    setLoading(true);
    fetch("/api/instagram/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => setData(json))
      .catch(() => setData({ enabled: false, config: null }))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const connected = searchParams.get("instagram_connected");
    const error = searchParams.get("instagram_error");
    if (connected) {
      toast.success("Instagram conectado com sucesso.");
      load();
    } else if (error) {
      toast.error(`Falha ao conectar o Instagram: ${error}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function disconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/instagram/status", { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("Instagram desconectado.");
      load();
    } catch {
      toast.error("Não foi possível desconectar. Tente novamente.");
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data?.enabled) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <Card className="border-border bg-card">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <InstagramIcon className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-xl font-semibold text-foreground">Integração com Instagram</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Use comentários em posts e mensagens via Direct como gatilho das suas automações.
            </p>
          </CardHeader>
          <CardContent>
            <div className="mt-2 flex items-center justify-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
              <Lock className="size-3.5 shrink-0" />
              Recurso não incluso no seu plano atual
            </div>
            <Button
              onClick={() =>
                window.open(
                  supportWhatsAppUrl("Olá! Quero saber mais sobre a integração com Instagram do FuseHub."),
                  "_blank",
                  "noopener,noreferrer",
                )
              }
              className="mt-4 w-full bg-[#25D366] text-white hover:bg-[#1fb757]"
            >
              Falar com o suporte
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const config = data.config;

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="text-foreground">Instagram</CardTitle>
        <CardDescription className="text-muted-foreground">
          Conecte sua conta Instagram Business para usar comentários e Direct como gatilho de
          automação. Nunca pedimos sua senha — a conexão é feita pelo login oficial da Meta.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {config?.status === "connected" ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="size-4 text-emerald-400" />
              <div>
                <p className="text-sm font-medium text-foreground">
                  @{config.igUsername ?? config.igUserId}
                </p>
                <p className="text-xs text-muted-foreground">Conectado</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={disconnect} disabled={disconnecting}>
              {disconnecting ? "Desconectando..." : "Desconectar"}
            </Button>
          </div>
        ) : (
          <Button asChild>
            <a href="/api/instagram/oauth/connect">Conectar Instagram</a>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Wire it into the settings page**

In `src/app/(dashboard)/settings/page.tsx`, add the import:

```typescript
import { InstagramConfigPanel } from '@/components/settings/instagram-config-panel';
```

Add the panel entry right after `whatsapp` in the `panel` record:

```typescript
    instagram: <InstagramConfigPanel />,
```

- [ ] **Step 4: Check `supportWhatsAppUrl`'s real signature before using it**

Run: `grep -n "export function supportWhatsAppUrl" src/lib/support.ts`

Confirm the parameter shape matches what Step 2 assumes (a single prefilled-message string) — adjust the call in `instagram-config-panel.tsx` if the real signature differs (e.g. an options object instead of a bare string).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Manual UI check**

Run the dev server (`npm run dev`), log in as an account with `instagram_enabled = false` and confirm `/settings?tab=instagram` shows the locked view; then flip the flag via SQL for a test account and confirm the connect button appears and points at `/api/instagram/oauth/connect`.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/instagram-config-panel.tsx src/components/settings/settings-sections.ts "src/app/(dashboard)/settings/page.tsx"
git commit -m "Adiciona painel de conexao do Instagram em Configuracoes"
```

---

### Task 10: Automation builder UI — select the new triggers

**Files:**
- Modify: `src/components/automations/automation-builder.tsx`
- Modify: `messages/pt.json`, `messages/en.json`, `messages/ko.json`

**Interfaces:**
- Consumes: `KeywordMatchConfig` (existing component in the same file), `InstagramCommentTriggerConfig` (Task 6).

- [ ] **Step 1: Add the two trigger options**

In `src/components/automations/automation-builder.tsx`, add to `TRIGGER_OPTIONS` (after `webhook_received`):

```typescript
const TRIGGER_OPTIONS: { value: AutomationTriggerType }[] = [
  { value: "new_message_received" },
  { value: "first_inbound_message" },
  { value: "keyword_match" },
  { value: "interactive_reply" },
  { value: "new_contact_created" },
  { value: "conversation_assigned" },
  { value: "tag_added" },
  { value: "time_based" },
  { value: "webhook_received" },
  { value: "instagram_comment_received" },
  { value: "instagram_dm_received" },
]
```

- [ ] **Step 2: Render the keyword config for `instagram_comment_received`**

In the same file's trigger-config block (the `{type === "keyword_match" && (...)}` area), add right after it:

```typescript
            {type === "instagram_comment_received" && (
              <KeywordMatchConfig
                config={config as unknown as KeywordMatchTriggerConfig}
                onChange={onConfigChange}
                t={t}
              />
            )}
```

`instagram_dm_received` needs no config block — like `new_contact_created`/`conversation_assigned`, it has none today.

- [ ] **Step 3: Add translations**

Add to `messages/pt.json` under `Automations.builder.triggers` (find via `node -e "console.log(JSON.stringify(require('./messages/pt.json').Automations.builder.triggers, null, 2))"` to confirm the exact insertion point, then use the same Node-script-edit approach used earlier this session for JSON files — direct string `Edit` calls fail against this file's single-line-per-object-but-still-large-diff risk, so prefer a small Node script that loads the JSON, assigns the two new keys, and rewrites with `JSON.stringify(m, null, 2) + '\n'`, exactly as done for `SdrIa.wizard.messages` earlier in this project):

```json
"instagram_comment_received": {
  "label": "Comentário no Instagram",
  "hint": "Alguém comentou em um post da conta Instagram conectada"
},
"instagram_dm_received": {
  "label": "Direct do Instagram",
  "hint": "Alguém mandou uma mensagem via Direct para a conta Instagram conectada"
}
```

Repeat with the English equivalents in `messages/en.json` ("Instagram Comment" / "Someone commented on a post from the connected Instagram account", "Instagram Direct" / "Someone sent a Direct message to the connected Instagram account") and Korean in `messages/ko.json` (translate naturally, matching the tone of the existing Korean trigger labels in that file).

- [ ] **Step 4: Type-check and test**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no errors, no new failures.

- [ ] **Step 5: Manual UI check**

In the dev server, open the automation builder, add a new automation, and confirm both new trigger types appear in the trigger-type dropdown with the right label, and that selecting "Comentário no Instagram" shows the same keyword editor `keyword_match` uses.

- [ ] **Step 6: Commit**

```bash
git add src/components/automations/automation-builder.tsx messages/pt.json messages/en.json messages/ko.json
git commit -m "Adiciona os novos gatilhos do Instagram ao construtor de automacoes"
```

---

### Task 11: Connection health-check cron

**Files:**
- Modify: `src/app/api/automations/cron/route.ts`
- Test: add to whichever test file already covers this route, or create `src/app/api/automations/cron/instagram-health.test.ts` if the route's existing tests live in a separate file — check with `find src/app/api/automations/cron -name "*.test.ts"` before deciding.

**Interfaces:**
- Consumes: `verifyInstagramToken` (Task 2), `decrypt` (`@/lib/whatsapp/encryption`).
- Produces: a `checkInstagramConnections(admin)` function called from the cron route's main handler, returning the count of connections marked disconnected.

- [ ] **Step 1: Locate the cron route's existing drain-function pattern**

Run: `grep -n "^async function drain\|^export async function" src/app/api/automations/cron/route.ts`

Confirm the exact shape of an existing drain function (e.g. `drainDueReactivations` from this same session) to match its signature (`admin: SupabaseClient`, return type) and where it's invoked in the main handler.

- [ ] **Step 2: Write the function**

Add to `src/app/api/automations/cron/route.ts`, following the same placement convention as the other `drain*`/`check*` functions in this file:

```typescript
/**
 * Periodic health check for Instagram connections (migration 075).
 * Instagram Page tokens don't have a push-based revocation signal, so
 * this is the only way to detect "the client removed FuseHub's access
 * on Meta's side" before the next webhook silently goes nowhere.
 */
async function checkInstagramConnections(admin: SupabaseClient): Promise<number> {
  const { data: configs, error } = await admin
    .from('instagram_config')
    .select('id, ig_user_id, access_token')
    .eq('status', 'connected')

  if (error || !configs) {
    console.error('[cron] failed to load instagram_config for health check:', error)
    return 0
  }

  let disconnected = 0
  for (const config of configs) {
    let stillValid: boolean
    try {
      stillValid = await verifyInstagramToken({
        igUserId: config.ig_user_id,
        pageAccessToken: decrypt(config.access_token),
      })
    } catch (err) {
      console.error('[cron] instagram token verification threw for', config.id, err)
      stillValid = false
    }
    if (!stillValid) {
      await admin.from('instagram_config').update({ status: 'disconnected' }).eq('id', config.id)
      disconnected++
    }
  }
  return disconnected
}
```

Add the import at the top of the file:

```typescript
import { verifyInstagramToken } from '@/lib/instagram/graph-api'
```

(`decrypt` and `SupabaseClient` are almost certainly already imported in this file given its existing drain functions — confirm with `grep -n "^import" src/app/api/automations/cron/route.ts` and only add what's missing.)

- [ ] **Step 3: Wire it into the main handler**

Find where the other `drain*` functions are called (e.g. `const reactivationsSent = await drainDueReactivations(admin)`) and add alongside them:

```typescript
    const instagramDisconnected = await checkInstagramConnections(admin)
```

Add `instagram_connections_disconnected: instagramDisconnected,` to the handler's returned JSON object, matching the existing `conversation_reactivations_sent` field's placement.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: no new failures beyond the 5 pre-existing unrelated ones — this task has no dedicated unit test (the function is a thin loop over an already-tested Graph API call, mirroring how `drainDueReactivations` itself has no bespoke logic beyond calling already-tested pieces), but the full suite run confirms the file still compiles and nothing else broke.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/automations/cron/route.ts
git commit -m "Adiciona checagem periodica de saude da conexao com Instagram"
```

---

## Post-plan checklist (not a task — a reminder for whoever merges this)

- Migration 075 must be applied to the live Supabase database **before** deploying the code from Tasks 1+ (same "apply migration first" lesson learned twice already this session with migrations 071 and 073).
- The Meta App (`META_APP_ID`) needs, in Meta's App Dashboard: the Instagram Graph API product added, the 5 scopes from Task 2 requested, `https://fusehub.fusegrowth.com.br/api/instagram/oauth/callback` added to Valid OAuth Redirect URIs, and the Instagram webhook fields (`comments`, `messages`) subscribed at the App level pointing at `https://fusehub.fusegrowth.com.br/api/instagram/webhook` — none of this is code, it's manual Meta Business dashboard configuration the user (or whoever holds Meta Business admin access) must do once.
- Fuse's own account needs `accounts.instagram_enabled = true` set via direct SQL to actually use this (same activation step SDR IA needed).
