-- ============================================================
-- 083_sdr_ia_send_spacing.sql — Space out SDR IA's daily sends
--
-- drainSdrIa fetched up to the whole remaining daily_cap in one
-- cron tick and sent to all of them back-to-back -- e.g. all 5 of
-- the day's messages going out within the same minute, the first
-- tick after business hours open. A burst like that reads more like
-- a bot than a person working through a list, which matters more
-- than usual here: SDR IA's default send mode is free-form text
-- through an unofficial WhatsApp channel (no Meta template
-- approval), the highest-risk configuration this product supports.
--
-- last_sent_at (distinct from the existing last_sent_date, which is
-- date-only and only drives the daily-cap reset) lets drainSdrIa
-- gate on "has enough time passed since this account's last send",
-- updated atomically in the same RPC that already increments
-- sent_today -- same reasoning as 071: concurrent cron ticks have no
-- infra-level overlap guard, so the write must be atomic, not a
-- read-then-write from the app layer.
-- ============================================================

ALTER TABLE sdr_ia_config
  ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION sdr_ia_register_sent(p_account_id UUID, p_today DATE)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE sdr_ia_config
  SET sent_today = CASE WHEN last_sent_date = p_today THEN sent_today + 1 ELSE 1 END,
      last_sent_date = p_today,
      last_sent_at = NOW()
  WHERE account_id = p_account_id;
$$;
