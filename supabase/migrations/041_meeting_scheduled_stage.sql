-- ============================================================
-- 041_meeting_scheduled_stage
--
-- Lets a pipeline stage be tagged as "this is where a deal lands once
-- a real meeting time is confirmed" — the AI Agent uses this to move
-- a deal there automatically when it hands off a lead who just agreed
-- on a time, instead of a human having to drag the card manually.
-- Generic/native: any account's pipeline can have one such stage;
-- nothing here is Fuse-specific.
--
-- Also gives deals a place to carry the confirmed meeting time so it
-- can be surfaced prominently on the kanban card.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS stage_role TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pipeline_stages_stage_role_check'
      AND conrelid = 'pipeline_stages'::regclass
  ) THEN
    ALTER TABLE pipeline_stages
      ADD CONSTRAINT pipeline_stages_stage_role_check
      CHECK (stage_role IS NULL OR stage_role = 'meeting_scheduled');
  END IF;
END $$;

-- At most one "meeting_scheduled" stage per pipeline, so the AI Agent
-- never has to guess which one to use.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_stages_one_meeting_role
  ON pipeline_stages(pipeline_id) WHERE stage_role = 'meeting_scheduled';

ALTER TABLE deals ADD COLUMN IF NOT EXISTS meeting_scheduled_at TIMESTAMPTZ;
-- Free-text description of the agreed time (e.g. "Amanhã às 10h") --
-- the AI writes this from the conversation; not every account will
-- have (or need) a parsed, sortable timestamp to go with it.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS meeting_note TEXT;

-- Convenience backfill: if this account already has a stage literally
-- named "Reunião Agendada" (created earlier this session) and no
-- pipeline in the account has a meeting_scheduled stage yet, tag it.
-- Harmless no-op for any pipeline that doesn't have a same-named
-- stage -- an admin can wire a differently-named stage manually via
-- a future stage-settings UI.
UPDATE pipeline_stages ps
SET stage_role = 'meeting_scheduled'
WHERE ps.name = 'Reunião Agendada'
  AND NOT EXISTS (
    SELECT 1 FROM pipeline_stages ps2
    WHERE ps2.pipeline_id = ps.pipeline_id
      AND ps2.stage_role = 'meeting_scheduled'
  );
