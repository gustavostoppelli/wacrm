-- ============================================================
-- 060_whatsapp_config_assigned_to
--
-- Lets an admin reserve a channel for one specific teammate (e.g. a
-- salesperson's own number) without making that teammate an admin.
-- Creating/deleting a channel stays admin-only (that's the deliberate
-- control point — an account owner selling seats wants to gate how
-- many numbers exist, since that's what gets billed), but the person
-- a channel is assigned to can complete the QR-code pairing
-- themselves — see the relaxed role check on
-- POST /api/uazapi/channels/[id]/connect and the ownership check
-- added there.
--
-- Two RLS UPDATE policies now exist on whatsapp_config: the original
-- admin-only one (017) and this new one scoped to the assignee.
-- Postgres OR's multiple permissive policies for the same command
-- together, so either condition being true allows the row update —
-- this is what lets GET .../status (already agent-role-reachable)
-- actually persist `status`/`connected_at` when an assigned agent,
-- not an admin, is the one polling it.
--
-- Idempotent -- safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_assigned_to
  ON whatsapp_config(assigned_to) WHERE assigned_to IS NOT NULL;

DROP POLICY IF EXISTS whatsapp_config_update_assigned ON whatsapp_config;
CREATE POLICY whatsapp_config_update_assigned ON whatsapp_config
  FOR UPDATE USING (assigned_to = auth.uid());
