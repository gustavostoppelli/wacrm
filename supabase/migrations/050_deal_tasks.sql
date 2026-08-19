-- ============================================================
-- 050_deal_tasks
--
-- Native task/reminder system for the human sales team, distinct from
-- the AI agent's own re-engagement follow-ups (migration 044) --
-- those only ever nudge the *lead*; this is "remind a *teammate* to
-- do something", e.g. "call this lead back by 3pm". A task is
-- optionally attached to a deal (the common case) and always assigned
-- to one account member.
--
-- Due-task notifications reuse the existing `notifications` table
-- (027) and its already-wired-up realtime subscription + unread badge
-- (useUnreadNotifications) instead of a new delivery mechanism --
-- widens that table's `type` CHECK to add 'task_due'.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Creator, for audit -- may differ from assigned_to (one teammate
  -- assigning a task to another).
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assigned_to UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES deals(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  -- Dedupe guard for the due-reminder notification (cron drains this
  -- the same way deal_meeting_reminders/conversation_followups do).
  reminder_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id);
CREATE INDEX IF NOT EXISTS idx_tasks_deal ON tasks(deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_due
  ON tasks(due_at)
  WHERE completed_at IS NULL AND reminder_sent_at IS NULL;

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- Settings-class-ish, mirroring deals: any account member reads the
-- roster; agent+ can create/update/delete. Matches deals_select/
-- deals_insert/etc. (017_account_sharing.sql).
DROP POLICY IF EXISTS tasks_select ON tasks;
DROP POLICY IF EXISTS tasks_insert ON tasks;
DROP POLICY IF EXISTS tasks_update ON tasks;
DROP POLICY IF EXISTS tasks_delete ON tasks;
CREATE POLICY tasks_select ON tasks FOR SELECT USING (is_account_member(account_id));
CREATE POLICY tasks_insert ON tasks FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY tasks_update ON tasks FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY tasks_delete ON tasks FOR DELETE USING (is_account_member(account_id, 'agent'));

-- Widen notifications.type for the due-task alert.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notifications_type_check' AND conrelid = 'notifications'::regclass
  ) THEN
    ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
  END IF;
  ALTER TABLE notifications
    ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('conversation_assigned', 'task_due'));
END $$;

-- notifications.conversation_id is NOT NULL-free already (nullable);
-- a task-due notification has no conversation, only deal/contact
-- context, which the table already supports via contact_id. Add a
-- deal_id column so the notification can deep-link to the deal too.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS deal_id UUID REFERENCES deals(id) ON DELETE SET NULL;
