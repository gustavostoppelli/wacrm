-- ============================================================
-- 052_deal_close_date_alert
--
-- Alerts the deal owner when an open deal's expected_close_date
-- arrives or has passed -- "time to close this" / "this is overdue".
-- Reuses the notifications table (027) + its existing realtime/
-- unread-badge wiring, same delivery mechanism as task_due (050).
--
-- Idempotent -- safe to run multiple times.
-- ============================================================

-- Dedupe guard for the cron drain, mirroring reactivation_sent_at
-- (048) / reminder_sent_at (050) -- set once, never re-alerted for
-- the same close date. The deal form resets this to NULL whenever
-- expected_close_date actually changes, so pushing the date out (or
-- setting a new one after the last alert fired) re-arms the alert.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS close_date_alert_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_deals_close_date_alert_candidates
  ON deals(expected_close_date)
  WHERE status = 'open' AND expected_close_date IS NOT NULL AND close_date_alert_sent_at IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notifications_type_check' AND conrelid = 'notifications'::regclass
  ) THEN
    ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
  END IF;
  ALTER TABLE notifications
    ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('conversation_assigned', 'task_due', 'deal_close_due'));
END $$;
