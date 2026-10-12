-- supabase/migrations/082_ai_meeting_intents.sql
-- ============================================================
-- 082_ai_meeting_intents
--
-- Registro duravel de toda vez que o modelo (auto-reply) emite um
-- agendamento de reuniao com horario+e-mail completos. Escrito ANTES
-- de qualquer efeito colateral (negocio/etapa/calendario/mensagem),
-- pra sempre existir um rastro mesmo se tudo abaixo falhar -- foi a
-- falta disso que tornou um bug real (link de reuniao nunca
-- enviado) tao dificil de diagnosticar em 2026-10-11/12.
--
-- `cron_job_state` e um controle generico de "ja rodei hoje" pra
-- jobs do cron que nao sao por conta (o job de reconciliacao e o
-- primeiro uso, mas qualquer job futuro sem granularidade por conta
-- pode reaproveitar).
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_meeting_intents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  config_owner_user_id UUID NOT NULL,
  meeting_at TIMESTAMPTZ NOT NULL,
  meeting_email TEXT NOT NULL,
  meeting_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolution TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_meeting_intents_unresolved
  ON ai_meeting_intents (created_at)
  WHERE resolved_at IS NULL;

ALTER TABLE ai_meeting_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_meeting_intents_select ON ai_meeting_intents;
CREATE POLICY ai_meeting_intents_select ON ai_meeting_intents
  FOR SELECT USING (is_account_member(account_id));

CREATE TABLE IF NOT EXISTS cron_job_state (
  job_name TEXT PRIMARY KEY,
  last_run_date DATE
);

ALTER TABLE cron_job_state ENABLE ROW LEVEL SECURITY;
-- Sem policy nenhuma: tabela puramente interna, so o client
-- service-role (que ignora RLS) le/escreve aqui.
