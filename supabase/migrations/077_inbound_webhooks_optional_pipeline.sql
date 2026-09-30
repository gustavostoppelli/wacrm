-- ============================================================
-- 077_inbound_webhooks_optional_pipeline.sql — Pipeline/stage become optional
--
-- Migration 066 required pipeline_id/stage_id at creation time so a
-- lead from this connection always landed somewhere predictable. In
-- practice, an account building multiple automations off the same
-- inbound-webhook family (Hotmart's various events, for example)
-- often wants full control over deal placement inside the automation
-- itself (a "Criar negócio" step, which already supports picking
-- pipeline/stage/title/value/source dynamically), not a single fixed
-- destination baked into the connection.
--
-- Both paths stay supported:
--   - pipeline_id/stage_id SET on the connection: unchanged behavior
--     — an "open" event auto-creates a deal there, no automation step
--     needed.
--   - pipeline_id/stage_id NULL: no automatic deal creation; the
--     account is expected to add its own "Criar negócio" step in the
--     automation reacting to this connection's webhook_received
--     trigger. Prevents the double-deal bug of having both an
--     automatic deal AND an automation-created one for the same
--     event.
-- ============================================================

ALTER TABLE inbound_webhooks
  ALTER COLUMN pipeline_id DROP NOT NULL;

ALTER TABLE inbound_webhooks
  ALTER COLUMN stage_id DROP NOT NULL;
