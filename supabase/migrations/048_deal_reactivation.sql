-- ============================================================
-- 048_deal_reactivation
--
-- Native, opt-in re-engagement for deals marked "lost". Off by
-- default (an account turns it on in Settings) -- same shape as
-- meeting_reminders_enabled (042) and followup_enabled (044).
--
-- `reactivation_message` is free text with a `{{nome}}` placeholder,
-- not a hardcoded string -- any account customizes its own wording
-- (or leaves it blank for a generic fallback baked into the code).
--
-- `deals.reactivation_sent_at` is the per-deal dedupe guard (send at
-- most once) and, like `closed_at` (047), doubles as an audit trail.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS reactivation_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS reactivation_days INTEGER NOT NULL DEFAULT 90;
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS reactivation_message TEXT;

ALTER TABLE deals ADD COLUMN IF NOT EXISTS reactivation_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_deals_reactivation_candidates
  ON deals(account_id, status, closed_at)
  WHERE status = 'lost' AND reactivation_sent_at IS NULL;
