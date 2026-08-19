-- ============================================================
-- 047_deal_stage_history
--
-- Logs every time a deal enters a pipeline stage, and stamps
-- `deals.closed_at` when a deal is won/lost. Together these back the
-- Reports page's "time to close" and "time per stage" metrics.
--
-- Captured at the DB level (a trigger on `deals`, not app code) so it
-- keeps working no matter how a deal's stage changes -- a card
-- dragged on the Kanban, a bulk edit, an import, a future API path --
-- same "native regardless of how it happens" reasoning as
-- `ensureDealForContact` (src/lib/whatsapp/inbound-message.ts).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE deals ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS deal_stage_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  stage_id UUID NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deal_stage_history_deal ON deal_stage_history(deal_id, entered_at);
CREATE INDEX IF NOT EXISTS idx_deal_stage_history_stage ON deal_stage_history(stage_id);

ALTER TABLE deal_stage_history ENABLE ROW LEVEL SECURITY;

-- No client INSERT policy -- rows are created exclusively by the
-- SECURITY DEFINER trigger function below (same pattern as
-- `notifications`, migration 027). Without SECURITY DEFINER, the
-- trigger would run as the invoking (authenticated) role, which has
-- no INSERT policy here, and every Kanban drag would silently fail to
-- log its history row.
DROP POLICY IF EXISTS deal_stage_history_select ON deal_stage_history;
CREATE POLICY deal_stage_history_select ON deal_stage_history
  FOR SELECT USING (is_account_member(account_id));

-- Stamps/clears closed_at so "time to close" can be computed without
-- guessing from updated_at (which any unrelated edit — a note, a value
-- tweak — would also bump). Must run BEFORE so the NEW.closed_at
-- assignment lands in the row being written.
CREATE OR REPLACE FUNCTION deal_set_closed_at() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IN ('won', 'lost') AND NEW.closed_at IS NULL THEN
      NEW.closed_at := NOW();
    ELSIF NEW.status = 'open' THEN
      NEW.closed_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deal_set_closed_at ON deals;
CREATE TRIGGER trg_deal_set_closed_at
  BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION deal_set_closed_at();

-- One row per (deal, stage-entry): fires on creation and on every
-- stage_id change. Must run AFTER — a BEFORE INSERT trigger would try
-- to insert a history row referencing a deal row that doesn't exist
-- in the table yet, tripping the deal_id foreign key.
CREATE OR REPLACE FUNCTION deal_log_stage_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO deal_stage_history (account_id, deal_id, stage_id, entered_at)
    VALUES (NEW.account_id, NEW.id, NEW.stage_id, NEW.created_at);
  ELSIF TG_OP = 'UPDATE' AND NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    INSERT INTO deal_stage_history (account_id, deal_id, stage_id, entered_at)
    VALUES (NEW.account_id, NEW.id, NEW.stage_id, NOW());
  END IF;
  RETURN NULL; -- AFTER trigger, return value is ignored
END;
$$;

DROP TRIGGER IF EXISTS trg_deal_log_stage_change ON deals;
CREATE TRIGGER trg_deal_log_stage_change
  AFTER INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION deal_log_stage_change();

-- Backfill for deals that already existed before this migration: one
-- history row for their current stage (using created_at as the entry
-- time — an approximation, since real history starts from here on),
-- and closed_at for deals already won/lost (using updated_at as the
-- closest available proxy).
INSERT INTO deal_stage_history (account_id, deal_id, stage_id, entered_at)
SELECT d.account_id, d.id, d.stage_id, d.created_at
FROM deals d
WHERE NOT EXISTS (
  SELECT 1 FROM deal_stage_history h WHERE h.deal_id = d.id
);

UPDATE deals
SET closed_at = updated_at
WHERE status IN ('won', 'lost') AND closed_at IS NULL;
