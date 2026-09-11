-- Daily WhatsApp activity digest — per-account opt-in config, sent at
-- ~18:00 America/Sao_Paulo by the existing cron poller (see
-- drainDailyDigest in src/app/api/automations/cron/route.ts). Summarizes
-- that day's first-contacts/follow-ups/deals-closed per rep (same
-- metrics as the Dashboard/Reports "Rep activity" widget) plus
-- month-to-date totals.
--
-- Configured in Settings → Notifications, never a hardcoded phone
-- number or account id — every account of the sellable product can
-- turn this on independently.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS daily_digest_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS daily_digest_phones TEXT,
  ADD COLUMN IF NOT EXISTS daily_digest_last_sent_date DATE,
  ADD COLUMN IF NOT EXISTS daily_digest_group_jid TEXT;

COMMENT ON COLUMN accounts.daily_digest_enabled IS
  'Whether the daily WhatsApp activity digest is turned on for this account.';
COMMENT ON COLUMN accounts.daily_digest_phones IS
  'Comma-separated phone numbers that receive the daily digest.';
COMMENT ON COLUMN accounts.daily_digest_last_sent_date IS
  'Local (America/Sao_Paulo) calendar date the digest was last sent — dedup guard so the 5-minute cron poll sends at most once per day.';
COMMENT ON COLUMN accounts.daily_digest_group_jid IS
  'Optional WhatsApp group (e.g. "1203...@g.us") that also receives the daily digest, picked from GET /api/uazapi/groups. UAZAPI-only — sent via a raw provider call, not the contact/conversation pipeline individual phones use.';
