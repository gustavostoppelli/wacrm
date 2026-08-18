-- ============================================================
-- 045_meeting_event_label
--
-- Lets an account set what goes at the front of a Google Calendar
-- event title the AI Agent creates (e.g. "Diagnóstico Fuse"). Falls
-- back to a generic "Diagnóstico" when unset. accounts.name usually
-- holds the owner's personal name, not a brand name, so it isn't a
-- reliable source for this -- this is a small, explicit setting
-- instead. Native/configurable, not hardcoded to any one account.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS meeting_event_label TEXT;
