-- ============================================================
-- 078_deal_source_webhook
--
-- Adds 'Webhook' to the deals.source vocabulary (migration 038).
--
-- Every deal auto-created from an inbound webhook (Hotmart purchase,
-- etc.) — either directly by a webhook connection with its own fixed
-- pipeline/stage, or via an automation's "Criar negócio" step — was
-- falling back to 'Outro' because there was no accurate category for
-- "an external system posted to our webhook". 'WhatsApp Direto' is
-- wrong for these (that's reserved for a contact's first inbound
-- WhatsApp message with no automation involved) but was showing up
-- there by coincidence when a webhook-sourced contact later also
-- messaged WhatsApp and triggered the separate first-inbound-message
-- auto-deal path before the webhook's own deal existed.
-- ============================================================

ALTER TABLE deals
  DROP CONSTRAINT IF EXISTS deals_source_check;
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
      'Webhook',
      'Evento / Parceria',
      'Outro'
    )
  );
