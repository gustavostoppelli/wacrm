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

ALTER TABLE instagram_webhook_events ENABLE ROW LEVEL SECURITY;
-- No policies — only the service-role webhook handler ever touches
-- this table, same rationale as asaas_processed_subscriptions (migration 069).
