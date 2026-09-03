-- ============================================================
-- 061_stage_entry_notify
--
-- WhatsApp alert to a configured phone whenever an open deal enters a
-- given stage (e.g. "avisar a vendedora toda vez que um lead cair em
-- Novo Lead") -- there was no automation trigger for "a deal reached
-- stage X" before this (every existing trigger is message/conversation
-- centric), so this is a dedicated mechanism, not a new automation
-- step.
--
-- `notify_phone` lives on the stage (an admin sets it once in Pipeline
-- settings, mirrors `stale_after_days`, migration 056). `deals.
-- stage_notify_sent_at` is the dedupe guard -- compared against
-- `stage_entered_at` (migration 056) rather than nulled out on every
-- stage change: a deal re-entering a notify-configured stage later
-- naturally re-arms the alert the moment `stage_entered_at` moves past
-- the last `stage_notify_sent_at`, with no extra trigger needed to
-- reset it.
--
-- Idempotent -- safe to run multiple times.
-- ============================================================

ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS notify_phone TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS stage_notify_sent_at TIMESTAMPTZ;
