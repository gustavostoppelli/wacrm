# SDR IA como função nativa do FuseHub — Design

**Data:** 2026-09-24
**Status:** Aprovado para plano de implementação
**Escopo:** Transforma o PoC "SDR de IA" (hoje um script externo em `opensquad/skills/sdr-frio/`, só-Fuse) numa função nativa e multi-tenant do produto `wacrm`, pronta para ser vendida como serviço adicional a qualquer cliente do FuseHub no futuro.

## Contexto — o que existe hoje

Ver `d:\Agencia Fuse IA\docs\superpowers\specs\2026-09-22-sdr-ia-fusehub-design.md` (spec anterior, que deliberadamente manteve isso fora do `wacrm`, "só-Fuse", com virar feature de cliente marcado como "decisão e projeto futuros"). Esse futuro chegou.

O PoC atual (`opensquad/skills/sdr-frio/scripts/contato-frio.js`):
- Lê leads de uma planilha Google Sheets (fonte específica da Fuse, não generalizável).
- Roda manualmente/agendado via Task Scheduler do Windows, fora do FuseHub.
- Envia primeiro contato via `POST /api/v1/messages` (texto livre por padrão, ou template Meta via `SDR_FRIO_SEND_MODE=template`).
- Guardrails: horário comercial, teto diário, dedupe via tag `sdr_frio_contatado` no contato, normalização de telefone.
- Suporta teste A/B por arquivo de variantes (`SDR_FRIO_MESSAGE_DIR`), marcando `sdr_frio_variante_<nome>`.

## Decisões desta fase

1. **Fonte de leads dentro do FuseHub:** uma tag de contatos escolhida pelo cliente (ex: "prospecção"). O SDR IA processa contatos com essa tag que ainda não têm a tag de "já contatado" — qualquer fluxo que já existe no FuseHub (importação, Apify, cadastro manual) pode alimentar essa tag, sem depender de planilha externa.
2. **Canal de envio, escolha do usuário:** o cliente escolhe entre **Template aprovado (Meta)** — seguro, exige template já aprovado no WhatsApp Business Manager — ou **Texto livre (UAZAPI)** — mais flexível, mas com aviso de risco de banimento exibido antes de habilitar (mesmo padrão do alerta de fotos clínicas da Capacita).
3. **Mensagens com teste A/B:** até 3 variações de texto quando o modo é "Texto livre" (o template único é usado como está, sem variação, quando o modo é "Template"). Cada envio sorteia uma variante e marca o contato com `sdr_ia_variante_<n>`.
4. **Execução automática:** roda 1x/dia sozinho, dentro do horário comercial configurado, via o mesmo mecanismo de cron que já processa o resumo diário (`/api/automations/cron`) — sem script externo, sem agendador do Windows.
5. **Guardrails configuráveis, com padrão conservador:** horário comercial (início/fim) e teto diário de envios (padrão sugerido: 5/dia, 9h–18h) — editáveis no assistente.
6. **Controle de acesso — preparação para venda futura:** nova coluna `accounts.sdr_ia_enabled` (boolean, default `false`). O item de menu "SDR IA" (abaixo de "Agente de IA" no menu principal) fica **sempre visível**, para toda conta — o bloqueio acontece dentro da própria página, não escondendo a entrada do menu. Segue a convenção já documentada em `AGENTS.md` ("Per-account feature flags").
7. **Página de bloqueio (contas sem a flag — todo cliente, por padrão):** em vez do assistente de configuração, a página `/sdr-ia` mostra uma tela de "recurso bloqueado" com: texto explicando o que é o SDR IA e suas vantagens (resumo do serviço), e um botão "Falar com o suporte" que abre o WhatsApp de suporte da Fuse (reaproveita `supportWhatsAppUrl` de `src/lib/support.ts`, mesmo padrão já usado no popup de limite de canais WhatsApp). Sem checkout nesta fase — fica para uma iteração futura, quando houver forma de pagamento ligada para liberar a flag automaticamente. A conta da Fuse já é ativada com `sdr_ia_enabled = true` via SQL, então vê o assistente de configuração completo (não a tela de bloqueio).

## Modelo de dados

