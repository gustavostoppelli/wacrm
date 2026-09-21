-- Per-account cap on how many WhatsApp channels (any provider) an
-- account may connect. Defaults to 1 — every new signup of the
-- sellable product starts on a single number; raising a specific
-- account's limit (after they pay for extra numbers, today handled
-- manually — see accounts.daily_digest_* etc. for the same
-- one-column-per-account-setting convention) is a plain SQL UPDATE on
-- that one row, never a code change. Never exposed in the customer's
-- own Settings UI — only the account owner (Fuse) raises it.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS whatsapp_channel_limit INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN accounts.whatsapp_channel_limit IS
  'Max whatsapp_config rows (any provider) this account may create. Default 1 for the sellable product baseline plan; raised per-account via direct SQL once a customer pays for more numbers.';
