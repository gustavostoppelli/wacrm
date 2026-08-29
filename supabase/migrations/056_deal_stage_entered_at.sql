-- ============================================================
-- 056_deal_stage_entered_at
--
-- Stamps `deals.stage_entered_at` -- when the deal entered its
-- CURRENT stage -- directly on the row, so any existing `select("*")`
-- picks it up for free (same reasoning as `closed_at`, 047). Backs a
-- per-deal "how long has this been sitting here" indicator: a Kanban
-- card badge and a "stuck deals" report, both driven by this column
-- instead of a live join against `deal_stage_history` on every board
-- load.
--
-- `pipeline_stages.stale_after_days` is the per-stage alert
-- threshold an account can configure (e.g. "flag anything sitting in
-- Novo Lead for more than 2 days") -- null means no alert coloring
-- for that stage, just the plain day count.
--
-- Captured at the DB level (a BEFORE trigger, mirroring
-- deal_set_closed_at) so it stays correct no matter how the stage
-- changes -- a Kanban drag, a bulk edit, an import, a future API path.
-- Uses the same NOW() as the existing deal_log_stage_change AFTER
-- trigger (047) since both fire within the same statement's
-- transaction, so this column and deal_stage_history.entered_at for
-- the same transition always agree.
--
-- Idempotent -- safe to run multiple times.
-- ============================================================

ALTER TABLE deals ADD COLUMN IF NOT EXISTS stage_entered_at TIMESTAMPTZ;
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS stale_after_days INTEGER;

-- Backfill: current stage's entry time = the most recent
-- deal_stage_history row for that deal (its last stage transition,
-- i.e. entry into the stage it's sitting in right now).
UPDATE deals d
SET stage_entered_at = h.entered_at
FROM (
  SELECT DISTINCT ON (deal_id) deal_id, entered_at
  FROM deal_stage_history
  ORDER BY deal_id, entered_at DESC
) h
WHERE h.deal_id = d.id AND d.stage_entered_at IS NULL;

-- Fallback for the rare deal with no history row at all (shouldn't
-- happen given 047's own backfill, but keeps this migration safe to
-- run against any state).
UPDATE deals SET stage_entered_at = created_at WHERE stage_entered_at IS NULL;

CREATE OR REPLACE FUNCTION deal_set_stage_entered_at() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.stage_entered_at := NEW.created_at;
  ELSIF TG_OP = 'UPDATE' AND NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    NEW.stage_entered_at := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deal_set_stage_entered_at ON deals;
CREATE TRIGGER trg_deal_set_stage_entered_at
  BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION deal_set_stage_entered_at();
