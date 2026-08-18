-- ============================================================
-- 039_calendar_integration
--
-- Native, multi-tenant Google Calendar connection. Any account can
-- connect its own Google Calendar (OAuth, one connection per account
-- for now — same shape whatsapp_config started with before multi-
-- channel support was added in migration 037). This powers real
-- availability checks + event creation for the AI Agent's scheduling
-- flow instead of the model inventing/negotiating times blind.
--
-- Tokens are encrypted at rest with the same AES-256-GCM convention as
-- whatsapp_config (src/lib/whatsapp/encryption.ts, ENCRYPTION_KEY).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS calendar_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'google' CHECK (provider IN ('google')),

  -- Connected calendar owner's email, for display in Settings only.
  google_email TEXT,

  -- OAuth credentials, AES-256-GCM-encrypted (encrypt()/decrypt() from
  -- src/lib/whatsapp/encryption.ts — the format is provider-agnostic
  -- despite the file's name).
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,

  -- Which calendar to read/write. 'primary' covers the common case;
  -- stored explicitly so a future settings UI can let the account
  -- pick a secondary calendar without a schema change.
  calendar_id TEXT NOT NULL DEFAULT 'primary',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(account_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_configs_account ON calendar_configs(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON calendar_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON calendar_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE calendar_configs ENABLE ROW LEVEL SECURITY;

-- Settings-class table — same tier as whatsapp_config: any member can
-- see connection status, only admins can connect/disconnect.
DROP POLICY IF EXISTS calendar_configs_select ON calendar_configs;
CREATE POLICY calendar_configs_select ON calendar_configs
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS calendar_configs_insert ON calendar_configs;
CREATE POLICY calendar_configs_insert ON calendar_configs
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS calendar_configs_update ON calendar_configs;
CREATE POLICY calendar_configs_update ON calendar_configs
  FOR UPDATE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS calendar_configs_delete ON calendar_configs;
CREATE POLICY calendar_configs_delete ON calendar_configs
  FOR DELETE USING (is_account_member(account_id, 'admin'));
