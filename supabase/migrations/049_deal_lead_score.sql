-- ============================================================
-- 049_deal_lead_score
--
-- A generic 0-100 lead-score field on `deals`, visible on the Kanban
-- card and editable in the deal form. wacrm does not compute this
-- score itself -- how a lead is scored is entirely account/business
-- specific (which fields matter, what weights), so baking one
-- algorithm in would be Fuse-specific behavior leaking into the sold
-- product. Instead the score is just a number any integration can
-- set: the public API (`POST /api/v1/deals`), the create_deal
-- automation step, or a human typing it into the deal form.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE deals ADD COLUMN IF NOT EXISTS lead_score INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'deals_lead_score_range'
      AND conrelid = 'deals'::regclass
  ) THEN
    ALTER TABLE deals
      ADD CONSTRAINT deals_lead_score_range
      CHECK (lead_score IS NULL OR (lead_score >= 0 AND lead_score <= 100));
  END IF;
END $$;
