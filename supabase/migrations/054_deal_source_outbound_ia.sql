-- ============================================================
-- 054_deal_source_outbound_ia
--
-- Adds "Prospecção Outbound IA" to the `deals.source` vocabulary
-- (038_deal_source) -- leads found via automated scraping tools
-- (Apify, ScrapeGraphAI, etc), distinct from "Prospecção Outbound"
-- (manual outbound done by the human SDR). The tool actually used
-- and the confidence level of the data (e.g. Instagram followers
-- confirmed vs inferred from site content) live in the deal's notes,
-- not in `source` -- this value stays stable even as the underlying
-- tool changes.
--
-- Idempotent -- safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'deals_source_check' AND conrelid = 'deals'::regclass
  ) THEN
    ALTER TABLE deals DROP CONSTRAINT deals_source_check;
  END IF;
  ALTER TABLE deals
    ADD CONSTRAINT deals_source_check
    CHECK (
      source IS NULL OR source IN (
        'Formulário do Site — Diagnóstico',
        'Tráfego Pago (Meta/Google Ads)',
        'Prospecção Outbound',
        'Prospecção Outbound IA',
        'Apify',
        'Indicação',
        'Instagram / Orgânico',
        'WhatsApp Direto',
        'Evento / Parceria',
        'Outro'
      )
    );
END $$;
