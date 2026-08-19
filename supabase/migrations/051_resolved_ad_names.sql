-- ============================================================
-- 051_resolved_ad_names
--
-- Cache of Meta ad_id -> ad name, resolved once via the Graph API
-- and reused for every subsequent Click-to-WhatsApp deal that
-- references the same ad. `deals.campaign` (046_deal_campaign)
-- stores the raw ad id by default (see referral handling in
-- lib/whatsapp/inbound-message.ts) because the WhatsApp webhook's
-- `referral` object never carries a human-readable ad name -- this
-- table lets a best-effort Graph API lookup upgrade that id into
-- something readable ("IMG 6") without hitting Meta on every single
-- inbound message for the same ad.
--
-- Global (not scoped to account_id): ad ids are unique across all of
-- Meta, and the whole point is to avoid redundant API calls -- two
-- accounts referencing the same ad id would be an odd coincidence,
-- not a collision worth guarding against.
-- ============================================================

CREATE TABLE IF NOT EXISTS resolved_ad_names (
  ad_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