Nova tabela `sdr_ia_config` (uma linha por conta, criada/atualizada pelo assistente de configuração):

| coluna | tipo | notas |
|---|---|---|
| `account_id` | uuid, PK/FK | uma config por conta |
| `enabled` | boolean, default false | liga/desliga a execução automática (independente de `accounts.sdr_ia_enabled`, que controla a *visibilidade* da função) |
| `lead_tag` | text | tag de contatos a processar |
| `contacted_tag` | text, default `'sdr_ia_contatado'` | tag aplicada após o envio, usada para dedupe |
| `whatsapp_config_id` | uuid, FK → `whatsapp_config` | canal usado para enviar |
| `send_mode` | text, `'template' \| 'text'` | |
| `template_name` / `template_language` | text, nullable | usado quando `send_mode = 'template'` |
| `message_variants` | jsonb, array de até 3 strings | usado quando `send_mode = 'text'` |
| `daily_cap` | int, default 5 | |
| `hours_start` / `hours_end` | int (hora local), default 9 / 18 | |
| `updated_at` | timestamptz | |

Isolamento: RLS por `account_id` via `is_account_member`, mesmo padrão de toda tabela nova do produto.

## Assistente de configuração (5 passos, página "SDR IA")

Visível só quando `accounts.sdr_ia_enabled = true` (ver seção anterior sobre a página de bloqueio para as demais contas).

1. **Fonte de leads** — escolher/criar a tag de contatos a processar.
2. **Canal de envio** — escolher o número WhatsApp da conta + modo (Template vs Texto livre, com aviso de risco no segundo caso).
3. **Mensagem(ns)** — template aprovado (se modo Template) ou até 3 variações de texto livre (se modo Texto livre).
4. **Guardrails** — horário comercial e teto diário, com valores padrão pré-preenchidos.
5. **Revisão e ativação** — resumo + botão "Ativar SDR IA" (grava `sdr_ia_config` com `enabled = true`).

Mesmo padrão visual/de interação já usado no "Primeiros Passos" (Settings → Getting Started) e no assistente do resumo diário.

## Execução (cron)

Estende `/api/automations/cron` (ou uma função irmã de `drainDailyDigest`, ex. `drainSdrIa`) chamada no mesmo disparo:
1. Busca contas com `accounts.sdr_ia_enabled = true` **e** `sdr_ia_config.enabled = true`.
2. Pula contas fora do horário comercial configurado (`hours_start`/`hours_end`, fuso America/Sao_Paulo — mesmo padrão do `brazilTodayAndHour()` já usado no digest).
3. Busca contatos da conta com `lead_tag` e sem `contacted_tag`, até o `daily_cap`.
4. Envia via o canal/modo configurado (reaproveita `resolveChannelById` + `createUazapiProvider`/envio de template Meta já existentes).
5. Marca o contato com `contacted_tag` (+ `sdr_ia_variante_<n>` se `send_mode = 'text'`).
6. Falha de envio não bloqueia os próximos contatos da fila; falha ao marcar a tag após envio bem-sucedido é logada como erro (nunca silenciosa) — mesmo espírito do PoC atual ("ENVIADO MAS NAO MARCADO").

Depois que o lead responde, a IA nativa do FuseHub (Agentes de IA, já existente) assume a conversa normalmente — nenhuma mudança nessa parte.

## Fora de escopo nesta fase

- **Checkout/pagamento automático** para liberar `sdr_ia_enabled` — a página de bloqueio (decisão 7) tem só texto + botão de contato manual com o suporte nesta fase; nenhuma integração de cobrança é construída agora. O texto de vantagens/resumo do serviço é redigido durante a implementação e revisado com o usuário antes de publicar, não fixado palavra por palavra nesta spec.
- Descomissionar o script `opensquad/skills/sdr-frio/` — pode continuar existindo em paralelo até a função nativa estar validada na própria conta da Fuse; desligar o script antigo é um passo manual posterior, não código.
- Monitoramento automático de quality rating do número WhatsApp — checagem manual no Meta Business Manager, como já era.
- Suporte a mais de 1 tag de origem ou a "negócio em etapa X" como fonte de leads (opção considerada e descartada nesta fase a favor de tags, mais simples).
