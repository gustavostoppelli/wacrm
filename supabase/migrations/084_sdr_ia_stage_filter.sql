-- ============================================================
-- 084_sdr_ia_stage_filter.sql — Filter SDR IA candidates by pipeline stage
--
-- sdr_ia_next_candidates only ever filtered by tag (lead_tag_id
-- present, contacted_tag_id absent) -- it never looked at which
-- pipeline column/stage the contact's deal was actually sitting in.
-- A contact tagged "Prospecção Outbound IA" that had already
-- progressed past the intended column (replied, qualified, won,
-- lost -- any of it, by any channel) would still get cold-messaged
-- as if brand new. Raised by the user in 2026-10-13 while
-- configuring the feature for real.
--
-- eligible_stage_ids is nullable and defaults to NULL: no filter,
-- exactly today's behavior, so existing/empty configs are unaffected
-- until an account actually picks stages in the wizard.
-- ============================================================

ALTER TABLE sdr_ia_config
  ADD COLUMN IF NOT EXISTS eligible_stage_ids UUID[];

CREATE OR REPLACE FUNCTION sdr_ia_next_candidates(
  p_account_id UUID,
  p_lead_tag_id UUID,
  p_contacted_tag_id UUID,
  p_limit INT,
  p_exclusion_tag_id UUID DEFAULT NULL,
  p_eligible_stage_ids UUID[] DEFAULT NULL
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
    AND (
      p_eligible_stage_ids IS NULL
      OR array_length(p_eligible_stage_ids, 1) IS NULL
      OR EXISTS (
        SELECT 1 FROM deals d
        WHERE d.contact_id = c.id
          AND d.account_id = p_account_id
          AND d.status = 'open'
          AND d.stage_id = ANY(p_eligible_stage_ids)
      )
    )
  ORDER BY c.created_at ASC
  LIMIT p_limit;
$$;
