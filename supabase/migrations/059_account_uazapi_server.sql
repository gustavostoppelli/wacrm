-- ============================================================
-- 059_account_uazapi_server
--
-- Saves the account's UAZAPI server credentials (base_url + admin
-- token) ONCE, on the account itself, instead of asking for them
-- again on every new channel. Before this, adding a second WhatsApp
-- number (e.g. a new salesperson) meant the account admin had to hand
-- their UAZAPI admin token to whoever was connecting the new channel
-- -- a credential that can create/delete ANY instance on that server,
-- not just the one being added.
--
-- `uazapi_admin_token` is encrypted at rest (same convention as every
-- other token column — see src/lib/whatsapp/encryption.ts). Nullable:
-- an account that hasn't set this up yet just gets prompted once, the
-- first time anyone tries to add a UAZAPI channel.
--
-- Idempotent -- safe to run multiple times.
-- ============================================================

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS uazapi_admin_base_url TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS uazapi_admin_token TEXT;
