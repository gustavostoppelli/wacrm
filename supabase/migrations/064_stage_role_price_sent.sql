-- Extends `pipeline_stages.stage_role` (migration 041) with a second
-- value: 'price_sent'. Marks the stage where a deal's price/proposal
-- has already been communicated to the lead — used to distinguish a
-- "first contact" message from a "follow-up" message in the Reports
-- today-activity ranking (a follow-up is any agent message sent while
-- the deal sits in this stage, or any stage after it, in the same
-- pipeline). Admin-configurable per stage in Pipeline Settings, never
-- a hardcoded stage-name match — works the same for any account of
-- the sellable product regardless of what they call their columns.
ALTER TABLE pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_stage_role_check;
ALTER TABLE pipeline_stages
  ADD CONSTRAINT pipeline_stages_stage_role_check
  CHECK (stage_role IS NULL OR stage_role IN ('meeting_scheduled', 'price_sent'));
