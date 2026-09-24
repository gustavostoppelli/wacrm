# Integração com Instagram (gatilhos de automação) — Design

**Data:** 2026-09-24
**Status:** Aprovado para plano de implementação
**Escopo:** Nova função nativa do FuseHub que conecta a conta Instagram Business de um cliente (via OAuth oficial da Meta, nunca login/senha) e permite usar 2 eventos do Instagram — comentário em post e mensagem via Direct — como gatilho no motor de automações (Flows) já existente. Sem inbox unificado, sem resposta automática pelo Instagram nesta fase.

## Contexto — por que não é mais simples

O usuário já usa uma integração parecida no ClickFunnels e pediu explicitamente que esta seja feita da forma mais segura possível, sem risco de banimento da conta. Isso descarta qualquer automação via navegador/scraping simulando login — o único caminho seguro é a **Instagram Graph API / Meta for Developers**, via OAuth oficial ("Fazer login com o Facebook"), a mesma família de API que a integração de WhatsApp do FuseHub já usa hoje.

Essa escolha traz duas limitações reais, já validadas com o usuário durante o brainstorming:

1. **"Novo seguidor" não existe como evento oficial.** A Graph API não expõe quem te seguiu, só um contador agregado. Como não dá pra identificar a pessoa, esse gatilho foi **descartado** — qualquer ferramenta que ofereça isso de forma granular está usando um método não-oficial.
2. **Contas precisam ser Instagram Business/Creator vinculadas a uma Página do Facebook.** O usuário confirmou que já tem esse requisito atendido nas contas relevantes.

## Decisões desta fase

1. **Escopo dos gatilhos:** só 2 eventos, ambos oficiais e em tempo real — comentário em post (`instagram_comment_received`) e mensagem via Direct (`instagram_dm_received`).
2. **Só gatilho, nunca resposta pelo Instagram.** As ações disponíveis na automação continuam sendo as que já existem hoje (enviar WhatsApp, tag, mudar etapa do pipeline, notificar equipe, esperar, webhook). Nenhum código novo de *envio* via Instagram é construído nesta fase.
3. **Sem inbox unificado.** Comentários e DMs do Instagram não geram uma "conversa" navegável no Inbox do FuseHub — servem só como gatilho de automação. Isso evita replicar toda a UI de conversas para um canal que não terá resposta.
4. **Conexão via OAuth oficial, nunca login/senha.** Fluxo "Fazer login com o Facebook" — o FuseHub nunca vê nem armazena a senha do cliente, só um token de acesso emitido pela Meta após autorização explícita.
5. **Contato "leve" sem telefone.** Quem comenta ou manda Direct vira um `contact` no CRM identificado só por `instagram_id` (IGSID) + `instagram_username`, mesmo sem telefone — isso exige tornar `contacts.phone` opcional (hoje é `NOT NULL`).
6. **Controle de acesso — mesmo padrão do SDR IA:** nova coluna `accounts.instagram_enabled` (boolean, default `false`). Ativada por padrão só na conta da Fuse; liberada por exceção via SQL direto quando o usuário pedir para um cliente específico.
7. **Reaproveita o Meta App existente.** `META_APP_ID`/`META_APP_SECRET` (já usados pela integração de WhatsApp) ganham permissões extras (`pages_show_list`, `pages_read_engagement`, `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`), sem criar um novo app.
8. **Sem revisão da Meta (App Review) nesta fase.** Como o app permanece em modo desenvolvimento para essas permissões avançadas, só Admin/Developer/Tester do App conseguem autorizar — cobre a conta da Fuse e qualquer cliente liberado por exceção (que precisa ser adicionado como Tester do App). Abrir para qualquer cliente conectar sozinho exigiria submeter o app para revisão completa da Meta (semanas, com verificação de negócio) — fora de escopo agora, dado que o controle de acesso é por exceção manual (decisão 6).

## Modelo de dados

### Nova tabela `instagram_config`

| coluna | tipo | notas |
|---|---|---|
| `id` | uuid, PK | |
| `account_id` | uuid, FK → `accounts` | tenancy |
| `user_id` | uuid, FK → `auth.users` | quem conectou |
| `page_id` | text | ID da Página do Facebook vinculada |
| `ig_user_id` | text, UNIQUE | ID da conta Instagram Business — chave de roteamento do webhook |
| `ig_username` | text | exibido na UI |
| `access_token` | text | token de Página de longa duração, criptografado (AES-256-GCM, mesma convenção de `whatsapp_config.access_token`) |
| `token_expires_at` | timestamptz, nullable | best-effort; tokens de Página tendem a não expirar enquanto o Admin não revogar |
| `status` | text, `'connected'` \| `'disconnected'` | |
| `connected_at` | timestamptz | |
| `webhook_subscribed_at` | timestamptz, nullable | quando `/{page-id}/subscribed_apps` foi confirmado |
| `created_at` / `updated_at` | timestamptz | |

RLS por `account_id` via `is_account_member`, mesmo padrão de toda tabela nova do produto. Sem política de INSERT/UPDATE direta do cliente — só a rota de callback OAuth (service role) escreve.

### Alterações em `contacts`

- `phone` deixa de ser `NOT NULL` (migração relaxa a constraint).
- Novas colunas nullable: `instagram_id` (IGSID, único por conta) e `instagram_username`.
- Auditoria necessária: todo código que hoje assume `contacts.phone` sempre existe (principalmente as rotinas de envio de WhatsApp e resolução de conversa) precisa ser revisado durante a implementação para tratar `phone IS NULL` como "esse contato não tem canal de WhatsApp ainda" em vez de quebrar.

### `accounts.instagram_enabled`

Boolean, default `false`. Mesma convenção documentada em `AGENTS.md` ("Per-account feature flags") já usada por `sdr_ia_enabled`.

