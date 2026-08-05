-- ============================================================
-- 038_deal_source
--
-- Adds `source` to `deals`: where the lead came from (site form,
-- paid traffic, outbound prospecting, referral, etc). Surfaced as a
-- dropdown on the deal form so it can be filled in manually when a
-- deal is created — no upstream automation sets it yet.
--
-- The allowed values mirror the `canal_origem` column (strict
-- dropdown) on the sales team's prospecting master spreadsheet, so a
-- deal's source lines up with the same vocabulary used there.
-- Nullable: existing deals and any flow that doesn't set a source
-- keep working unchanged.
-- ============================================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS source TEXT;

ALTER TABLE deals
  DROP CONSTRAINT IF EXISTS deals_source_check;
ALTER TABLE deals
  ADD CONSTRAINT deals_source_check
  CHECK (
    source IS NULL OR source IN (
      'Formulário do Site — Diagnóstico',
      'Tráfego Pago (Meta/Google Ads)',
      'Prospecção Outbound',
      'Apify',
      'Indicação',
      'Instagram / Orgânico',
      'WhatsApp Direto',
      'Evento / Parceria',
      'Outro'
    )
  );
