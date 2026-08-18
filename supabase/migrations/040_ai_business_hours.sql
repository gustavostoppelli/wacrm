-- ============================================================
-- 040_ai_business_hours
--
-- Makes the AI Agent's "only reply within business hours" rule real
-- instead of just prompt text the model has no way to actually honor
-- (it only runs reactively per inbound message; it has no mechanism
-- to hold a reply and send it later). Adds:
--
--   1. Business-hours config on ai_configs (window, timezone, and an
--      optional custom off-hours acknowledgement message).
--   2. ai_pending_replies — one row per conversation currently
--      "waiting" for the next business-hours window, drained by the
--      existing /api/automations/cron pinger (same shared secret,
--      same external-pinger infra, no new cron job to set up).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS business_hours_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS business_hours_start SMALLINT NOT NULL DEFAULT 8;
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS business_hours_end SMALLINT NOT NULL DEFAULT 20;
-- IANA timezone name (e.g. 'America/Sao_Paulo'). Business hours are
-- evaluated in this zone, not the server's.
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS business_hours_timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo';
-- NULL = use the built-in default message (see src/lib/ai/auto-reply.ts).
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS off_hours_message TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_configs_business_hours_range_check'
      AND conrelid = 'ai_configs'::regclass
  ) THEN
    ALTER TABLE ai_configs
      ADD CONSTRAINT ai_configs_business_hours_range_check
      CHECK (
        business_hours_start >= 0 AND business_hours_start <= 23
        AND business_hours_end >= 1 AND business_hours_end <= 24
        AND business_hours_start < business_hours_end
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_pending_replies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Passed through to engineSendText's audit columns when the cron
  -- eventually sends the real reply -- mirrors DispatchArgs.configOwnerUserId.
  config_owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One outstanding wake-up per conversation: if the lead sends more
  -- messages before the scheduled time, we don't want a pile of
  -- duplicate rows -- whichever fires first just re-evaluates the
  -- conversation fresh (see dispatchInboundToAiReply), which already
  -- picks up everything the lead said in the meantime.
  UNIQUE(conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_pending_replies_due
  ON ai_pending_replies(scheduled_for) WHERE status = 'pending';

ALTER TABLE ai_pending_replies ENABLE ROW LEVEL SECURITY;

-- Read-only for members (transparency: "why hasn't the bot replied
-- yet" is answerable from the UI later). All writes go through the
-- service-role client (webhook + cron), which bypasses RLS.
DROP POLICY IF EXISTS ai_pending_replies_select ON ai_pending_replies;
CREATE POLICY ai_pending_replies_select ON ai_pending_replies
  FOR SELECT USING (is_account_member(account_id));
