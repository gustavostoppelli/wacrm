-- ============================================================
-- 058_whatsapp_config_ai_enabled
--
-- Per-channel toggle for the AI agent (migration 037 already lets an
-- account run multiple WhatsApp channels, e.g. one per salesperson,
-- but `ai_configs` is account-wide — the agent used to auto-reply on
-- every channel indiscriminately). Defaults to true so every existing
-- channel keeps behaving exactly as it does today; an account opts a
-- specific channel OUT (e.g. a human salesperson's personal number)
-- by flipping this off in Settings.
--
-- Idempotent -- safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT true;
