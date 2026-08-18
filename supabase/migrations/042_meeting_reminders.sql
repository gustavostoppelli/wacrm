-- ============================================================
-- 042_meeting_reminders
--
-- Automatic attendance-confirmation reminders for a scheduled
-- meeting: one the day before (adjusted into business hours) and one
-- exactly an hour before. Drained by the same /api/automations/cron
-- pinger as everything else scheduled (migrations 040, 041). Native
-- to any FuseHub account — nothing Fuse-specific here.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS meeting_reminders_enabled BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS deal_meeting_reminders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Passed through to engineSendText's audit columns when the cron
  -- sends the reminder -- mirrors ai_pending_replies (migration 040).
  config_owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('day_before', 'hour_before')),
  send_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One of each kind per deal. Rescheduling deletes+reinserts (see
  -- src/lib/ai/auto-reply.ts) rather than relying on this for updates.
  UNIQUE(deal_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_deal_meeting_reminders_due
  ON deal_meeting_reminders(send_at) WHERE sent_at IS NULL;

ALTER TABLE deal_meeting_reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_meeting_reminders_select ON deal_meeting_reminders;
CREATE POLICY deal_meeting_reminders_select ON deal_meeting_reminders
  FOR SELECT USING (is_account_member(account_id));
