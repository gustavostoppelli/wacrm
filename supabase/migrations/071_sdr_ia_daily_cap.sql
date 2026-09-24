-- ============================================================
-- 071_sdr_ia_daily_cap.sql — Fix SDR IA's broken daily send cap
--
-- drainSdrIa (cron/route.ts) ran every 5 minutes and only bounded
-- itself by a per-tick counter, never by an actual per-day count —
-- letting an account send ~100x its configured daily_cap before the
-- lead queue ran dry. sent_today/last_sent_date give it real state to
-- check, and sdr_ia_register_sent() is the atomic increment: each
-- successful send calls it once, so concurrent cron ticks (this
-- endpoint has no infra-level overlap guard) can never lose or
-- double-count an increment the way a read-then-write from the app
-- layer could.
-- ============================================================

ALTER TABLE sdr_ia_config
  ADD COLUMN IF NOT EXISTS sent_today INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_sent_date DATE;

CREATE OR REPLACE FUNCTION sdr_ia_register_sent(p_account_id UUID, p_today DATE)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE sdr_ia_config
  SET sent_today = CASE WHEN last_sent_date = p_today THEN sent_today + 1 ELSE 1 END,
      last_sent_date = p_today
  WHERE account_id = p_account_id;
$$;
