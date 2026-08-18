-- ============================================================
-- 043_meeting_link
--
-- Once a meeting time AND the lead's email are both confirmed, and
-- the account has Google Calendar connected (migration 039), the AI
-- Agent creates a real calendar event and stores the Meet link here
-- so it can be sent to the lead and included in the reminders
-- (migration 042). Native -- inert for any account without Calendar
-- connected, no behavior change for them.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE deals ADD COLUMN IF NOT EXISTS meeting_link TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS calendar_event_id TEXT;
