-- ============================================================
-- 076_whatsapp_enabled.sql — WhatsApp as a gated, per-account feature
--
-- Same one-column-per-account-setting convention as
-- accounts.sdr_ia_enabled (migration 070) and accounts.instagram_enabled
-- (migration 075): a locked marketing view vs. the real config UI,
-- flipped per-account via direct SQL once a customer pays.
--
-- UNLIKE those two, WhatsApp is not a brand-new feature nobody has
-- used yet — it's the product's core, already live for every existing
-- paying account. Defaulting every row to false here would lock every
-- current client out of a channel they already depend on. So this
-- migration backfills whatsapp_enabled = true for any account that
-- already has at least one whatsapp_config row (Meta or UAZAPI) —
-- only brand-new accounts (no channel yet) start locked.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS whatsapp_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN accounts.whatsapp_enabled IS
  'Whether this account can access WhatsApp channel setup (official Meta API + UAZAPI). Backfilled true for accounts with an existing whatsapp_config row (migration 076); false by default for new accounts, flipped per-account via direct SQL once a customer pays. When flipping to true for a new UAZAPI client, also set accounts.uazapi_admin_base_url/uazapi_admin_token (copy from an existing account) so the client only ever sees the QR-code connect step, never the shared server/token form.';

UPDATE accounts
SET whatsapp_enabled = true
WHERE whatsapp_enabled = false
  AND EXISTS (
    SELECT 1 FROM whatsapp_config
    WHERE whatsapp_config.account_id = accounts.id
  );
