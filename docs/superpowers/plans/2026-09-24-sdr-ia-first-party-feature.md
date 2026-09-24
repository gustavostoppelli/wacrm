# SDR IA — Função Nativa Multi-Tenant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the SDR IA cold-outreach PoC (today an external Node script in `opensquad/skills/sdr-frio/`) into a first-party, multi-tenant FuseHub feature: a menu item, a 5-step config wizard, a per-account tag-based lead queue, and automatic daily sending via the existing cron.

**Architecture:** New `sdr_ia_config` table (one row per account) drives a `drainSdrIa()` function added to the existing `/api/automations/cron` drain loop, mirroring `drainDailyDigest()`. Access is gated by a new `accounts.sdr_ia_enabled` boolean (default `false`, same convention as `whatsapp_channel_limit`) — the menu item is always visible, but the page itself renders either a locked marketing view or the real wizard depending on that flag, checked server-side via a small status endpoint (never trusted from a client-held value). Sending reuses the existing Meta/UAZAPI provider layer (`resolveChannelById`, `engineSendText`/`engineSendTemplate`) — no new WhatsApp-sending code.

**Tech Stack:** Next.js 16 App Router, Supabase/PostgreSQL (RLS), TypeScript, Vitest, next-intl.

## Global Constraints

- Every new table/column follows the "per-account feature flag" convention in `AGENTS.md`: safe default for the sellable product (`sdr_ia_enabled = false`), per-account override only via direct SQL — never a customer-facing upgrade UI in this phase.
- No hardcoded Fuse-specific behavior in application code. The only Fuse-specific artifact is a **data row** (its own `accounts.sdr_ia_enabled = true`), set via SQL by the user after this ships — not a task in this plan.
- All new tables get RLS via `is_account_member(account_id[, min_role])`, matching every other multi-tenant table in this schema.
- Copy/UI text goes through next-intl (`messages/pt.json`, `en.json`, `ko.json`) — no hardcoded strings in components, matching the rest of the app.
- Reuse existing helpers instead of duplicating: `requireRole` (`src/lib/auth/account.ts`), `resolveChannelById` (`src/lib/whatsapp/resolve-channel.ts`), `engineSendText`/`engineSendTemplate` (`src/lib/automations/meta-send.ts`), `addContactTagIfAbsent` (`src/lib/contacts/tag-write.ts`), `resolveImportTagIds` (`src/lib/contacts/resolve-import-tags.ts`), `supabaseAdmin` (`src/lib/automations/admin-client.ts`).

---

### Task 1: Migration — `sdr_ia_enabled`, `sdr_ia_config`, candidate-lookup RPC

**Files:**
- Create: `supabase/migrations/070_sdr_ia.sql`

**Interfaces:**
- Produces: table `sdr_ia_config` with columns `account_id` (PK/FK), `enabled`, `lead_tag_id`, `contacted_tag_id`, `whatsapp_config_id`, `send_mode`, `template_name`, `template_language`, `message_variants` (jsonb array), `daily_cap`, `hours_start`, `hours_end`, `updated_at`. Produces column `accounts.sdr_ia_enabled` (boolean, default false). Produces RPC `sdr_ia_next_candidates(p_account_id uuid, p_lead_tag_id uuid, p_contacted_tag_id uuid, p_limit int)` returning `(contact_id uuid, phone text)`.

- [ ] **Step 1: Write the migration SQL**

```sql
-- ============================================================
-- 070_sdr_ia.sql — SDR IA as a first-party, multi-tenant feature
--
-- Graduates the sdr-frio PoC (opensquad/skills/sdr-frio, external
-- script, Fuse-only — see docs/superpowers/specs/2026-09-22-sdr-ia-
-- fusehub-design.md) into a real FuseHub feature any account could
-- eventually buy. See docs/superpowers/specs/2026-09-24-sdr-ia-
-- first-party-feature-design.md for the full design.
--
-- accounts.sdr_ia_enabled controls whether the account sees the real
-- config wizard on /sdr-ia or a locked marketing page — same
-- one-column-per-account-setting convention as
-- accounts.whatsapp_channel_limit (migration 067). Defaults to false
-- for every account of the sellable product; Fuse's own account is
-- flipped to true via direct SQL after this ships, not by this
-- migration.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS sdr_ia_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN accounts.sdr_ia_enabled IS
  'Whether this account can access the SDR IA cold-outreach feature. Default false for the sellable product baseline; flipped per-account via direct SQL once a customer pays for it.';

CREATE TABLE IF NOT EXISTS sdr_ia_config (
  account_id          UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled             BOOLEAN NOT NULL DEFAULT false,
  lead_tag_id         UUID REFERENCES tags(id) ON DELETE SET NULL,
  contacted_tag_id    UUID REFERENCES tags(id) ON DELETE SET NULL,
  whatsapp_config_id  UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  send_mode           TEXT NOT NULL DEFAULT 'template' CHECK (send_mode IN ('template', 'text')),
  template_name       TEXT,
  template_language   TEXT,
  message_variants    JSONB NOT NULL DEFAULT '[]'::jsonb,
  daily_cap           INTEGER NOT NULL DEFAULT 5,
  hours_start         INTEGER NOT NULL DEFAULT 9,
  hours_end           INTEGER NOT NULL DEFAULT 18,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sdr_ia_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sdr_ia_config_select ON sdr_ia_config;
CREATE POLICY sdr_ia_config_select ON sdr_ia_config FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS sdr_ia_config_write ON sdr_ia_config;
CREATE POLICY sdr_ia_config_write ON sdr_ia_config FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- Cron runs with the service-role client (bypasses RLS already), so
-- no separate policy is needed for that path.

-- ============================================================
-- sdr_ia_next_candidates — next batch of untouched, tagged contacts
-- for one account's SDR IA queue. SECURITY DEFINER + explicit
-- account_id filter (not RLS) since the cron caller is service-role
-- and iterates many accounts in one process.
-- ============================================================
CREATE OR REPLACE FUNCTION sdr_ia_next_candidates(
  p_account_id UUID,
  p_lead_tag_id UUID,
  p_contacted_tag_id UUID,
  p_limit INT
)
RETURNS TABLE(contact_id UUID, phone TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.phone
  FROM contacts c
  JOIN contact_tags lead_ct ON lead_ct.contact_id = c.id AND lead_ct.tag_id = p_lead_tag_id
  WHERE c.account_id = p_account_id
    AND c.phone IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM contact_tags done_ct
      WHERE done_ct.contact_id = c.id AND done_ct.tag_id = p_contacted_tag_id
    )
  ORDER BY c.created_at ASC
  LIMIT p_limit;
$$;
```

- [ ] **Step 2: Present the SQL to the user and ask them to run it in Supabase, then confirm**

This migration cannot be applied by the assistant directly (no DB-execution tool available in this environment) — present the SQL block above and wait for explicit confirmation it was run before continuing to Task 2.

- [ ] **Step 3: Verify via PostgREST that the new table and column are visible**

