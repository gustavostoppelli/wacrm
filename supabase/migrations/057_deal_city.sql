-- ============================================================
-- 057_deal_city
--
-- Adds `city` to `deals` -- free-text, e.g. "Petrópolis, Porto
-- Alegre/RS". Until now this only ever lived buried inside a
-- "Cidade/UF: ..." line in the notes field-sheet (see
-- formatFuseHubNotes_ / push-to-fusehub.js's formatNotes), invisible
-- on the Kanban card without opening the deal. A first-class column
-- lets it show up front on every card.
--
-- Nullable: existing deals and any flow that doesn't set a city keep
-- working unchanged.
--
-- Idempotent -- safe to run multiple times.
-- ============================================================

ALTER TABLE deals ADD COLUMN IF NOT EXISTS city TEXT;
