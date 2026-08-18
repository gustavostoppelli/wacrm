-- ============================================================
-- 044_conversation_followups
--
-- Re-engages a lead who went quiet mid-qualification: up to 2
-- automatic nudges (first ~4 business hours after the AI's last
-- unanswered message, second the next business day) before the
-- system stops trying on its own. Drained by the same
-- /api/automations/cron pinger as everything else scheduled
-- (migrations 040-042). Native to any FuseHub account.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS followup_enabled BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS conversation_followups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  config_owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attempt SMALLINT NOT NULL CHECK (attempt IN (1, 2)),
  send_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  -- Snapshot of "the AI's last outbound message time" at scheduling
  -- time. At send time, the cron checks whether any customer message
  -- landed after this -- if so, the lead already replied (via the
  -- normal inbound path, which cancels this row anyway) and the nudge
  -- is skipped as a defensive fallback.
  last_outbound_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One outstanding nudge per conversation. Any new inbound message
  -- (see dispatchInboundToAiReply) deletes this row outright --
  -- scheduling a fresh one only happens if that turn ends in a normal
  -- (non-handoff) auto-reply.
  UNIQUE(conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_followups_due
  ON conversation_followups(send_at) WHERE sent_at IS NULL;

ALTER TABLE conversation_followups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_followups_select ON conversation_followups;
CREATE POLICY conversation_followups_select ON conversation_followups
  FOR SELECT USING (is_account_member(account_id));
