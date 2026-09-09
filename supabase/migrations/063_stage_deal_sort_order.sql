-- Per-stage card ordering (migration 063). Deals are loaded newest-
-- first account-wide (see loadDeals in pipelines/page.tsx) and that
-- order carries into every stage's bucket on the board. Some stages
-- — a prospecting queue fed by a daily automation, e.g. "Novo Lead" —
-- want the opposite so the oldest untouched lead surfaces first,
-- without changing every other stage's order.
--
-- Deliberately a per-stage setting (editable in Pipeline Settings),
-- not a hardcoded stage-name check — stage names are free text a user
-- can rename, and this needs to work the same way for every account
-- of the sellable product regardless of what they call their columns.
ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS deal_sort_order TEXT NOT NULL DEFAULT 'newest_first'
    CHECK (deal_sort_order IN ('newest_first', 'oldest_first'));

COMMENT ON COLUMN pipeline_stages.deal_sort_order IS
  'Card order within this stage''s column: newest_first (default, matches the account-wide deals query) or oldest_first (for queue-like stages fed by automation, so the longest-waiting lead surfaces first).';