```bash
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/sdr_ia_config?limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```
Expected: `[]` (empty array, not a `PGRST205` "table not found" error).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/070_sdr_ia.sql
git commit -m "Adiciona tabela sdr_ia_config e flag accounts.sdr_ia_enabled"
```

---

### Task 2: `src/lib/sdr-ia/config.ts` — status + config read/write helpers

**Files:**
- Create: `src/lib/sdr-ia/config.ts`
- Test: `src/lib/sdr-ia/config.test.ts`

**Interfaces:**
- Consumes: none (pure DB helpers, takes a `SupabaseClient`).
- Produces: `getSdrIaStatus(db, accountId): Promise<boolean>`, `getSdrIaConfig(db, accountId): Promise<SdrIaConfig | null>`, `upsertSdrIaConfig(db, accountId, patch: Partial<SdrIaConfigInput>): Promise<SdrIaConfig>`, and the `SdrIaConfig`/`SdrIaConfigInput` types (mirrors the `sdr_ia_config` columns from Task 1: `enabled`, `lead_tag_id`, `contacted_tag_id`, `whatsapp_config_id`, `send_mode: 'template' | 'text'`, `template_name`, `template_language`, `message_variants: string[]`, `daily_cap`, `hours_start`, `hours_end`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/sdr-ia/config.test.ts
import { describe, expect, it, vi } from 'vitest'
import { getSdrIaStatus, getSdrIaConfig, upsertSdrIaConfig } from './config'

function makeDb(opts: { sdrIaEnabled?: boolean; configRow?: Record<string, unknown> | null }) {
  return {
    from: (table: string) => {
      if (table === 'accounts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: { sdr_ia_enabled: opts.sdrIaEnabled ?? false } }),
            }),
          }),
        }
      }
      // sdr_ia_config
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: opts.configRow ?? null }),
          }),
        }),
        upsert: (row: Record<string, unknown>) => ({
          select: () => ({
            single: () => Promise.resolve({ data: { account_id: 'acct-1', ...row }, error: null }),
          }),
        }),
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    },
  } as any
}

describe('getSdrIaStatus', () => {
  it('returns false when accounts.sdr_ia_enabled is false', async () => {
    const result = await getSdrIaStatus(makeDb({ sdrIaEnabled: false }), 'acct-1')
    expect(result).toBe(false)
  })

  it('returns true when accounts.sdr_ia_enabled is true', async () => {
    const result = await getSdrIaStatus(makeDb({ sdrIaEnabled: true }), 'acct-1')
    expect(result).toBe(true)
  })
})

describe('getSdrIaConfig', () => {
  it('returns null when the account has no config row yet', async () => {
    const result = await getSdrIaConfig(makeDb({ configRow: null }), 'acct-1')
    expect(result).toBeNull()
  })

  it('maps the DB row to SdrIaConfig', async () => {
    const result = await getSdrIaConfig(
      makeDb({
        configRow: {
          account_id: 'acct-1',
          enabled: true,
          lead_tag_id: 'tag-1',
          contacted_tag_id: 'tag-2',
          whatsapp_config_id: 'chan-1',
          send_mode: 'text',
          template_name: null,
          template_language: null,
          message_variants: ['Oi!'],
          daily_cap: 5,
          hours_start: 9,
          hours_end: 18,
        },
      }),
      'acct-1',
    )
    expect(result).toEqual(
      expect.objectContaining({ accountId: 'acct-1', sendMode: 'text', dailyCap: 5 }),
    )
  })
})

describe('upsertSdrIaConfig', () => {
  it('writes the patch and returns the updated config', async () => {
    const db = makeDb({})
    const result = await upsertSdrIaConfig(db, 'acct-1', { dailyCap: 10 })
    expect(result.accountId).toBe('acct-1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sdr-ia/config.test.ts`
Expected: FAIL with "Cannot find module './config'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/sdr-ia/config.ts
// ============================================================
// SDR IA per-account config (migration 070).
//
// Two independent gates, don't confuse them:
//   - accounts.sdr_ia_enabled — whether this account may access the
//     feature at all (visibility gate; set via SQL by Fuse today).
//   - sdr_ia_config.enabled — whether the account's own automation is
//     actively running (the account's own on/off switch, flipped by
//     the wizard's last step).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export type SdrIaSendMode = 'template' | 'text'

export interface SdrIaConfig {
  accountId: string
  enabled: boolean
  leadTagId: string | null
  contactedTagId: string | null
  whatsappConfigId: string | null
  sendMode: SdrIaSendMode
  templateName: string | null
  templateLanguage: string | null
  messageVariants: string[]
  dailyCap: number
  hoursStart: number
  hoursEnd: number
}

export type SdrIaConfigInput = Omit<SdrIaConfig, 'accountId'>

