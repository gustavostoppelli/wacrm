-- ============================================================
-- 037_whatsapp_channels
--
-- Foundation for multiple WhatsApp channels per account (Meta Cloud
-- API today, UAZAPI — an unofficial QR-code-based provider — next).
--
-- Today `whatsapp_config` has UNIQUE(account_id) (migration 017): one
-- WhatsApp number per account, period. `conversations` has no channel
-- dimension at all (migration 036's UNIQUE(account_id, contact_id)
-- assumes exactly one thread per contact). Both assumptions break once
-- an account can connect more than one number/provider.
--
-- This migration only lays the schema groundwork:
--   1. Drop the one-channel-per-account constraint on whatsapp_config.
--   2. Add `provider` + provider-specific columns so a row can describe
--      either a Meta or a UAZAPI channel.
--   3. Make the Meta-only columns nullable, guarded by a CHECK so a row
--      can't be saved half-configured for its declared provider.
--   4. Give `conversations` a `whatsapp_config_id` so a contact who
--      talks to two channels gets two separate threads, and update the
--      036 unique index to include it.
--
-- No application code changes ship in this migration — every existing
-- account has exactly one whatsapp_config row today, so the backfill
-- below is 1:1 and every existing call site keeps working unchanged
-- until the provider-abstraction refactor lands on top of this schema.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1) Remove the one-channel-per-account constraint.
ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

-- 2) Provider + provider-specific columns.
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_check
      CHECK (provider IN ('meta', 'uazapi'));
  END IF;
END $$;

-- User-facing label for the channel (e.g. "Vendas"). Only meaningful
-- once an account can have more than one; nullable so existing single-
-- channel accounts don't need one.
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS name TEXT;

-- UAZAPI-specific credentials. `uazapi_instance_token` is cifrado at
-- rest via the same encrypt()/decrypt() convention as access_token.
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS uazapi_base_url TEXT;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS uazapi_instance_token TEXT;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS uazapi_instance_id TEXT;
-- Random per-channel secret appended as a query param on the webhook
-- URL we register with UAZAPI (`/api/uazapi/webhook?ch=<id>&key=<secret>`).
-- UAZAPI's inbound webhook POST carries no signature to verify (unlike
-- Meta's HMAC), so this is the tamper-resistance backstop — the
-- webhook route 401s any request whose `key` doesn't match.
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS uazapi_webhook_secret TEXT;

-- 3) Meta's phone_number_id / access_token are no longer universally
--    required — a UAZAPI row won't have them. Guard the relaxation
--    with a CHECK so a row still can't be saved half-configured for
--    whichever provider it declares.
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_fields_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_fields_check
      CHECK (
        (provider = 'meta' AND phone_number_id IS NOT NULL AND access_token IS NOT NULL)
        OR
        (provider = 'uazapi' AND uazapi_base_url IS NOT NULL AND uazapi_instance_token IS NOT NULL)
      );
  END IF;
END $$;

-- 4) conversations: which channel this thread belongs to.
--    ON DELETE SET NULL — deleting a channel must not cascade-delete
--    conversation history; resolve-channel.ts falls back to "the
--    account's only channel" for rows where this is null.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;

-- Backfill: every existing account has at most one whatsapp_config row
-- today, so this is a safe 1:1 assignment.
UPDATE conversations c
SET whatsapp_config_id = (
  SELECT w.id FROM whatsapp_config w WHERE w.account_id = c.account_id LIMIT 1
)
WHERE whatsapp_config_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config ON conversations(whatsapp_config_id);

-- Replace 036's UNIQUE(account_id, contact_id) with one that includes
-- the channel — a contact can now have one thread per channel instead
-- of exactly one thread per account.
DROP INDEX IF EXISTS idx_conversations_account_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_channel
  ON conversations (account_id, contact_id, whatsapp_config_id);
