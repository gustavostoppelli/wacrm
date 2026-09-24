-- ============================================================
-- 073_conversation_reactivations.sql — AI-initiated "call back later"
--
-- Backs the new [[REACTIVATE: <ISO datetime> | <reason>]] sentinel
-- (src/lib/ai/defaults.ts): when a lead (or a gatekeeper) gives a
-- specific future time to resume, the AI schedules a proactive
-- wake-up instead of waiting for the customer to write again.
--
-- Neither existing table fits this combination of behaviors:
--   - ai_pending_replies (migration 040) has the right SEND behavior
--     (its cron drain calls dispatchInboundToAiReply, generating a
--     real, context-aware reply) but the wrong CANCEL behavior (it's
--     deliberately kept when a new inbound arrives, so an off-hours
--     ack absorbs whatever the lead says before the window opens —
--     exactly wrong for "the lead already called back on their own,
--     don't also fire a stray re-engagement later").
--   - conversation_followups (migration 044) has the right CANCEL
--     behavior (deleted unconditionally on any new inbound, at the
--     top of dispatchInboundToAiReply) but the wrong SEND behavior
--     (its cron drain sends one of two hardcoded "you still there?"
--     templates, not a real generated reply — wrong tone entirely for
--     "proactively resuming a specific promised call back").
--
-- This table pairs ai_pending_replies' send path with
-- conversation_followups' cancel path.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_reactivations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  config_owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Short human-readable reason from the [[REACTIVATE: ... | reason]]
  -- tag (e.g. "Gatekeeper pediu pra ligar às 15h") — internal only,
  -- never sent to the customer; just context for anyone reading the
  -- deal/conversation while this is pending.
  reason TEXT,
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_reactivations_due
  ON conversation_reactivations(send_at) WHERE status = 'pending';

ALTER TABLE conversation_reactivations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_reactivations_select ON conversation_reactivations;
CREATE POLICY conversation_reactivations_select ON conversation_reactivations
  FOR SELECT USING (is_account_member(account_id));

-- No insert/update/delete policies — same convention as
-- ai_pending_replies: only the service-role client (auto-reply.ts,
-- the cron drain) ever writes this table.
