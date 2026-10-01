-- ============================================================
-- 079_account_auto_create_deal
--
-- Per-account toggle for whether a contact's first inbound WhatsApp
-- message (with no existing open deal) auto-creates one
-- (ensureDealForContact, src/lib/whatsapp/inbound-message.ts).
--
-- Default TRUE preserves today's behaviour for every existing account
-- (Divisa, Tropic, Fuse's own account, etc.) — nothing changes for
-- them. Capacita Estética needs it OFF: every student is already a
-- paying customer managed through a Hotmart-webhook pipeline, so a
-- stray/duplicate WhatsApp message from someone who already has (or
-- will soon have) a webhook-created deal was spawning duplicate
-- "WhatsApp Direto" cards. With this off, a manual "Criar negócio"
-- button in the Inbox (unaffected by this flag) is the only way a
-- WhatsApp conversation becomes a deal there.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS auto_create_deal_on_first_message BOOLEAN NOT NULL DEFAULT true;
