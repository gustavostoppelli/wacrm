-- ============================================================
-- 079_account_auto_create_deal
--
-- Per-account toggle for whether a contact's first inbound WhatsApp
-- message (with no existing open deal) auto-creates one
-- (ensureDealForContact, src/lib/whatsapp/inbound-message.ts).
--
-- Default FALSE, applied to every account (new and existing): a
-- WhatsApp conversation no longer turns into a deal on its own for
-- anyone, Fuse's own account included. The explicit "Criar negócio"
-- button in the Inbox (unaffected by this flag) is now the only way a
-- conversation becomes a deal there — deliberately, one click at a
-- time, so a stray/spam WhatsApp message never silently spawns a
-- "WhatsApp Direto" card. The column stays per-account (not a global
-- constant) so a future account can still opt back into the old
-- automatic behaviour if it ever wants to.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS auto_create_deal_on_first_message BOOLEAN NOT NULL DEFAULT false;
