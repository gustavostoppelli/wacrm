# Reconciliação diária do agendamento de reunião via IA

## Contexto

O fluxo `recordMeetingScheduled` (em `src/lib/ai/auto-reply.ts`) é a função
que, quando o modelo emite `[[MEETING: ...]]`, deveria: achar/criar o negócio
do contato, mover a etapa, criar o evento no Google Calendar e mandar uma
mensagem de follow-up com o link do Meet. Em 2026-10-11/12, dois testes reais
(Julio, sem negócio pré-existente) mostraram que esse fluxo falhava
silenciosamente — o modelo prometia o link e nada mais era enviado. Causa
raiz corrigida nos commits `a521a50`/`2ae179e`: nenhum negócio existia pra
contatos que chegam fora da ponte Apify/Meta/formulário, e o insert de
negócio auto-criado também faltava `user_id`.

Esse episódio expôs um problema maior: **não existe nenhum registro
duradouro de que o modelo tentou agendar uma reunião**. Se qualquer passo
falhar (Calendar desconectado, erro transiente de rede, um terceiro bug
ainda não encontrado), não há como saber depois — só dá pra descobrir lendo
a conversa mensagem por mensagem, como foi feito agora. O pedido do usuário:
não só avisar quando algo falhar, mas **corrigir automaticamente** todos os
dias.

## Desenho

### 1. Tabela `ai_meeting_intents` (nova, migration)

Registro append-first, escrito ANTES de qualquer efeito colateral, toda vez
que o modelo emite `meetingAt`/`meetingEmail` nesse turno — mesmo que tudo
abaixo falhe, essa linha existe.

```sql
create table ai_meeting_intents (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id),
  conversation_id uuid not null references conversations(id),
  contact_id uuid not null references contacts(id),
  config_owner_user_id uuid not null,
  meeting_at timestamptz not null,
  meeting_email text,
  meeting_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text -- 'completed' | 'stale_rescheduled' | null (ainda pendente)
);
create index on ai_meeting_intents (account_id) where resolved_at is null;
```

RLS: SELECT-only por `is_account_member(account_id)`, igual padrão das
tabelas de campanhas. Nenhuma UI consome isso ainda — é dado operacional,
não precisa expor na dashboard neste momento (o job de reconciliação é o
único consumidor).

### 2. `recordMeetingScheduled` ganha um passo 0

Antes do lookup de negócio: insere a linha em `ai_meeting_intents`
(best-effort — nunca bloqueia a resposta, mesmo padrão do resto do
arquivo). Guarda o `id` da linha. No final, se as 4 coisas concretas
existirem (negócio com `calendar_event_id`+`meeting_link`, e a mensagem do
link de fato enviada), marca essa linha `resolved_at=now()`,
`resolution='completed'`.

### 3. Job de reconciliação (novo, dentro do cron existente)

Mesmo padrão de "uma vez por dia" que `drainDailyDigest` já usa (claim
atômico por data, sem tabela de lock nova — aqui é só uma linha, não por
conta, então basta uma constante/flag simples numa tabela pequena de
controle, ou reaproveitar o padrão de claim condicional direto numa linha
fixa).

Pra cada `ai_meeting_intents` com `resolved_at is null`, criada há mais de
15 minutos (evita correr com uma tentativa ainda em andamento) e dentro dos
últimos 14 dias:

- Resolve o negócio real (cria se não existir — mesma lógica de
  `findOpenDealForContact`/`createDealForContact`, extraída pra ser
  reaproveitada aqui).
- Se `meeting_at` ainda for "acionável" (futuro, ou até ~3h no passado):
  tenta completar o que faltar — mover etapa, criar evento no Calendar,
  mandar a mensagem do link. Sucesso → marca `resolved_at`/`resolution='completed'`.
- Se `meeting_at` já passou de forma significativa (mais de ~3h) e a coisa
  nunca foi concluída: não cria um evento de calendário retroativo. Em vez
  disso manda uma mensagem curta perguntando se querem reagendar, e marca
  `resolved_at`/`resolution='stale_rescheduled'`.
- Qualquer falha na tentativa (ex: Calendar ainda desconectado) deixa a
  linha sem resolver pra tentar de novo no dia seguinte — limitado a 14
  dias, não tenta pra sempre.

Cada resultado gera uma linha de log clara (`[reconcile-meetings] ...`) e
soma num contador que entra na resposta JSON do cron, mesmo padrão de
`sdr_ia_processed` etc. — sem UI nova, só visibilidade em log por agora.

### 4. Fora de escopo (lembrar, não construir agora)

- UI/dashboard mostrando o histórico de `ai_meeting_intents` — pode virar
  um painel depois, mas o pedido de hoje é a correção automática, não a
  visualização.
- Alertas proativos (WhatsApp/e-mail pro usuário) quando algo precisa de
  reagendamento manual — o item "stale_rescheduled" já resolve com uma
  mensagem pro PRÓPRIO lead; avisar o time da Fuse fica pra uma iteração
  futura se o volume justificar.
