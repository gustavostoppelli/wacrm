-- supabase/migrations/081_campaigns.sql
-- ============================================================
-- 081_campaigns
--
-- Feature nativa e generica: uma "campanha" agrupa variantes de
-- mensagem testadas entre si (ex: 3 textos diferentes de primeiro
-- contato frio). Uma "atribuicao" registra que um contato recebeu
-- uma variante especifica. "Respondeu" e calculado por quem le os
-- dados (olhando mensagens inbound depois de assigned_at), nunca
-- armazenado aqui -- fonte de verdade sao as mensagens reais.
--
-- Pensado pra ser usado por qualquer integracao externa via API
-- publica (ver POST /api/v1/campaigns*), nao especifico de nenhum
-- fluxo da Fuse.
--
-- Idempotente -- seguro rodar mais de uma vez.
-- ============================================================

CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, name)
);

CREATE TABLE IF NOT EXISTS campaign_variants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, name)
);

CREATE TABLE IF NOT EXISTS campaign_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES campaign_variants(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_assignments_variant ON campaign_assignments(variant_id);
CREATE INDEX IF NOT EXISTS idx_campaign_assignments_contact ON campaign_assignments(contact_id);

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS campaigns_select ON campaigns;
CREATE POLICY campaigns_select ON campaigns
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS campaign_variants_select ON campaign_variants;
CREATE POLICY campaign_variants_select ON campaign_variants
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM campaigns c WHERE c.id = campaign_id AND is_account_member(c.account_id))
  );

DROP POLICY IF EXISTS campaign_assignments_select ON campaign_assignments;
CREATE POLICY campaign_assignments_select ON campaign_assignments
  FOR SELECT USING (is_account_member(account_id));
