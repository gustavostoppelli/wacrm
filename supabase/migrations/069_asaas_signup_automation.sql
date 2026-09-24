-- ============================================================
-- 069_asaas_signup_automation.sql — Auto-send signup links on payment
--
-- Backs the /api/webhooks/asaas endpoint: when Asaas confirms the
-- FIRST payment of one of Fuse's own subscription payment links, the
-- endpoint auto-generates a signup_invitations token (migration 068)
-- and sends it to the customer over WhatsApp — no manual step.
--
-- Asaas fires the same PAYMENT_CONFIRMED/PAYMENT_RECEIVED event every
-- renewal month for a recurring subscription, and uses "at least once"
-- delivery (the same event can arrive more than once). The unique
-- constraint on subscription_id is what makes both of those safe:
-- the handler does an INSERT and treats a unique-violation as "already
-- handled" — whether that's a renewal or a retried delivery of the
-- same first payment, it's a no-op either way.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS asaas_processed_subscriptions (
  subscription_id text PRIMARY KEY,
  customer_id     text NOT NULL,
  payment_id      text,
  plan_label      text,
  processed_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE asaas_processed_subscriptions ENABLE ROW LEVEL SECURITY;
-- No policies — only the service-role webhook handler ever touches
-- this table, same rationale as signup_invitations (migration 068).
