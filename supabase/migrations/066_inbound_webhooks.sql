-- ============================================================
-- 066_inbound_webhooks.sql — Generic inbound webhook connections
--
-- Lets an account create its own named webhook receiver URL to paste
-- into an external tool's own webhook/postback settings (a checkout
-- platform notifying "sale approved", a form tool notifying "new
-- submission", etc.) — the mirror image of `webhook_endpoints`
-- (migration 028), which is FuseHub pushing events OUT. Deliberately
-- provider-agnostic: no column or UI names a specific external tool,
-- so the same feature serves whichever platform the account uses
-- today or switches to later, with the account naming each connection
-- themselves (see AGENTS.md "Per-account feature flags" for the same
-- no-hardcoding rationale applied here to naming).
--
-- The receiving route (POST /api/webhooks/inbound/[id]) has no
-- signed-in user, so `token_hash` follows `api_keys.key_hash`'s
-- pattern: only the SHA-256 hash is stored, the plaintext token is
-- shown to the creator exactly once, folded into the URL's `?token=`
-- query param. `pipeline_id`/`stage_id` are picked at creation time
-- (not left to default to "whatever the first stage is") so a new
-- lead from this connection always lands exactly where the account
-- decided when they set it up.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS inbound_webhooks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Owner stamped on contacts/deals this connection creates — mirrors
  -- configOwnerUserId's role elsewhere (e.g. inbound-message.ts).
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name             text NOT NULL,
  token_hash       text NOT NULL UNIQUE,
  pipeline_id      uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  stage_id         uuid NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
  is_active        boolean NOT NULL DEFAULT true,
  last_received_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbound_webhooks_account_id_idx
  ON inbound_webhooks (account_id);

-- Hot path: the receiving route looks up by id (from the URL path)
-- then verifies token_hash — the UNIQUE constraint already indexes
-- this, spelled out for the same documentation reason as api_keys.
CREATE INDEX IF NOT EXISTS inbound_webhooks_token_hash_idx
  ON inbound_webhooks (token_hash);

ALTER TABLE inbound_webhooks ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+) can see the roster —
-- token_hash is in the table but the dashboard never selects it.
DROP POLICY IF EXISTS inbound_webhooks_select ON inbound_webhooks;
CREATE POLICY inbound_webhooks_select ON inbound_webhooks FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: admin+ only (settings-class, mirrors
-- webhook_endpoints and api_keys).
DROP POLICY IF EXISTS inbound_webhooks_insert ON inbound_webhooks;
CREATE POLICY inbound_webhooks_insert ON inbound_webhooks FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS inbound_webhooks_update ON inbound_webhooks;
CREATE POLICY inbound_webhooks_update ON inbound_webhooks FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS inbound_webhooks_delete ON inbound_webhooks;
CREATE POLICY inbound_webhooks_delete ON inbound_webhooks FOR DELETE
  USING (is_account_member(account_id, 'admin'));
