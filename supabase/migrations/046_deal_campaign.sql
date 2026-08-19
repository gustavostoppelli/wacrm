-- ============================================================
-- 046_deal_campaign
--
-- Adds `campaign` to `deals`: free-text name of the specific
-- campaign/ad/form that produced the lead, one level more granular
-- than `source` (038_deal_source), which only tracks the broad
-- channel (e.g. "Tráfego Pago (Meta/Google Ads)"). Lets an account
-- compare which individual campaign converts best, not just which
-- platform. Unlike `source`, this is free text (not a closed
-- dropdown) — campaign names change constantly as new ads launch,
-- so a CHECK-constrained enum would need editing every time.
-- Nullable: existing deals and any flow that doesn't set a campaign
-- keep working unchanged.
-- ============================================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS campaign TEXT;