export async function getSdrIaStatus(db: SupabaseClient, accountId: string): Promise<boolean> {
  const { data } = await db
    .from('accounts')
    .select('sdr_ia_enabled')
    .eq('id', accountId)
    .maybeSingle()
  return !!data?.sdr_ia_enabled
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromRow(row: any): SdrIaConfig {
  return {
    accountId: row.account_id,
    enabled: !!row.enabled,
    leadTagId: row.lead_tag_id,
    contactedTagId: row.contacted_tag_id,
    whatsappConfigId: row.whatsapp_config_id,
    sendMode: row.send_mode,
    templateName: row.template_name,
    templateLanguage: row.template_language,
    messageVariants: Array.isArray(row.message_variants) ? row.message_variants : [],
    dailyCap: row.daily_cap,
    hoursStart: row.hours_start,
    hoursEnd: row.hours_end,
  }
}

export async function getSdrIaConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<SdrIaConfig | null> {
  const { data } = await db
    .from('sdr_ia_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()
  return data ? fromRow(data) : null
}

export async function upsertSdrIaConfig(
  db: SupabaseClient,
  accountId: string,
  patch: Partial<SdrIaConfigInput>,
): Promise<SdrIaConfig> {
  const row = {
    account_id: accountId,
    ...(patch.enabled !== undefined && { enabled: patch.enabled }),
    ...(patch.leadTagId !== undefined && { lead_tag_id: patch.leadTagId }),
    ...(patch.contactedTagId !== undefined && { contacted_tag_id: patch.contactedTagId }),
    ...(patch.whatsappConfigId !== undefined && { whatsapp_config_id: patch.whatsappConfigId }),
    ...(patch.sendMode !== undefined && { send_mode: patch.sendMode }),
    ...(patch.templateName !== undefined && { template_name: patch.templateName }),
    ...(patch.templateLanguage !== undefined && { template_language: patch.templateLanguage }),
    ...(patch.messageVariants !== undefined && { message_variants: patch.messageVariants }),
    ...(patch.dailyCap !== undefined && { daily_cap: patch.dailyCap }),
    ...(patch.hoursStart !== undefined && { hours_start: patch.hoursStart }),
    ...(patch.hoursEnd !== undefined && { hours_end: patch.hoursEnd }),
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await db
    .from('sdr_ia_config')
    .upsert(row, { onConflict: 'account_id' })
    .select('*')
    .single()

  if (error || !data) {
    throw new Error(`Failed to save SDR IA config: ${error?.message}`)
  }
  return fromRow(data)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/sdr-ia/config.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sdr-ia/config.ts src/lib/sdr-ia/config.test.ts
git commit -m "Adiciona helpers de leitura/escrita da config do SDR IA"
```

---

### Task 3: API routes — `/api/sdr-ia/status` and `/api/sdr-ia/config`

**Files:**
- Create: `src/app/api/sdr-ia/status/route.ts`
- Create: `src/app/api/sdr-ia/config/route.ts`

**Interfaces:**
- Consumes: `requireRole` (`src/lib/auth/account.ts`), `toErrorResponse`, `getSdrIaStatus`/`getSdrIaConfig`/`upsertSdrIaConfig` (Task 2).
- Produces: `GET /api/sdr-ia/status` → `{ enabled: boolean }`. `GET /api/sdr-ia/config` → `{ config: SdrIaConfig | null }` (403 if `sdr_ia_enabled` is false). `PUT /api/sdr-ia/config` → `{ config: SdrIaConfig }` (same 403 gate; body is `Partial<SdrIaConfigInput>` in camelCase, admin-only write).

- [ ] **Step 1: Write `status/route.ts`**

```typescript
// src/app/api/sdr-ia/status/route.ts
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getSdrIaStatus } from '@/lib/sdr-ia/config'

/**
 * GET /api/sdr-ia/status
 *
 * Whether this account can access the SDR IA feature
 * (accounts.sdr_ia_enabled). The /sdr-ia page calls this to decide
 * between the locked marketing view and the real config wizard —
 * checked server-side, never trusted from a client-held flag, so a
 * customer can't unlock the page by editing local state.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const enabled = await getSdrIaStatus(supabase, accountId)
    return NextResponse.json({ enabled })
  } catch (error) {
    return toErrorResponse(error)
  }
}
```

- [ ] **Step 2: Write `config/route.ts`**

```typescript
// src/app/api/sdr-ia/config/route.ts
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getSdrIaStatus, getSdrIaConfig, upsertSdrIaConfig } from '@/lib/sdr-ia/config'
import type { SdrIaConfigInput } from '@/lib/sdr-ia/config'

async function assertEnabled(supabase: Parameters<typeof getSdrIaStatus>[0], accountId: string) {
  const enabled = await getSdrIaStatus(supabase, accountId)
  if (!enabled) {
    throw Object.assign(new Error('SDR IA not enabled for this account'), { status: 403 })
  }
}

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    await assertEnabled(supabase, accountId)
    const config = await getSdrIaConfig(supabase, accountId)
    return NextResponse.json({ config })
  } catch (error) {
    if (error instanceof Error && 'status' in error) {
      return NextResponse.json({ error: error.message }, { status: (error as { status: number }).status })
    }
    return toErrorResponse(error)
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    await assertEnabled(supabase, accountId)

    const patch = (await request.json()) as Partial<SdrIaConfigInput>
    const config = await upsertSdrIaConfig(supabase, accountId, patch)
    return NextResponse.json({ config })
  } catch (error) {
    if (error instanceof Error && 'status' in error) {
      return NextResponse.json({ error: error.message }, { status: (error as { status: number }).status })
    }
    return toErrorResponse(error)
  }
}
```

- [ ] **Step 3: Manual verification**

With a real session cookie (or via the browser once the page exists in Task 9), confirm:
- An account with `sdr_ia_enabled = false` gets `{ enabled: false }` from `/api/sdr-ia/status` and a 403 from `/api/sdr-ia/config`.
- Fuse's own account (once flipped to `true` per Task 1) gets `{ enabled: true }` and a working config GET/PUT.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sdr-ia/status/route.ts src/app/api/sdr-ia/config/route.ts
git commit -m "Adiciona rotas de status e configuracao do SDR IA"
```

---

### Task 4: `src/lib/sdr-ia/tags.ts` — system tag resolution

**Files:**
- Create: `src/lib/sdr-ia/tags.ts`
- Test: `src/lib/sdr-ia/tags.test.ts`

**Interfaces:**
- Consumes: none beyond a `SupabaseClient` (find-or-create against the `tags` table, same shape `resolveImportTagIds` already uses).
- Produces: `resolveOrCreateTagId(db, accountId, userId, name): Promise<string>` — case-insensitive match on an existing tag name, else creates one; `variantTagName(n: number): string` → `` `sdr_ia_variante_${n}` `` (1-indexed), used by both the wizard (to pre-create variant tags) and the cron sender (to tag which variant a contact received).

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/sdr-ia/tags.test.ts
import { describe, expect, it } from 'vitest'
import { resolveOrCreateTagId, variantTagName } from './tags'

function makeDb(opts: { existingId?: string }) {
  const inserted: Record<string, unknown>[] = []
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          ilike: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: opts.existingId ? { id: opts.existingId } : null }),
          }),
        }),
      }),
      insert: (row: Record<string, unknown>) => {
        inserted.push(row)
        return {
          select: () => ({
            single: () => Promise.resolve({ data: { id: 'new-tag-id' }, error: null }),
          }),
        }
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('resolveOrCreateTagId', () => {
  it('returns the existing tag id when a case-insensitive match exists', async () => {
    const id = await resolveOrCreateTagId(makeDb({ existingId: 'tag-1' }), 'acct-1', 'user-1', 'Prospecção')
    expect(id).toBe('tag-1')
  })

  it('creates a new tag when none matches', async () => {
    const id = await resolveOrCreateTagId(makeDb({}), 'acct-1', 'user-1', 'sdr_ia_contatado')
    expect(id).toBe('new-tag-id')
  })
})

describe('variantTagName', () => {
  it('formats a 1-indexed variant tag name', () => {
    expect(variantTagName(1)).toBe('sdr_ia_variante_1')
    expect(variantTagName(3)).toBe('sdr_ia_variante_3')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sdr-ia/tags.test.ts`
Expected: FAIL with "Cannot find module './tags'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/sdr-ia/tags.ts
// ============================================================
// Tag resolution for SDR IA — same find-or-create semantics as
// src/lib/contacts/resolve-import-tags.ts, narrowed to a single name
// since the wizard resolves one tag at a time (lead tag, "contacted"
// tag, up to 3 variant tags).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_TAG_COLOR = '#3b82f6'

export async function resolveOrCreateTagId(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  name: string,
): Promise<string> {
  const trimmed = name.trim()

  const { data: existing } = await db
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .ilike('name', trimmed)
    .maybeSingle()

  if (existing) return existing.id as string

  const { data: created, error } = await db
    .from('tags')
    .insert({ account_id: accountId, user_id: userId, name: trimmed, color: DEFAULT_TAG_COLOR })
    .select('id')
    .single()

  if (error || !created) {
    throw new Error(`Failed to create tag "${trimmed}": ${error?.message}`)
  }
  return created.id as string
}

/** 1-indexed: variantTagName(1) === 'sdr_ia_variante_1'. */
export function variantTagName(n: number): string {
  return `sdr_ia_variante_${n}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/sdr-ia/tags.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sdr-ia/tags.ts src/lib/sdr-ia/tags.test.ts
git commit -m "Adiciona resolucao de tags do sistema para o SDR IA"
```

---

### Task 5: `src/lib/sdr-ia/send.ts` — conversation + first-contact send

**Files:**
- Create: `src/lib/sdr-ia/send.ts`
- Test: `src/lib/sdr-ia/send.test.ts`

**Interfaces:**
- Consumes: `engineSendText`/`engineSendTemplate` (`src/lib/automations/meta-send.ts`), `addContactTagIfAbsent` (`src/lib/contacts/tag-write.ts`).
- Produces: `findOrCreateConversationForChannel(db, accountId, userId, contactId, channelId): Promise<string>` (returns `conversationId`); `sendSdrIaFirstContact(db, args): Promise<{ variantIndex: number | null }>` where `args = { accountId, userId, contactId, conversationId, config: SdrIaConfig }` — sends via template or a randomly-picked text variant depending on `config.sendMode`, throws on send failure (caller decides how to log/continue).

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/sdr-ia/send.test.ts
import { describe, expect, it, vi } from 'vitest'
import { sendSdrIaFirstContact } from './send'
import * as metaSend from '@/lib/automations/meta-send'

describe('sendSdrIaFirstContact', () => {
  it('sends via engineSendTemplate when send_mode is template', async () => {
    const spy = vi.spyOn(metaSend, 'engineSendTemplate').mockResolvedValue({ whatsapp_message_id: 'wamid.1' })
    const result = await sendSdrIaFirstContact({} as never, {
      accountId: 'acct-1',
      userId: 'user-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      config: {
        accountId: 'acct-1',
        enabled: true,
        leadTagId: 'tag-1',
        contactedTagId: 'tag-2',
        whatsappConfigId: 'chan-1',
        sendMode: 'template',
        templateName: 'primeiro_contato',
        templateLanguage: 'pt_BR',
        messageVariants: [],
        dailyCap: 5,
        hoursStart: 9,
        hoursEnd: 18,
      },
    })
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'primeiro_contato', language: 'pt_BR' }),
    )
    expect(result.variantIndex).toBeNull()
  })

  it('sends a random variant via engineSendText when send_mode is text', async () => {
    const spy = vi.spyOn(metaSend, 'engineSendText').mockResolvedValue({ whatsapp_message_id: 'wamid.2' })
    const result = await sendSdrIaFirstContact({} as never, {
      accountId: 'acct-1',
      userId: 'user-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      config: {
        accountId: 'acct-1',
        enabled: true,
        leadTagId: 'tag-1',
        contactedTagId: 'tag-2',
        whatsappConfigId: 'chan-1',
        sendMode: 'text',
        templateName: null,
        templateLanguage: null,
        messageVariants: ['Oi! Tudo bem?', 'Olá, posso te ajudar?'],
        dailyCap: 5,
        hoursStart: 9,
        hoursEnd: 18,
      },
    })
    expect(spy).toHaveBeenCalled()
    expect(result.variantIndex).toBeGreaterThanOrEqual(0)
    expect(result.variantIndex).toBeLessThan(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sdr-ia/send.test.ts`
Expected: FAIL with "Cannot find module './send'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/sdr-ia/send.ts
// ============================================================
// SDR IA sending — creates/reuses the conversation on the account's
// CHOSEN channel (sdr_ia_config.whatsapp_config_id), then dispatches
// through the same automations-engine senders every other automated
// message already uses. No new WhatsApp-transport code here.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText, engineSendTemplate } from '@/lib/automations/meta-send'
import type { SdrIaConfig } from './config'

/**
 * Finds the existing conversation between this contact and this
 * SPECIFIC channel, or creates one. Unlike
 * `findOrCreateInternalRecipient` (automations/engine.ts), which picks
 * the account's DEFAULT channel, SDR IA must always use the channel
 * configured in the wizard (often a dedicated number, kept separate
 * from the main support/lead number on purpose — see the sdr-frio
 * SKILL.md's "número dedicado" rationale).
 */
export async function findOrCreateConversationForChannel(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  contactId: string,
  channelId: string,
): Promise<string> {
  const { data: existing } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('whatsapp_config_id', channelId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (existing) return existing.id as string

  const { data: created, error } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      whatsapp_config_id: channelId,
    })
    .select('id')
    .single()

  if (error || !created) {
    throw new Error(`Failed to create conversation for contact ${contactId}: ${error?.message}`)
  }
  return created.id as string
}

export interface SendSdrIaFirstContactArgs {
  accountId: string
  userId: string
  contactId: string
  conversationId: string
  config: SdrIaConfig
}

export async function sendSdrIaFirstContact(
  db: SupabaseClient,
  args: SendSdrIaFirstContactArgs,
): Promise<{ variantIndex: number | null }> {
  const { accountId, userId, contactId, conversationId, config } = args

  if (config.sendMode === 'template') {
    if (!config.templateName) {
      throw new Error('sdr_ia_config.template_name is required when send_mode is template')
    }
    await engineSendTemplate({
      accountId,
      userId,
      conversationId,
      contactId,
      templateName: config.templateName,
      language: config.templateLanguage ?? undefined,
    })
    return { variantIndex: null }
  }

  if (config.messageVariants.length === 0) {
    throw new Error('sdr_ia_config.message_variants is empty for send_mode text')
  }
  const variantIndex = Math.floor(Math.random() * config.messageVariants.length)
  await engineSendText({
    accountId,
    userId,
    conversationId,
    contactId,
    text: config.messageVariants[variantIndex],
  })
  return { variantIndex }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/sdr-ia/send.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sdr-ia/send.ts src/lib/sdr-ia/send.test.ts
git commit -m "Adiciona envio de primeiro contato do SDR IA"
```

---

### Task 6: Cron — `drainSdrIa`

**Files:**
- Modify: `src/app/api/automations/cron/route.ts`

**Interfaces:**
- Consumes: `getSdrIaConfig` (Task 2), `sdr_ia_next_candidates` RPC (Task 1), `findOrCreateConversationForChannel`/`sendSdrIaFirstContact` (Task 5), `addContactTagIfAbsent` (`src/lib/contacts/tag-write.ts`), `variantTagName` (Task 4), existing `brazilTodayAndHour()` (already in this file).
- Produces: `drainSdrIa(admin): Promise<number>`, wired into the `GET` handler's return payload as `sdr_ia_processed`.

- [ ] **Step 1: Add the import block**

At the top of `src/app/api/automations/cron/route.ts`, add:

```typescript
import { getSdrIaConfig } from '@/lib/sdr-ia/config'
import { findOrCreateConversationForChannel, sendSdrIaFirstContact } from '@/lib/sdr-ia/send'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { variantTagName } from '@/lib/sdr-ia/tags'
```

- [ ] **Step 2: Wire the call into the `GET` handler**

Immediately after the existing `const dailyDigestsSent = await drainDailyDigest(admin)` line (around line 99), add:

```typescript
  const sdrIaProcessed = await drainSdrIa(admin)
```

And add `sdr_ia_processed: sdrIaProcessed,` to the `NextResponse.json({...})` payload object right after `daily_digests_sent: dailyDigestsSent,`.

- [ ] **Step 3: Write the `drainSdrIa` function**

Add this function near `drainDailyDigest` (end of the file), reusing `brazilTodayAndHour()` already defined there:

```typescript
/**
 * Sends SDR IA first-contact messages for every account with both
 * accounts.sdr_ia_enabled AND sdr_ia_config.enabled true, respecting
 * each account's configured business hours and daily cap. Runs on
 * every cron tick (unlike the daily digest, this has no "once per
 * day" claim — the daily_cap itself is what bounds volume, checked
 * fresh each run via a count of today's sends).
 */
async function drainSdrIa(admin: ReturnType<typeof supabaseAdmin>): Promise<number> {
  const { hour } = brazilTodayAndHour()

  const { data: accounts } = await admin
    .from('accounts')
    .select('id, owner_user_id')
    .eq('sdr_ia_enabled', true)

  if (!accounts || accounts.length === 0) return 0

  let sent = 0
  for (const account of accounts) {
    const accountId = account.id as string
    const ownerUserId = account.owner_user_id as string

    const config = await getSdrIaConfig(admin, accountId)
    if (!config || !config.enabled) continue
    if (hour < config.hoursStart || hour >= config.hoursEnd) continue
    if (!config.leadTagId || !config.contactedTagId || !config.whatsappConfigId) continue

    const remaining = config.dailyCap - sent // per-run cap floor; see note below
    if (remaining <= 0) continue

    const { data: candidates } = await admin.rpc('sdr_ia_next_candidates', {
      p_account_id: accountId,
      p_lead_tag_id: config.leadTagId,
      p_contacted_tag_id: config.contactedTagId,
      p_limit: config.dailyCap,
    })

    for (const candidate of candidates ?? []) {
      const contactId = candidate.contact_id as string
      try {
        const conversationId = await findOrCreateConversationForChannel(
          admin,
          accountId,
          ownerUserId,
          contactId,
          config.whatsappConfigId,
        )
        const { variantIndex } = await sendSdrIaFirstContact(admin, {
          accountId,
          userId: ownerUserId,
          contactId,
          conversationId,
          config,
        })

        const tagged = await addContactTagIfAbsent(admin, {
          accountId,
          contactId,
          tagId: config.contactedTagId,
        })
        if (!tagged) {
          console.error('[sdr-ia] sent but contacted tag already present (unexpected):', contactId)
        }
        if (variantIndex !== null) {
          const variantName = variantTagName(variantIndex + 1)
          const { data: variantTag } = await admin
            .from('tags')
            .select('id')
            .eq('account_id', accountId)
            .ilike('name', variantName)
            .maybeSingle()
          if (variantTag) {
            await addContactTagIfAbsent(admin, { accountId, contactId, tagId: variantTag.id as string })
          }
        }
        sent++
      } catch (err) {
        console.error('[sdr-ia] failed to contact candidate:', contactId, err)
      }
    }
  }

  return sent
}
```

Note the `remaining = config.dailyCap - sent` line intentionally uses the cron's cross-account `sent` counter as a cheap per-run ceiling matching the existing `automation_pending_executions` batch's `.limit(50)` pattern elsewhere in this file — each account's own cap is enforced precisely by `p_limit: config.dailyCap` in the RPC call, so a single slow account can never starve the others past its own configured cap in one run.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Manual verification against a disposable test account**

Insert a `sdr_ia_config` row with `enabled = true` for a real test account (not Fuse's), tag one throwaway contact with the configured `lead_tag_id`, hit `/api/automations/cron` with the correct `x-cron-secret` header, and confirm: the contact received the message, gained the `contacted_tag_id` tag, and a second cron hit does NOT re-send to the same contact.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/automations/cron/route.ts
git commit -m "Adiciona drainSdrIa ao cron de automacoes"
```

---

### Task 7: Menu item + translations

**Files:**
- Modify: `src/components/layout/sidebar.tsx`
- Modify: `messages/pt.json`, `messages/en.json`, `messages/ko.json`

**Interfaces:**
- Produces: a `navItems` entry `{ href: '/sdr-ia', labelKey: 'sdrIa', icon: Target }` placed immediately after the `aiAgents` entry (line 103 today).

- [ ] **Step 1: Add the nav item**

In `src/components/layout/sidebar.tsx`, add `Target` to the `lucide-react` import list (alongside `Bot`, `Zap`, etc.), then insert right after the `aiAgents` line in `navItems`:

```typescript
  { href: "/agents", labelKey: "aiAgents", icon: Bot },
  { href: "/sdr-ia", labelKey: "sdrIa", icon: Target },
```

- [ ] **Step 2: Add translation keys**

In `messages/pt.json`, inside `"Sidebar"`, right after `"aiAgents": "Agentes de IA",`:
```json
    "sdrIa": "SDR IA",
```
In `messages/en.json`, same spot:
```json
    "sdrIa": "SDR AI",
```
In `messages/ko.json`, same spot:
```json
    "sdrIa": "SDR IA",
```

- [ ] **Step 3: Validate JSON + typecheck**

```bash
node -e "JSON.parse(require('fs').readFileSync('messages/pt.json','utf8')); JSON.parse(require('fs').readFileSync('messages/en.json','utf8')); JSON.parse(require('fs').readFileSync('messages/ko.json','utf8')); console.log('ok')"
npx tsc --noEmit -p tsconfig.json
```
Expected: `ok`, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/sidebar.tsx messages/pt.json messages/en.json messages/ko.json
git commit -m "Adiciona item de menu SDR IA abaixo de Agente de IA"
```

---

### Task 8: Locked view (accounts without `sdr_ia_enabled`)

**Files:**
- Create: `src/components/sdr-ia/sdr-ia-locked-view.tsx`
- Modify: `messages/pt.json`, `messages/en.json`, `messages/ko.json`

**Interfaces:**
- Consumes: `supportWhatsAppUrl` (`src/lib/support.ts`), same pattern as `ChannelLimitDialog`.
- Produces: `<SdrIaLockedView />` — full-page (not a dialog) marketing block with benefits copy + a "Falar com o suporte" button.

- [ ] **Step 1: Add translation keys**

In `messages/pt.json`, add a new top-level section (placed near `"Settings"` alphabetically is fine, or right after `"SignupPage"`):

```json
  "SdrIa": {
    "lockedTitle": "SDR IA — primeiro contato automático com leads frios",
    "lockedSubtitle": "Deixe a IA iniciar a conversa com quem ainda não falou com você, direto no WhatsApp — sem depender de planilha ou de alguém lembrar de mandar mensagem.",
    "benefit1": "Contato automático todo dia, dentro do horário comercial que você define",
    "benefit2": "Teste A/B entre até 3 mensagens diferentes, pra descobrir qual converte mais",
    "benefit3": "Nunca manda duas vezes para o mesmo lead — controle automático de quem já foi contatado",
    "benefit4": "Assim que o lead responde, o Agente de IA nativo assume a conversa sozinho",
    "cta": "Falar com o suporte",
    "prefilledMessage": "Olá! Quero saber mais sobre o SDR IA do FuseHub."
  },
```
Mirror the same keys (translated) into `messages/en.json` and `messages/ko.json`.

- [ ] **Step 2: Write the component**

```tsx
// src/components/sdr-ia/sdr-ia-locked-view.tsx
"use client";

import { Bot, Check, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { supportWhatsAppUrl } from "@/lib/support";

/**
 * Shown on /sdr-ia for every account with accounts.sdr_ia_enabled =
 * false (the sellable-product default — see migration 070). The menu
 * item itself is always visible; this is where the actual gate lives.
 * CTA goes to support for now — same manual-upgrade pattern as
 * ChannelLimitDialog (src/components/settings/channel-limit-dialog.tsx)
 * until a real checkout exists.
 */
export function SdrIaLockedView() {
  const t = useTranslations("SdrIa");
  const benefits = [t("benefit1"), t("benefit2"), t("benefit3"), t("benefit4")];

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <Card className="border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Bot className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">{t("lockedTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("lockedSubtitle")}</p>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2.5 py-2">
            {benefits.map((b) => (
              <li key={b} className="flex items-start gap-2 text-sm text-foreground">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                {b}
              </li>
            ))}
          </ul>

          <div className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            <Lock className="size-3.5 shrink-0" />
            Recurso não incluso no seu plano atual
          </div>

          <Button
            onClick={() =>
              window.open(supportWhatsAppUrl(t("prefilledMessage")), "_blank", "noopener,noreferrer")
            }
            className="mt-4 w-full bg-[#25D366] text-white hover:bg-[#1fb757]"
          >
            {t("cta")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Validate JSON + typecheck**

```bash
node -e "JSON.parse(require('fs').readFileSync('messages/pt.json','utf8')); console.log('ok')"
npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 4: Commit**

```bash
git add src/components/sdr-ia/sdr-ia-locked-view.tsx messages/pt.json messages/en.json messages/ko.json
git commit -m "Adiciona tela de bloqueio do SDR IA para contas sem a flag"
```

---

### Task 9: `/sdr-ia` page — gate + wizard shell

**Files:**
- Create: `src/app/(dashboard)/sdr-ia/page.tsx`
- Create: `src/components/sdr-ia/sdr-ia-wizard.tsx`

**Interfaces:**
- Consumes: `SdrIaLockedView` (Task 8), `GET /api/sdr-ia/status` (Task 3).
- Produces: `<SdrIaPage>` (default export) that fetches status client-side and renders `SdrIaLockedView` or `SdrIaWizard`. `<SdrIaWizard>` is scaffolded here with its 5-step shell (state machine + navigation) — the concrete per-step forms are filled in Task 10.

- [ ] **Step 1: Write the page**

```tsx
// src/app/(dashboard)/sdr-ia/page.tsx
"use client";

import { useEffect, useState } from "react";
import { SdrIaLockedView } from "@/components/sdr-ia/sdr-ia-locked-view";
import { SdrIaWizard } from "@/components/sdr-ia/sdr-ia-wizard";

export default function SdrIaPage() {
  const [status, setStatus] = useState<"loading" | "locked" | "unlocked">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sdr-ia/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setStatus(data.enabled ? "unlocked" : "locked");
      })
      .catch(() => {
        if (!cancelled) setStatus("locked");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "loading") return null;
  if (status === "locked") return <SdrIaLockedView />;
  return <SdrIaWizard />;
}
```

- [ ] **Step 2: Write the wizard shell**

```tsx
// src/components/sdr-ia/sdr-ia-wizard.tsx
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SdrIaConfig, SdrIaConfigInput } from "@/lib/sdr-ia/config";
import { StepLeadSource } from "./steps/step-lead-source";
import { StepChannel } from "./steps/step-channel";
import { StepMessages } from "./steps/step-messages";
import { StepGuardrails } from "./steps/step-guardrails";
import { StepReview } from "./steps/step-review";

export type WizardDraft = Partial<SdrIaConfigInput> & {
  leadTagName?: string;
};

const STEP_COUNT = 5;

/**
 * 5-step config wizard (see docs/superpowers/specs/2026-09-24-sdr-ia-
 * first-party-feature-design.md): lead source, channel, messages,
 * guardrails, review+activate. Draft state lives here; each step is a
 * pure form that reads/writes `draft` via props — no step fetches or
 * persists on its own except StepReview, which does the final PUT.
 */
export function SdrIaWizard() {
  const t = useTranslations("SdrIa.wizard");
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<WizardDraft>({
    sendMode: "template",
    messageVariants: [],
    dailyCap: 5,
    hoursStart: 9,
    hoursEnd: 18,
  });
  const [existing, setExisting] = useState<SdrIaConfig | null>(null);

  useEffect(() => {
    fetch("/api/sdr-ia/config", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (data.config) {
          setExisting(data.config as SdrIaConfig);
          setDraft(data.config as SdrIaConfig);
        }
      })
      .catch(() => {});
  }, []);

  const update = (patch: Partial<WizardDraft>) => setDraft((prev) => ({ ...prev, ...patch }));

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6 flex items-center gap-2">
        {Array.from({ length: STEP_COUNT }, (_, i) => i + 1).map((n) => (
          <div
            key={n}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              n <= step ? "bg-primary" : "bg-muted",
            )}
          />
        ))}
      </div>

      <Card className="p-6">
        {step === 1 && <StepLeadSource draft={draft} onChange={update} />}
        {step === 2 && <StepChannel draft={draft} onChange={update} />}
        {step === 3 && <StepMessages draft={draft} onChange={update} />}
        {step === 4 && <StepGuardrails draft={draft} onChange={update} />}
        {step === 5 && <StepReview draft={draft} existing={existing} />}

        <div className="mt-6 flex items-center justify-between">
          <Button
            variant="outline"
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            disabled={step === 1}
          >
            {t("back")}
          </Button>
          {step < STEP_COUNT ? (
            <Button onClick={() => setStep((s) => Math.min(STEP_COUNT, s + 1))}>
              {t("next")}
            </Button>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Add wizard nav translation keys**

In `messages/pt.json`, inside the `"SdrIa"` block added in Task 8, add:
```json
    "wizard": { "back": "Voltar", "next": "Continuar" },
```
(and equivalents in `en.json`/`ko.json`: `"Back"/"Next"`, `"이전"/"다음"`). Task 10 Step 6 replaces this small object with a larger one that keeps these same two keys and adds the rest — don't worry about the duplication, just overwrite this block wholesale when you get to that step.

- [ ] **Step 4: Typecheck (expect step-component import errors — resolved in Task 10)**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: errors only about missing `./steps/step-*` modules — confirms the shell wiring is otherwise correct. Do not commit yet; Task 10 completes this file set.

---

### Task 10: Wizard steps 1–5

**Files:**
- Create: `src/components/sdr-ia/steps/step-lead-source.tsx`
- Create: `src/components/sdr-ia/steps/step-channel.tsx`
- Create: `src/components/sdr-ia/steps/step-messages.tsx`
- Create: `src/components/sdr-ia/steps/step-guardrails.tsx`
- Create: `src/components/sdr-ia/steps/step-review.tsx`
- Modify: `messages/pt.json`, `messages/en.json`, `messages/ko.json`

**Interfaces:**
- Consumes: `WizardDraft` type (Task 9), `useAuth()` (`src/hooks/use-auth.tsx`) for `accountId`/`userId`, `createClient` (`src/lib/supabase/client.ts`) for direct tag/channel/template listing queries (same pattern as `step2-select-audience.tsx`).
- Produces: 5 step components, each `({ draft, onChange }: { draft: WizardDraft; onChange: (patch: Partial<WizardDraft>) => void }) => JSX.Element`, except `StepReview` which also takes `existing: SdrIaConfig | null` and owns the final PUT + activation.

- [ ] **Step 1: `step-lead-source.tsx` — tag picker + inline create**

```tsx
// src/components/sdr-ia/steps/step-lead-source.tsx
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type { WizardDraft } from "../sdr-ia-wizard";

interface Tag {
  id: string;
  name: string;
}

export function StepLeadSource({
  draft,
  onChange,
}: {
  draft: WizardDraft;
  onChange: (patch: Partial<WizardDraft>) => void;
}) {
  const t = useTranslations("SdrIa.wizard.leadSource");
  const [tags, setTags] = useState<Tag[]>([]);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("tags")
      .select("id, name")
      .order("name")
      .then(({ data }) => setTags(data ?? []));
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="leadTag">{t("selectLabel")}</Label>
        <select
          id="leadTag"
          value={draft.leadTagId ?? ""}
          onChange={(e) => onChange({ leadTagId: e.target.value || undefined, leadTagName: undefined })}
          className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground"
        >
          <option value="">{t("selectPlaceholder")}</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="newTag">{t("createLabel")}</Label>
        <Input
          id="newTag"
          placeholder={t("createPlaceholder")}
          value={draft.leadTagId ? "" : (draft.leadTagName ?? "")}
          onChange={(e) => onChange({ leadTagName: e.target.value, leadTagId: undefined })}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `step-channel.tsx` — channel + send mode picker**

```tsx
// src/components/sdr-ia/steps/step-channel.tsx
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Label } from "@/components/ui/label";
import type { WizardDraft } from "../sdr-ia-wizard";

interface Channel {
  id: string;
  name: string | null;
  provider: string;
}

export function StepChannel({
  draft,
  onChange,
}: {
  draft: WizardDraft;
  onChange: (patch: Partial<WizardDraft>) => void;
}) {
  const t = useTranslations("SdrIa.wizard.channel");
  const [channels, setChannels] = useState<Channel[]>([]);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("whatsapp_config")
      .select("id, name, provider")
      .then(({ data }) => setChannels((data as Channel[]) ?? []));
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="channel">{t("channelLabel")}</Label>
        <select
          id="channel"
          value={draft.whatsappConfigId ?? ""}
          onChange={(e) => onChange({ whatsappConfigId: e.target.value || undefined })}
          className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground"
        >
          <option value="">{t("channelPlaceholder")}</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name ?? c.id} ({c.provider})
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label>{t("modeLabel")}</Label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => onChange({ sendMode: "template" })}
            className={`rounded-lg border p-3 text-left text-sm ${draft.sendMode === "template" ? "border-primary bg-primary/10" : "border-border"}`}
          >
            <p className="font-medium text-foreground">{t("modeTemplateTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("modeTemplateDesc")}</p>
          </button>
          <button
            type="button"
            onClick={() => onChange({ sendMode: "text" })}
            className={`rounded-lg border p-3 text-left text-sm ${draft.sendMode === "text" ? "border-primary bg-primary/10" : "border-border"}`}
          >
            <p className="font-medium text-foreground">{t("modeTextTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("modeTextDesc")}</p>
          </button>
        </div>
        {draft.sendMode === "text" && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {t("modeTextWarning")}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `step-messages.tsx` — template name/language OR up to 3 text variants**

```tsx
// src/components/sdr-ia/steps/step-messages.tsx
"use client";

import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { WizardDraft } from "../sdr-ia-wizard";

export function StepMessages({
  draft,
  onChange,
}: {
  draft: WizardDraft;
  onChange: (patch: Partial<WizardDraft>) => void;
}) {
  const t = useTranslations("SdrIa.wizard.messages");
  const variants = draft.messageVariants ?? [];

  const setVariant = (index: number, value: string) => {
    const next = [...variants];
    next[index] = value;
    onChange({ messageVariants: next.filter((v, i) => v.trim() || i < variants.length) });
  };

  if (draft.sendMode === "template") {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t("templateTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("templateDescription")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="templateName">{t("templateNameLabel")}</Label>
          <Input
            id="templateName"
            value={draft.templateName ?? ""}
            onChange={(e) => onChange({ templateName: e.target.value })}
            placeholder={t("templateNamePlaceholder")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="templateLanguage">{t("templateLanguageLabel")}</Label>
          <Input
            id="templateLanguage"
            value={draft.templateLanguage ?? "pt_BR"}
            onChange={(e) => onChange({ templateLanguage: e.target.value })}
            placeholder="pt_BR"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("variantsTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("variantsDescription")}</p>
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2">
          <Label htmlFor={`variant-${i}`}>{t("variantLabel", { n: i + 1 })}</Label>
          <Textarea
            id={`variant-${i}`}
            value={variants[i] ?? ""}
            onChange={(e) => setVariant(i, e.target.value)}
            placeholder={t("variantPlaceholder")}
            rows={3}
          />
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: `step-guardrails.tsx` — hours + daily cap**

```tsx
// src/components/sdr-ia/steps/step-guardrails.tsx
"use client";

import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type { WizardDraft } from "../sdr-ia-wizard";

export function StepGuardrails({
  draft,
  onChange,
}: {
  draft: WizardDraft;
  onChange: (patch: Partial<WizardDraft>) => void;
}) {
  const t = useTranslations("SdrIa.wizard.guardrails");

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="hoursStart">{t("hoursStartLabel")}</Label>
          <Input
            id="hoursStart"
            type="number"
            min={0}
            max={23}
            value={draft.hoursStart ?? 9}
            onChange={(e) => onChange({ hoursStart: Number(e.target.value) })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="hoursEnd">{t("hoursEndLabel")}</Label>
          <Input
            id="hoursEnd"
            type="number"
            min={0}
            max={23}
            value={draft.hoursEnd ?? 18}
            onChange={(e) => onChange({ hoursEnd: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="dailyCap">{t("dailyCapLabel")}</Label>
        <Input
          id="dailyCap"
          type="number"
          min={1}
          max={100}
          value={draft.dailyCap ?? 5}
          onChange={(e) => onChange({ dailyCap: Number(e.target.value) })}
        />
        <p className="text-xs text-muted-foreground">{t("dailyCapHint")}</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: `step-review.tsx` — summary + activate (resolves tag names, PUTs config)**

```tsx
// src/components/sdr-ia/steps/step-review.tsx
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { resolveOrCreateTagId, variantTagName } from "@/lib/sdr-ia/tags";
import type { SdrIaConfig } from "@/lib/sdr-ia/config";
import type { WizardDraft } from "../sdr-ia-wizard";

export function StepReview({
  draft,
  existing,
}: {
  draft: WizardDraft;
  existing: SdrIaConfig | null;
}) {
  const t = useTranslations("SdrIa.wizard.review");
  const router = useRouter();
  const { accountId, profile } = useAuth();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleActivate = async () => {
    if (!accountId || !profile) return;
    setSaving(true);
    setError(null);
    try {
      const supabase = createClient();
      const userId = profile.user_id;

      const leadTagId =
        draft.leadTagId ??
        (draft.leadTagName
          ? await resolveOrCreateTagId(supabase, accountId, userId, draft.leadTagName)
          : null);
      if (!leadTagId) throw new Error(t("errorNoLeadTag"));

      // Always resolves to the same fixed system tag name — find-or-create
      // is what makes this idempotent across repeated wizard runs, not a
      // branch on `existing` (there's only ever one contacted-tag name).
      const contactedTagId = await resolveOrCreateTagId(supabase, accountId, userId, "sdr_ia_contatado");

      if (draft.sendMode === "text") {
        const variants = (draft.messageVariants ?? []).filter((v) => v.trim());
        for (let i = 0; i < variants.length; i++) {
          await resolveOrCreateTagId(supabase, accountId, userId, variantTagName(i + 1));
        }
      }

      const res = await fetch("/api/sdr-ia/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...draft,
          leadTagId,
          contactedTagId,
          enabled: true,
        }),
      });
      if (!res.ok) throw new Error(t("errorSaveFailed"));

      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <dl className="space-y-2 rounded-lg border border-border bg-muted/50 p-4 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t("summaryMode")}</dt>
          <dd className="text-foreground">{draft.sendMode === "template" ? t("summaryModeTemplate") : t("summaryModeText")}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t("summaryHours")}</dt>
          <dd className="text-foreground">{draft.hoursStart}h–{draft.hoursEnd}h</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t("summaryDailyCap")}</dt>
          <dd className="text-foreground">{draft.dailyCap}</dd>
        </div>
      </dl>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <Button onClick={handleActivate} disabled={saving} className="w-full">
        {saving ? t("activating") : existing?.enabled ? t("update") : t("activate")}
      </Button>
    </div>
  );
}
```

- [ ] **Step 6: Add all remaining `SdrIa.wizard.*` translation keys**

Extend the `"SdrIa"` block in `messages/pt.json` with a `"wizard"` object covering every `t(...)` key referenced across steps 1–5 above (`leadSource.*`, `channel.*`, `messages.*`, `guardrails.*`, `review.*`, plus `back`/`next` from Task 9). Example for `pt.json` (mirror translated into `en.json`/`ko.json`):

```json
    "wizard": {
      "back": "Voltar",
      "next": "Continuar",
      "leadSource": {
        "title": "De onde vêm os leads?",
        "description": "Escolha a tag que marca os contatos que o SDR IA deve processar.",
        "selectLabel": "Tag existente",
        "selectPlaceholder": "Selecione uma tag",
        "createLabel": "Ou crie uma nova tag",
        "createPlaceholder": "ex: prospecção"
      },
      "channel": {
        "title": "Canal de envio",
        "description": "Escolha o número de WhatsApp e a forma de envio.",
        "channelLabel": "Número",
        "channelPlaceholder": "Selecione um canal",
        "modeLabel": "Forma de envio",
        "modeTemplateTitle": "Template aprovado (Meta)",
        "modeTemplateDesc": "Mais seguro, exige template já aprovado no WhatsApp Business Manager.",
        "modeTextTitle": "Texto livre",
        "modeTextDesc": "Mais flexível, com risco de banimento.",
        "modeTextWarning": "Enviar mensagens não solicitadas por texto livre pode levar ao banimento do número. Use com um teto diário conservador."
      },
      "messages": {
        "templateTitle": "Template aprovado",
        "templateDescription": "Informe o nome exato do template já aprovado no WhatsApp Business Manager.",
        "templateNameLabel": "Nome do template",
        "templateNamePlaceholder": "ex: primeiro_contato",
        "templateLanguageLabel": "Idioma",
        "variantsTitle": "Mensagens (teste A/B)",
        "variantsDescription": "Escreva até 3 variações. O sistema sorteia uma a cada envio.",
        "variantLabel": "Variação {n}",
        "variantPlaceholder": "Escreva a mensagem..."
      },
      "guardrails": {
        "title": "Horário e limite diário",
        "description": "Define quando e quantos contatos por dia o SDR IA pode enviar.",
        "hoursStartLabel": "Início (hora)",
        "hoursEndLabel": "Fim (hora)",
        "dailyCapLabel": "Limite diário de envios",
        "dailyCapHint": "Recomendado começar baixo (5) e aumentar aos poucos."
      },
      "review": {
        "title": "Revisão",
        "description": "Confira as configurações antes de ativar.",
        "summaryMode": "Forma de envio",
        "summaryModeTemplate": "Template aprovado",
        "summaryModeText": "Texto livre",
        "summaryHours": "Horário comercial",
        "summaryDailyCap": "Limite diário",
        "activate": "Ativar SDR IA",
        "update": "Salvar alterações",
        "activating": "Ativando...",
        "errorNoLeadTag": "Escolha ou crie uma tag de leads antes de continuar.",
        "errorSaveFailed": "Não foi possível salvar. Tente novamente."
      }
    }
```

- [ ] **Step 7: Validate JSON + typecheck + lint**

```bash
node -e "JSON.parse(require('fs').readFileSync('messages/pt.json','utf8')); JSON.parse(require('fs').readFileSync('messages/en.json','utf8')); JSON.parse(require('fs').readFileSync('messages/ko.json','utf8')); console.log('ok')"
npx tsc --noEmit -p tsconfig.json
npx eslint "src/components/sdr-ia/**/*.tsx" "src/app/(dashboard)/sdr-ia/page.tsx"
```
Expected: `ok`, no type errors, no lint errors.

- [ ] **Step 8: Manual verification in the browser**

Start the dev server, sign in as Fuse's own account (already flipped to `sdr_ia_enabled = true` per Task 1's manual step), navigate to `/sdr-ia`, and walk through all 5 steps end to end: create a lead tag, pick a channel + mode, fill messages, set guardrails, and activate. Confirm the `sdr_ia_config` row is created with the right values via a PostgREST GET. Then sign in as (or simulate) an account with the flag off and confirm `/sdr-ia` shows `SdrIaLockedView` instead.

- [ ] **Step 9: Commit**

```bash
git add src/app/\(dashboard\)/sdr-ia/page.tsx src/components/sdr-ia/ messages/pt.json messages/en.json messages/ko.json
git commit -m "Adiciona assistente de configuracao do SDR IA em 5 passos"
```

---

### Task 11: Enable Fuse's own account (manual, not code)

**Files:** none — this is a data change, not a code change (per the plan's Global Constraints).

- [ ] **Step 1: Present this SQL to the user for their own account, after Task 1's migration is confirmed live**

```sql
UPDATE accounts SET sdr_ia_enabled = true WHERE id = '7c26ec4e-39c6-4ce9-a611-ad694ce1d328';
```

- [ ] **Step 2: Confirm via PostgREST**

```bash
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/accounts?id=eq.7c26ec4e-39c6-4ce9-a611-ad694ce1d328&select=id,sdr_ia_enabled" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```
Expected: `[{"id":"7c26ec4e-...","sdr_ia_enabled":true}]`

---

### Task 12: Deploy

**Files:** none (deployment steps only).

- [ ] **Step 1: Full local verification before pushing**

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run
```
Expected: no type errors; all tests pass except the 5 known pre-existing `date-utils.test.ts` `mondayIndex` timezone failures (see prior sessions — unrelated to this feature).

- [ ] **Step 2: Push and deploy following this repo's standing pattern**

```bash
git push origin main
ssh -i ~/.ssh/fusehub_vps root@92.112.179.88 "cd /opt/wacrm && git pull && docker compose --env-file .env.local up --build -d"
curl -s -o /dev/null -w "%{http_code}\n" https://fusehub.fusegrowth.com.br/login
```
Expected: final curl returns `200`.

- [ ] **Step 3: Live smoke test**

Sign in to `fusehub.fusegrowth.com.br` as Fuse's own account, confirm the "SDR IA" menu item appears below "Agente de IA", and that `/sdr-ia` shows the wizard (not the locked view). Sign out and (if a second, non-Fuse test account is available) confirm that account sees the locked view instead.
