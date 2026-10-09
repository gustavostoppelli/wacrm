-- ============================================================
-- 080_account_default_phone_country
--
-- Per-account default country for phone numbers that arrive WITHOUT a
-- country code (checkout webhooks send e.g. "34991623419" = DDD + number).
-- Until now the inbound webhook completed such numbers with Brazil's "55"
-- for every account. The column keeps that as the default ('BR') so
-- nothing changes for existing accounts, while an account outside Brazil
-- can pick its own country (see src/lib/phone/default-country.ts).
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS default_phone_country TEXT NOT NULL DEFAULT 'BR';
