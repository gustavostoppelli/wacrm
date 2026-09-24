-- ============================================================
-- 072_sdr_ia_exclusion_tag.sql — manual "do not contact" override
--
-- The automatic dedupe (contacted_tag_id) only kicks in once SDR IA
-- itself has sent a message — if a human reaches a lead first (e.g. a
-- salesperson manually starts talking to a freshly-imported lead
-- before the cron gets to it), SDR IA has no way to know and would
-- still cold-message them. exclusion_tag_id lets any team member tag
-- a contact by hand (e.g. "Atendendo manual") to pull them out of the
-- SDR IA queue immediately, independent of the automatic tracking.
-- ============================================================

ALTER TABLE sdr_ia_config
  ADD COLUMN IF NOT EXISTS exclusion_tag_id UUID REFERENCES tags(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION sdr_ia_next_candidates(
  p_account_id UUID,
  p_lead_tag_id UUID,
  p_contacted_tag_id UUID,
  p_limit INT,
  p_exclusion_tag_id UUID DEFAULT NULL
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
    AND (
      p_exclusion_tag_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM contact_tags excl_ct
        WHERE excl_ct.contact_id = c.id AND excl_ct.tag_id = p_exclusion_tag_id
      )
    )
  ORDER BY c.created_at ASC
  LIMIT p_limit;
$$;
