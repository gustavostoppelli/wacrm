-- ============================================================
-- 053_deal_lost_reason
--
-- Structured loss reason, captured when a deal is marked "lost" --
-- powers the "why are we losing deals" report. A fixed vocabulary
-- (mirrors the DEAL_SOURCES pattern in src/lib/deals/lost-reason.ts)
-- so the report aggregates into real categories instead of a wall of
-- similar-but-not-identical free-text strings; "Outro" still allows
-- a free-text detail for the cases that don't fit.
--
-- Idempotent -- safe to run multiple times.
-- ============================================================

ALTER TABLE deals ADD COLUMN IF NOT EXISTS lost_reason TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS lost_reason_detail TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'deals_lost_reason_check' AND conrelid = 'deals'::regclass
  ) THEN
    ALTER TABLE deals DROP CONSTRAINT deals_lost_reason_check;
  END IF;
  ALTER TABLE deals
    ADD CONSTRAINT deals_lost_reason_check
    CHECK (lost_reason IS NULL OR lost_reason IN (
      'Preço',
      'Sem resposta',
      'Escolheu concorrente',
      'Fora do momento',
      'Fora do perfil ideal',
      'Outro'
    ));
END $$;
