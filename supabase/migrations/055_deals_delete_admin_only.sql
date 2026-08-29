-- ============================================================
-- 055_deals_delete_admin_only
--
-- Restricts deleting a deal to admin/owner (was agent+, same as
-- every other operational write on `deals` since 017_account_sharing).
-- Deleting a deal is a hard delete with no audit trail and no undo
-- (deal_stage_history cascades away with it) -- a manager has no way
-- to notice a deal went missing if any rep can erase one. Reads,
-- creates, and every other deal write (move stage, edit fields, mark
-- won/lost) are unaffected -- still agent+.
--
-- Idempotent -- safe to run multiple times.
-- ============================================================

DROP POLICY IF EXISTS deals_delete ON deals;
CREATE POLICY deals_delete ON deals FOR DELETE USING (is_account_member(account_id, 'admin'));
