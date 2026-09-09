-- Generic per-account feature-flags column. First consumer: opting an
-- account into capturing WhatsApp messages a rep sends manually from
-- their own phone (not through the CRM) into the conversation thread,
-- instead of silently dropping them (see the `fromMe` guard in
-- src/app/api/uazapi/webhook/route.ts) — flag key
-- "capture_manual_wa_replies".
--
-- Deliberately a single JSONB column rather than one boolean column
-- per feature: this is the sellable product's per-tenant escape hatch
-- for anything that should be opt-in rather than universal (see the
-- "Per-account feature flags" convention in AGENTS.md) — a dedicated
-- ALTER TABLE for every future toggle doesn't scale once there are
-- several customer accounts each wanting different combinations.
-- Empty object default means every account (including every future
-- customer of the sellable product) behaves exactly as before unless
-- a flag is explicitly set true on its row.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS feature_flags JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN accounts.feature_flags IS
  'Per-account opt-in feature toggles, e.g. {"capture_manual_wa_replies": true}. Absent/false key = default (old) behavior. Set directly via SQL, never hardcoded by account id in application code — see AGENTS.md "Per-account feature flags".';
