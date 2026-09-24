-- ============================================================
-- 070_sdr_ia.sql — SDR IA as a first-party, multi-tenant feature
--
-- Graduates the sdr-frio PoC (opensquad/skills/sdr-frio, external
-- script, Fuse-only — see docs/superpowers/specs/2026-09-22-sdr-ia-
-- fusehub-design.md) into a real FuseHub feature any account could
-- eventually buy. See docs/superpowers/specs/2026-09-24-sdr-ia-
-- first-party-feature-design.md for the full design.
--
-- accounts.sdr_ia_enabled controls whether the account sees the real
-- config wizard on /sdr-ia or a locked marketing page — same
-- one-column-per-account-setting convention as
-- accounts.whatsapp_channel_limit (migration 067). Defaults to false
-- for every account of the sellable product; Fuse's own account is
-- flipped to true via direct SQL after this ships, not by this
-- migration.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS sdr_ia_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN accounts.sdr_ia_enabled IS
  'Whether this account can access the SDR IA cold-outreach feature. Default false for the sellable product baseline; flipped per-account via direct SQL once a customer pays for it.';

CREATE TABLE IF NOT EXISTS sdr_ia_config (
  account_id          UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled             BOOLEAN NOT NULL DEFAULT false,
  lead_tag_id         UUID REFERENCES tags(id) ON DELETE SET NULL,
  contacted_tag_id    UUID REFERENCES tags(id) ON DELETE SET NULL,
  whatsapp_config_id  UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  send_mode           TEXT NOT NULL DEFAULT 'template' CHECK (send_mode IN ('template', 'text')),
  template_name       TEXT,
  template_language   TEXT,
  message_variants    JSONB NOT NULL DEFAULT '[]'::jsonb,
  daily_cap           INTEGER NOT NULL DEFAULT 5,
  hours_start         INTEGER NOT NULL DEFAULT 9,
  hours_end           INTEGER NOT NULL DEFAULT 18,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sdr_ia_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sdr_ia_config_select ON sdr_ia_config;
CREATE POLICY sdr_ia_config_select ON sdr_ia_config FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS sdr_ia_config_write ON sdr_ia_config;
CREATE POLICY sdr_ia_config_write ON sdr_ia_config FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- Cron runs with the service-role client (bypasses RLS already), so
-- no separate policy is needed for that path.

-- ============================================================
-- sdr_ia_next_candidates — next batch of untouched, tagged contacts
-- for one account's SDR IA queue. SECURITY DEFINER + explicit
-- account_id filter (not RLS) since the cron caller is service-role
-- and iterates many accounts in one process.
-- ============================================================
CREATE OR REPLACE FUNCTION sdr_ia_next_candidates(
  p_account_id UUID,
  p_lead_tag_id UUID,
  p_contacted_tag_id UUID,
  p_limit INT
)
RETURNS TABLE(contact_id UUID, phone TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.phone
  FROM contacts c
  JOIN contact_tags lead_ct ON lead_ct.contact_id = c.id AND lead_ct.tag_id = p_lead_tag_id
  WHERE c.account_id = p_account_id
    AND c.phone IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM contact_tags done_ct
      WHERE done_ct.contact_id = c.id AND done_ct.tag_id = p_contacted_tag_id
    )
  ORDER BY c.created_at ASC
  LIMIT p_limit;
$$;