### Novos tipos de gatilho em `automations`

Nenhuma mudança estrutural — `automations.trigger_type`/`trigger_config` já são genéricos (`TEXT`/`JSONB`). Dois novos valores de `trigger_type`:

- `instagram_comment_received` — `trigger_config` opcional no mesmo formato de `KeywordMatchTriggerConfig` (`keywords`, `match_type`, `case_sensitive`), para o padrão "comenta X no post → dispara". Sem `keywords`, dispara em qualquer comentário.
- `instagram_dm_received` — sem filtro nesta fase (dispara em qualquer Direct recebido).

## Fluxo de conexão (OAuth)

1. Cliente clica em "Conectar Instagram" (Configurações → nova aba "Instagram", ao lado de WhatsApp).
2. `GET /api/instagram/oauth/start` redireciona para `facebook.com/dialog/oauth` com as permissões listadas na decisão 7 e um `state` assinado (HMAC) carregando `account_id`, para proteção CSRF e para saber qual conta concluiu o fluxo no callback.
3. Na tela da própria Meta, o cliente escolhe qual Página do Facebook (com Instagram Business vinculado) autorizar. Nunca há campo de usuário/senha do Instagram no FuseHub.
4. `GET /api/instagram/oauth/callback`:
   - Valida o `state`.
   - Troca o `code` por um token de usuário de curta duração, troca esse por um **token de longa duração** (`~60 dias`, endpoint `fb_exchange_token`).
   - Busca as Páginas do usuário (`/me/accounts`) e o `instagram_business_account.id` de cada uma.
   - Grava/atualiza `instagram_config` (token criptografado).
   - Assina a Página nos webhooks (`/{page-id}/subscribed_apps`, campos `comments` e `messages`), marcando `webhook_subscribed_at`.
5. Redireciona de volta para Configurações com sucesso/erro.

## Webhook e roteamento

**Endpoint único** `/api/instagram/webhook`, registrado a nível de App na Meta (não por conta):

- `GET`: responde ao handshake `hub.challenge` de verificação.
- `POST`: valida assinatura HMAC (`X-Hub-Signature-256`, mesma verificação já usada no webhook do WhatsApp com `META_APP_SECRET`), processa o payload, e **sempre responde `200` rapidamente** (mesmo em erro interno) — a Meta desativa a assinatura de um webhook que responde 5xx/timeout repetidamente, mesmo padrão já seguido no webhook do WhatsApp.
- Dedupe por id do evento (mesma ideia usada no webhook do Asaas) — a Meta reenvia eventos em modelo "at least once".

**Processamento de cada evento:**

1. Extrai `ig_user_id` do payload (a conta que recebeu o comentário/DM).
2. Busca `instagram_config` por `ig_user_id` → resolve `account_id`. Sem match, descarta o evento silenciosamente (loga um aviso).
3. Busca (ou cria) o `contact` da conta por `instagram_id` — se não existir, cria com `instagram_id` + `instagram_username`, sem telefone.
4. Chama `runAutomationsForTrigger({ accountId, triggerType, contactId, context: { message_text } })` (função já existente em `src/lib/automations/engine.ts`, sem nenhuma mudança nela) — o motor cuida do resto: filtro de palavra-chave (para `instagram_comment_received`), tag, pipeline, notificação, etc.

## Cron de saúde da conexão

Estende `/api/automations/cron` com uma função irmã das já existentes (ex. `checkInstagramConnections`):
- Roda periodicamente (mesma cadência do cron existente).
- Para cada `instagram_config` com `status = 'connected'`, faz uma chamada leve à Graph API para confirmar que o token ainda é válido.
- Em caso de falha, marca `status = 'disconnected'` — a tela de Configurações mostra o aviso de reconexão, mesmo padrão de UX já usado pelo WhatsApp (`needs_reset`).

## Erros e limites

- Falha ao criar/achar contato aborta o processamento daquele evento (logado), mas nunca derruba o webhook nem afeta outros eventos.
- Falha em `runAutomationsForTrigger` já é auto-contida (a função captura e loga todo erro internamente, nunca propaga — comportamento existente, reaproveitado sem mudança).
- Token revogado no meio do caminho: o próximo evento daquela conta simplesmente não encontra automações capazes de agir (não há envio nesta fase), e o cron de saúde detecta e avisa na próxima checagem.

## Testes

- Unitários: parsing do payload do webhook (comentário vs DM, formatos reais confirmados durante a implementação), dedupe por id de evento, find-or-create de contato sem telefone (incluindo a colisão com um contato já existente pelo mesmo `instagram_id`).
- `engine.test.ts`: novos casos para `instagram_comment_received` (com e sem filtro de palavra-chave) e `instagram_dm_received`, seguindo o modelo dos testes existentes de `keyword_match`.
- OAuth: teste do `state` assinado (rejeita adulterado/expirado), mock da troca de token e da busca de Páginas.

## Fora de escopo nesta fase

- Gatilho de "novo seguidor" — não existe de forma oficial e identificável (decisão já validada com o usuário).
- Qualquer resposta automática pelo Instagram (DM ou comentário) — a automação só *reage*, nunca *responde* pelo Instagram.
- Inbox unificado para conversas do Instagram.
- App Review da Meta / abertura para qualquer cliente conectar sozinho sem intervenção manual — controle de acesso continua por exceção manual, como o SDR IA.
- Checkout/pagamento automático para liberar `instagram_enabled` — mesmo padrão do SDR IA (tela de bloqueio com contato manual ao suporte, se aplicável; decisão de UI de bloqueio fica para a fase de implementação, replicando o padrão já usado pelo SDR IA).
- Refresh automático de token antes de expirar — nesta fase só há detecção (cron de saúde) e reconexão manual pelo cliente.
