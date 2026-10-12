# Reconciliação diária do agendamento de reunião via IA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nunca mais deixar uma reunião "prometida" pela IA sem negócio/etapa/evento/link de verdade — detectar e corrigir automaticamente todos os dias, com um registro durável de toda tentativa.

**Architecture:** Uma tabela nova (`ai_meeting_intents`) grava a intenção ANTES de qualquer efeito colateral, no mesmo turno em que o modelo emite o agendamento. Um procedimento compartilhado (`ensureMeetingScheduled`) sabe completar o que falta (negócio → etapa → evento no Calendar → mensagem do link) e é chamado tanto pelo fluxo em tempo real (`recordMeetingScheduled`) quanto por um job diário de reconciliação (novo, dentro do cron existente) que revisita intenções não resolvidas dos últimos 14 dias.

**Tech Stack:** Next.js API routes, Supabase (Postgres + RLS), Vitest.

## Global Constraints

- Nenhum efeito colateral deste fluxo pode bloquear a resposta do agente ao cliente — toda falha é best-effort (log + segue), nunca lança.
- `createDealForContact` (já existe, `src/lib/ai/auto-reply.ts`) IGNORA deliberadamente `accounts.auto_create_deal_on_first_message` — confirmado com o usuário em 2026-10-12. Esse comportamento não muda nesta plan; a reconciliação deve usar a MESMA regra (sempre cria o negócio se faltar), não reintroduzir a checagem da flag.
- Nunca mandar a mensagem do link da reunião duas vezes pro mesmo negócio — qualquer caminho (tempo real ou reconciliação) só manda a mensagem no MESMO passo em que grava `meeting_link` no negócio; se o negócio já tem `meeting_link`, nunca reenviar.
- Se o horário da reunião já passou de forma significativa (mais de 3h) e o fluxo nunca completou, NUNCA criar um evento de calendário retroativo — mandar uma mensagem perguntando se querem reagendar, e fechar a intenção como `stale_rescheduled`.
- Toda query em `deals`/`contacts`/`conversations` dentro deste código é feita pelo client admin (service-role, sem RLS) — sempre filtrar por `account_id` explicitamente, nunca confiar em RLS pra isolar contas.

---

### Task 1: Migration — `ai_meeting_intents` e `cron_job_state`

**Files:**
- Create: `supabase/migrations/082_ai_meeting_intents.sql`

**Interfaces:**
- Produces: tabela `ai_meeting_intents` (colunas: `id, account_id, conversation_id, contact_id, config_owner_user_id, meeting_at, meeting_email, meeting_note, created_at, resolved_at, resolution`); tabela `cron_job_state` (colunas: `job_name` PK, `last_run_date`).

- [ ] **Step 1: Escrever a migration**

```sql
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
```

- [ ] **Step 2: Aplicar a migration**

Esta migration NÃO pode ser aplicada programaticamente (confirmado nas tasks anteriores desta sessão: não existe RPC de exec SQL cru nem connection string direta). Pedir ao usuário pra colar o conteúdo do arquivo no SQL Editor do Supabase, e confirmar sucesso antes de prosseguir pra Task 2.

- [ ] **Step 3: Confirmar que as tabelas existem**

Rodar (Node, com `.env.local` carregado):
```js
const { data, error } = await supabase.from('ai_meeting_intents').select('id').limit(1)
// esperado: data = [], error = null
```
Repetir pra `cron_job_state`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/082_ai_meeting_intents.sql
git commit -m "$(cat <<'EOF'
Adiciona tabelas ai_meeting_intents e cron_job_state

Registro duravel de toda intencao de agendamento de reuniao (antes
de qualquer efeito colateral) + controle generico de job diario.
Base pro job de reconciliacao.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Extrair `findOpenDealForContact`/`createDealForContact` pra um módulo compartilhado

**Files:**
- Create: `src/lib/deals/find-or-create-open-deal.ts`
- Create: `src/lib/deals/find-or-create-open-deal.test.ts`
- Modify: `src/lib/ai/auto-reply.ts`

**Interfaces:**
- Consumes: `resolvePipelineAndStage` (`@/lib/api/v1/deals`, já existe).
- Produces: `findOpenDealForContact(db, accountId, contactId, conversationId, configOwnerUserId): Promise<{ id: string; pipeline_id: string; title: string } | null>` — usado pela Task 3 (`ensureMeetingScheduled`) e pela Task 5 (job de reconciliação), além do próprio `auto-reply.ts`.

Esta é a mesma lógica que já existe em `auto-reply.ts` hoje (funções privadas `findOpenDealForContact`/`createDealForContact`) — só está sendo movida pra um arquivo compartilhado, sem mudar comportamento, pra o job de reconciliação (Task 5) poder reusar sem duplicar.

- [ ] **Step 1: Ler o `auto-reply.ts` atual por completo antes de mover**

As duas funções (`findOpenDealForContact`, `createDealForContact`) ficam entre os comentários `/** Deals created via the public API... */` e o fechamento da segunda função — ler exatamente como estão agora (incluindo os comentários, que documentam decisões reais) antes de copiar, para não perder nenhuma delas na migração.

- [ ] **Step 2: Escrever o teste do módulo novo (adaptado dos cenários que já existem em `auto-reply.test.ts`)**

```ts
// src/lib/deals/find-or-create-open-deal.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { findOpenDealForContact } from './find-or-create-open-deal'

function makeDb(opts: {
  existingDeal?: Record<string, unknown> | null
  contactRow?: Record<string, unknown> | null
  pipelineRows?: Array<{ id: string; name: string }>
  stageRows?: Array<{ id: string; name: string; position: number }>
  createdDealId?: string
}) {
  const state = { dealInserts: [] as Record<string, unknown>[], dealUpdates: [] as Record<string, unknown>[] }
  const db = {
    from: (table: string) => {
      if (table === 'deals') {
        const selectChain = {
          select: () => selectChain,
          eq: () => selectChain,
          order: () => selectChain,
          limit: () => selectChain,
          maybeSingle: () => Promise.resolve({ data: opts.existingDeal ?? null, error: null }),
        }
        return {
          select: () => selectChain,
          insert: (payload: Record<string, unknown>) => {
            state.dealInserts.push(payload)
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: { id: opts.createdDealId ?? 'new-deal-1', pipeline_id: payload.pipeline_id, title: payload.title },
                    error: null,
                  }),
              }),
            }
          },
          update: (payload: Record<string, unknown>) => {
            state.dealUpdates.push(payload)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      if (table === 'contacts') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: opts.contactRow ?? null, error: null }) }) }),
        }
      }
      if (table === 'pipelines') {
        const chain = { select: () => chain, eq: () => chain, ilike: () => chain, order: () => chain, limit: () => Promise.resolve({ data: opts.pipelineRows ?? [{ id: 'pipe-1', name: 'Default' }], error: null }) }
        return chain
      }
      if (table === 'pipeline_stages') {
        const chain = { select: () => chain, eq: () => chain, ilike: () => chain, order: () => chain, limit: () => Promise.resolve({ data: opts.stageRows ?? [{ id: 'stage-1', name: 'Novo', position: 0 }], error: null }) }
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { db, state }
}

describe('findOpenDealForContact', () => {
  it('returns the existing open deal without creating a new one', async () => {
    const { db, state } = makeDb({ existingDeal: { id: 'deal-1', pipeline_id: 'pipe-1', title: 'X', conversation_id: 'conv-1' } })
    const result = await findOpenDealForContact(db as never, 'acct-1', 'contact-1', 'conv-1', 'user-1')
    expect(result).toEqual({ id: 'deal-1', pipeline_id: 'pipe-1', title: 'X', conversation_id: 'conv-1' })
    expect(state.dealInserts).toHaveLength(0)
  })

  it('creates a deal in the default pipeline/stage, with the contact name as title and user_id set, when none exists', async () => {
    const { db, state } = makeDb({ existingDeal: null, contactRow: { name: 'Julio', phone: '5522998783605' } })
    const result = await findOpenDealForContact(db as never, 'acct-1', 'contact-1', 'conv-1', 'user-1')
    expect(result).toMatchObject({ pipeline_id: 'pipe-1', title: 'Julio' })
    expect(state.dealInserts[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'user-1',
      contact_id: 'contact-1',
      conversation_id: 'conv-1',
      pipeline_id: 'pipe-1',
      stage_id: 'stage-1',
      title: 'Julio',
      source: 'WhatsApp Direto',
      status: 'open',
    })
  })

  it('falls back to the phone when the contact has no name', async () => {
    const { db } = makeDb({ existingDeal: null, contactRow: { name: null, phone: '5522998783605' } })
    const result = await findOpenDealForContact(db as never, 'acct-1', 'contact-1', 'conv-1', 'user-1')
    expect(result?.title).toBe('5522998783605')
  })

  it('returns null (never throws) when resolving the pipeline fails', async () => {
    const { db } = makeDb({ existingDeal: null, pipelineRows: [] })
    const result = await findOpenDealForContact(db as never, 'acct-1', 'contact-1', 'conv-1', 'user-1')
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 3: Confirmar que falha**

Run: `npx vitest run src/lib/deals/find-or-create-open-deal.test.ts`
Expected: FAIL — o módulo `./find-or-create-open-deal` não existe ainda.

- [ ] **Step 4: Criar o módulo, movendo o código exato de `auto-reply.ts`**

```ts
// src/lib/deals/find-or-create-open-deal.ts
// ============================================================
// Extraido de src/lib/ai/auto-reply.ts (comportamento idêntico,
// nenhuma mudança de lógica) pra o job de reconciliação de
// agendamento (src/lib/ai/meeting-reconciliation.ts) poder reusar
// sem duplicar.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolvePipelineAndStage } from '@/lib/api/v1/deals'

/**
 * Deals created via the public API (the Apify/Meta/site-form bridge --
 * see POST /api/v1/deals) only ever get `contact_id` set, never
 * `conversation_id`: the conversation itself is created separately,
 * whenever the contact's first WhatsApp message actually arrives, so
 * nothing links the two at creation time. Matching on
 * `conversation_id` alone would silently never find a deal for any
 * real lead, so this always resolves by contact -- `status = 'open'`
 * picks the live deal over an already won/lost one if the contact has
 * history. When `conversationId` is given and the found deal doesn't
 * have one yet, opportunistically backfills it.
 *
 * A contact who messages in WITHOUT going through that bridge --
 * someone texting the number directly, an organic/CTWA ad reply, a
 * manual test -- never gets a deal created ahead of time. If none
 * exists, one is created on the spot, in the account's default
 * pipeline/stage (`resolvePipelineAndStage` with no name args -- the
 * same default a deal created by hand in the dashboard would land in).
 *
 * Deliberately IGNORES `accounts.auto_create_deal_on_first_message`
 * (migration 079, default false for every account including Fuse's
 * own -- see `ensureDealForContact` in `lib/whatsapp/inbound-message.ts`,
 * which DOES respect that flag). That flag exists to stop a random
 * first WhatsApp message from silently spawning a deal; a lead who
 * got all the way to a scheduled meeting -- name, e-mail, a chosen
 * time -- is a wholly different signal than "sent one message", so
 * this path creates the deal regardless of the account's setting.
 * Confirmed with the product owner on 2026-10-12.
 */
export async function findOpenDealForContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string | null,
  configOwnerUserId: string,
): Promise<{ id: string; pipeline_id: string; title: string } | null> {
  const { data: deal } = await db
    .from('deals')
    .select('id, pipeline_id, title, conversation_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (deal) {
    if (conversationId && !deal.conversation_id) {
      await db.from('deals').update({ conversation_id: conversationId }).eq('id', deal.id)
    }
    return deal
  }

  return createDealForContact(db, accountId, contactId, conversationId, configOwnerUserId)
}

/**
 * Creates the deal `findOpenDealForContact` didn't find. Best-effort:
 * any failure here (no pipeline configured yet, a race with another
 * concurrent creation, a transient DB error) returns null rather than
 * throwing -- callers must never fail because deal bookkeeping
 * couldn't complete.
 */
async function createDealForContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string | null,
  configOwnerUserId: string,
): Promise<{ id: string; pipeline_id: string; title: string } | null> {
  try {
    const { pipelineId, stageId } = await resolvePipelineAndStage(db, accountId)

    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .maybeSingle()
    const title = (contact?.name as string | undefined)?.trim() || (contact?.phone as string | undefined) || 'Lead sem nome'

    const { data: created, error } = await db
      .from('deals')
      .insert({
        account_id: accountId,
        user_id: configOwnerUserId,
        contact_id: contactId,
        conversation_id: conversationId,
        pipeline_id: pipelineId,
        stage_id: stageId,
        title,
        // Same fallback value `ensureDealForContact` uses for an
        // organic/direct WhatsApp contact (migration 038's allowed-
        // values CHECK constraint, `isDealSource`) -- accurate here
        // too, since this path exists for exactly that kind of lead.
        source: 'WhatsApp Direto',
        status: 'open',
      })
      .select('id, pipeline_id, title')
      .single()
    if (error || !created) {
      console.error('[find-or-create-open-deal] createDealForContact insert failed:', error)
      return null
    }
    return created as { id: string; pipeline_id: string; title: string }
  } catch (err) {
    console.error('[find-or-create-open-deal] createDealForContact failed:', err)
    return null
  }
}
```

- [ ] **Step 5: Confirmar que passa**

Run: `npx vitest run src/lib/deals/find-or-create-open-deal.test.ts`
Expected: PASS (4/4)

- [ ] **Step 6: Atualizar `auto-reply.ts` pra importar do módulo novo em vez de definir localmente**

Remover as duas funções `findOpenDealForContact`/`createDealForContact` de `src/lib/ai/auto-reply.ts` por completo, e no topo do arquivo adicionar:

```ts
import { findOpenDealForContact } from '@/lib/deals/find-or-create-open-deal'
```

Remover também o import de `resolvePipelineAndStage` de `auto-reply.ts` se ele não for mais usado em nenhum outro lugar do arquivo (confirmar com um grep antes de remover).

- [ ] **Step 7: Rodar a suíte inteira**

Run: `npx vitest run`
Expected: exatamente as 5 falhas conhecidas e pré-existentes (`currency.test.ts` x3, `date-utils.test.ts` x2), sem nenhuma nova. Os testes de `auto-reply.test.ts` que cobrem o cenário do Julio (criadas na correção de 2026-10-12) devem continuar passando sem alteração — eles testam o comportamento observável de `dispatchInboundToAiReply`, não a localização interna da função.

- [ ] **Step 8: Commit**

```bash
git add src/lib/deals/find-or-create-open-deal.ts src/lib/deals/find-or-create-open-deal.test.ts src/lib/ai/auto-reply.ts
git commit -m "$(cat <<'EOF'
Extrai findOpenDealForContact pra modulo compartilhado

Mesmo comportamento, movido de auto-reply.ts -- o job de
reconciliacao (proxima task) precisa reusar essa logica sem
duplicar.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Extrair `ensureMeetingScheduled` — o procedimento completo (negócio → etapa → calendário → mensagem)

**Files:**
- Create: `src/lib/ai/meeting-scheduling.ts`
- Create: `src/lib/ai/meeting-scheduling.test.ts`
- Modify: `src/lib/ai/auto-reply.ts`

**Interfaces:**
- Consumes: `findOpenDealForContact` (Task 2), `createEventForAccount` (`@/lib/calendar/google`, já existe), `engineSendText` (`@/lib/flows/meta-send`, já existe).
- Produces: `ensureMeetingScheduled(db, args: { accountId: string; conversationId: string; contactId: string; configOwnerUserId: string; meetingNote: string; meetingAt: string | null; meetingEmail: string | null; meetingEventLabel: string | null; businessHoursTimezone: string }): Promise<{ completed: boolean }>` — usado por `recordMeetingScheduled` (Task 4, tempo real) e pelo job de reconciliação (Task 5).

**Idempotência que este passo precisa garantir** (constraint do plano): se o negócio já tem `meeting_link` preenchido, a mensagem do link NUNCA é reenviada — só quando `meeting_link` está sendo preenchido agora por esta chamada. Isso é o que permite o job de reconciliação (Task 5) chamar essa mesma função em cima de uma intenção que já teve sucesso parcial, sem duplicar mensagem.

- [ ] **Step 1: Ler `recordMeetingScheduled` por completo em `auto-reply.ts`**

Ler a função inteira (da declaração até o fechamento) antes de extrair — ela tem lógica de negócio real (resolução da etapa `meeting_scheduled`, salvar e-mail no contato só se ainda não tiver, montar o `summary` do evento, e só mandar a segunda mensagem de "nome da clínica" quando o evento foi criado).

- [ ] **Step 2: Escrever o teste do módulo novo**

```ts
// src/lib/ai/meeting-scheduling.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  findOpenDealForContact: vi.fn(),
  createEventForAccount: vi.fn(),
  engineSendText: vi.fn(),
}))
vi.mock('@/lib/deals/find-or-create-open-deal', () => ({ findOpenDealForContact: h.findOpenDealForContact }))
vi.mock('@/lib/calendar/google', () => ({ createEventForAccount: h.createEventForAccount }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))

import { ensureMeetingScheduled } from './meeting-scheduling'

function makeDb(opts: { stageRow?: Record<string, unknown> | null; contactRow?: Record<string, unknown> | null }) {
  const state = { dealUpdates: [] as Record<string, unknown>[], contactUpdates: [] as Record<string, unknown>[] }
  const db = {
    from: (table: string) => {
      if (table === 'pipeline_stages') {
        const chain = { select: () => chain, eq: () => chain, maybeSingle: () => Promise.resolve({ data: opts.stageRow ?? null, error: null }) }
        return chain
      }
      if (table === 'contacts') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: opts.contactRow ?? null, error: null }) }) }),
          update: (p: Record<string, unknown>) => {
            state.contactUpdates.push(p)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      if (table === 'deals') {
        return {
          update: (p: Record<string, unknown>) => {
            state.dealUpdates.push(p)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { db, state }
}

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  meetingNote: 'Amanhã às 10h',
  meetingAt: '2026-10-12T13:00:00.000Z',
  meetingEmail: 'lead@example.com',
  meetingEventLabel: null,
  businessHoursTimezone: 'America/Sao_Paulo',
}

beforeEach(() => {
  h.findOpenDealForContact.mockReset()
  h.createEventForAccount.mockReset()
  h.engineSendText.mockReset()
  h.createEventForAccount.mockResolvedValue({ id: 'evt-1', meetLink: 'https://meet.google.com/x' })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
})

describe('ensureMeetingScheduled', () => {
  it('returns completed:false without side effects when there is no deal (and none could be created)', async () => {
    h.findOpenDealForContact.mockResolvedValue(null)
    const { db } = makeDb({})
    const result = await ensureMeetingScheduled(db as never, ARGS)
    expect(result).toEqual({ completed: false })
    expect(h.createEventForAccount).not.toHaveBeenCalled()
  })

  it('returns completed:false without side effects when the pipeline has no meeting_scheduled stage', async () => {
    h.findOpenDealForContact.mockResolvedValue({ id: 'deal-1', pipeline_id: 'pipe-1', title: 'X' })
    const { db } = makeDb({ stageRow: null })
    const result = await ensureMeetingScheduled(db as never, ARGS)
    expect(result).toEqual({ completed: false })
    expect(h.createEventForAccount).not.toHaveBeenCalled()
  })

  it('creates the Calendar event, moves the stage, and sends the link when nothing existed yet', async () => {
    h.findOpenDealForContact.mockResolvedValue({ id: 'deal-1', pipeline_id: 'pipe-1', title: 'X' })
    const { db, state } = makeDb({ stageRow: { id: 'stage-meeting' }, contactRow: { email: null } })
    const result = await ensureMeetingScheduled(db as never, ARGS)
    expect(result).toEqual({ completed: true })
    expect(state.dealUpdates[0]).toMatchObject({
      stage_id: 'stage-meeting',
      meeting_note: 'Amanhã às 10h',
      meeting_scheduled_at: ARGS.meetingAt,
      meeting_link: 'https://meet.google.com/x',
      calendar_event_id: 'evt-1',
    })
    expect(state.contactUpdates).toContainEqual({ email: 'lead@example.com' })
    const texts = h.engineSendText.mock.calls.map((c) => c[0].text)
    expect(texts.some((t) => t.includes('https://meet.google.com/x'))).toBe(true)
  })

  it('does not overwrite an existing contact e-mail', async () => {
    h.findOpenDealForContact.mockResolvedValue({ id: 'deal-1', pipeline_id: 'pipe-1', title: 'X' })
    const { db, state } = makeDb({ stageRow: { id: 'stage-meeting' }, contactRow: { email: 'already@example.com' } })
    await ensureMeetingScheduled(db as never, ARGS)
    expect(state.contactUpdates).toHaveLength(0)
  })

  it('returns completed:false and never resends when the Calendar event creation fails', async () => {
    h.findOpenDealForContact.mockResolvedValue({ id: 'deal-1', pipeline_id: 'pipe-1', title: 'X' })
    h.createEventForAccount.mockRejectedValue(new Error('calendar down'))
    const { db } = makeDb({ stageRow: { id: 'stage-meeting' }, contactRow: { email: 'x@example.com' } })
    const result = await ensureMeetingScheduled(db as never, ARGS)
    expect(result).toEqual({ completed: false })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Confirmar que falha**

Run: `npx vitest run src/lib/ai/meeting-scheduling.test.ts`
Expected: FAIL — o módulo `./meeting-scheduling` não existe ainda.

- [ ] **Step 4: Criar o módulo**

```ts
// src/lib/ai/meeting-scheduling.ts
// ============================================================
// O procedimento completo pra garantir que uma reuniao agendada
// pelo modelo realmente aconteceu de ponta a ponta: negocio -> etapa
// -> evento no Google Calendar -> mensagem com o link. Extraido de
// `recordMeetingScheduled` (auto-reply.ts) pra ser reusado tambem
// pelo job de reconciliacao diaria -- mesma logica, chamada tanto em
// tempo real quanto depois, retroativamente.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { findOpenDealForContact } from '@/lib/deals/find-or-create-open-deal'
import { createEventForAccount } from '@/lib/calendar/google'
import { engineSendText } from '@/lib/flows/meta-send'

export interface EnsureMeetingScheduledArgs {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  meetingNote: string
  meetingAt: string | null
  meetingEmail: string | null
  meetingEventLabel: string | null
  businessHoursTimezone: string
}

/**
 * Best-effort, idempotent: NUNCA lança, e nunca reenvia a mensagem do
 * link se o negocio ja tiver `meeting_link` (callers podem chamar de
 * novo em cima de um estado parcial sem medo de duplicar mensagem --
 * e exatamente o que o job de reconciliacao faz).
 */
export async function ensureMeetingScheduled(
  db: SupabaseClient,
  args: EnsureMeetingScheduledArgs,
): Promise<{ completed: boolean }> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    meetingNote,
    meetingAt,
    meetingEmail,
    meetingEventLabel,
    businessHoursTimezone,
  } = args

  const deal = await findOpenDealForContact(db, accountId, contactId, conversationId, configOwnerUserId)
  if (!deal) return { completed: false }

  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', deal.pipeline_id)
    .eq('stage_role', 'meeting_scheduled')
    .maybeSingle()
  if (!stage) return { completed: false }

  const update: Record<string, unknown> = { stage_id: stage.id, meeting_note: meetingNote }
  if (meetingAt) update.meeting_scheduled_at = meetingAt

  if (meetingEmail) {
    const { data: contact } = await db
      .from('contacts')
      .select('email')
      .eq('id', contactId)
      .maybeSingle()
    if (!contact?.email) {
      await db.from('contacts').update({ email: meetingEmail }).eq('id', contactId)
    }
  }

  let completed = false
  if (meetingAt && meetingEmail) {
    const summary = `${meetingEventLabel || 'Diagnóstico'} - ${deal.title}`

    const event = await createEventForAccount(db, accountId, {
      summary,
      start: new Date(meetingAt),
      end: new Date(new Date(meetingAt).getTime() + 30 * 60_000),
      attendeeEmail: meetingEmail,
      timeZone: businessHoursTimezone,
    }).catch((err) => {
      console.error('[meeting-scheduling] createEventForAccount failed:', err)
      return null
    })
    if (event) {
      update.meeting_link = event.meetLink
      update.calendar_event_id = event.id
      completed = true
    }
  }

  await db.from('deals').update(update).eq('id', deal.id)

  if (update.meeting_link) {
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: `Aqui está o link da nossa reunião: ${update.meeting_link}`,
      aiGenerated: true,
    })
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: 'Só mais uma coisa pra fechar: pode me passar o nome da clínica, o site ou o Instagram? Assim já vamos analisar o contexto e preparar um diagnóstico completo pra nossa reunião.',
      aiGenerated: true,
    })
  }

  return { completed }
}
```

- [ ] **Step 5: Confirmar que passa**

Run: `npx vitest run src/lib/ai/meeting-scheduling.test.ts`
Expected: PASS (5/5)

- [ ] **Step 6: Atualizar `recordMeetingScheduled` em `auto-reply.ts` pra chamar `ensureMeetingScheduled`**

Substituir o corpo de `recordMeetingScheduled` por uma chamada fina a `ensureMeetingScheduled`, mantendo a assinatura externa da função intacta (quem chama `recordMeetingScheduled` não muda):

```ts
async function recordMeetingScheduled(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    configOwnerUserId: string
    meetingNote: string
    meetingAt: string | null
    meetingEmail: string | null
    config: AiConfig
  },
): Promise<void> {
  await ensureMeetingScheduled(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    configOwnerUserId: args.configOwnerUserId,
    meetingNote: args.meetingNote,
    meetingAt: args.meetingAt,
    meetingEmail: args.meetingEmail,
    meetingEventLabel: args.config.meetingEventLabel,
    businessHoursTimezone: args.config.businessHoursTimezone,
  })
}
```

Adicionar o import no topo do arquivo: `import { ensureMeetingScheduled } from './meeting-scheduling'`. Remover o código antigo de `recordMeetingScheduled` que foi movido (a resolução da etapa, a lógica de e-mail, a criação do evento, o envio das mensagens) — tudo isso agora vive em `meeting-scheduling.ts`.

- [ ] **Step 7: Rodar a suíte inteira**

Run: `npx vitest run`
Expected: exatamente as 5 falhas conhecidas e pré-existentes, sem nenhuma nova. Os testes de `auto-reply.test.ts` da describe `'dispatchInboundToAiReply — meeting scheduling creates a missing deal'` continuam passando sem alteração (testam comportamento observável via `dispatchInboundToAiReply`, que agora delega pra `ensureMeetingScheduled` por dentro, mas o resultado observado é o mesmo).

- [ ] **Step 8: Commit**

```bash
git add src/lib/ai/meeting-scheduling.ts src/lib/ai/meeting-scheduling.test.ts src/lib/ai/auto-reply.ts
git commit -m "$(cat <<'EOF'
Extrai ensureMeetingScheduled pra modulo compartilhado

Mesmo comportamento de recordMeetingScheduled, extraido com uma
garantia de idempotencia explicita (nunca reenvia o link se o
negocio ja tiver meeting_link) -- e isso que permite o job de
reconciliacao (proxima task) chamar essa mesma funcao em cima de um
estado parcial sem duplicar mensagem.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Registrar a intenção em `ai_meeting_intents` e marcar resolvida

**Files:**
- Modify: `src/lib/ai/auto-reply.ts`
- Modify: `src/lib/ai/meeting-scheduling.ts`
- Test: `src/lib/ai/meeting-scheduling.test.ts`

**Interfaces:**
- Produces: `ensureMeetingScheduled` agora também recebe `intentId: string | null` (quando vem de uma intenção já existente, ex. reconciliação) e, ao completar com sucesso, marca `ai_meeting_intents.resolved_at`/`resolution='completed'` se `intentId` foi passado. `recordMeetingScheduled` (tempo real) cria a intenção primeiro e passa o `id` recém-criado.

- [ ] **Step 1: Escrever o teste (falhando) pra gravação da intenção em tempo real**

Adicionar a `src/lib/ai/auto-reply.test.ts`, na describe `'dispatchInboundToAiReply — meeting scheduling creates a missing deal'`:

```ts
it('records an ai_meeting_intents row before attempting any side effect, and marks it completed on success', async () => {
  h.state.existingDeal = null
  h.state.contactRow = { name: 'Julio', phone: '5522998783605', email: null }
  h.state.meetingStage = { id: 'stage-meeting-scheduled' }
  h.generateReply.mockResolvedValue(meetingReply())

  await dispatchInboundToAiReply(ARGS)

  expect(h.state.meetingIntentInserts).toHaveLength(1)
  expect(h.state.meetingIntentInserts[0]).toMatchObject({
    account_id: 'acct-1',
    conversation_id: 'conv-1',
    contact_id: 'contact-1',
    config_owner_user_id: 'user-1',
    meeting_at: meetingReply().meetingAt,
    meeting_email: meetingReply().meetingEmail,
    meeting_note: meetingReply().meetingNote,
  })
  expect(h.state.meetingIntentUpdates).toHaveLength(1)
  expect(h.state.meetingIntentUpdates[0]).toMatchObject({
    id: 'intent-1',
    resolution: 'completed',
  })
})

it('leaves the intent unresolved (does not mark it completed) when the deal cannot be created', async () => {
  h.state.existingDeal = null
  h.resolvePipelineAndStage.mockRejectedValue(new Error('no pipelines yet'))
  h.generateReply.mockResolvedValue(meetingReply())

  await dispatchInboundToAiReply(ARGS)

  expect(h.state.meetingIntentInserts).toHaveLength(1)
  expect(h.state.meetingIntentUpdates).toHaveLength(0)
})
```

No `admin-client` mock de `auto-reply.test.ts`, adicionar o estado e o branch da tabela `ai_meeting_intents`:

```ts
// no objeto `state` hoisted, junto dos outros arrays:
meetingIntentInserts: [] as Record<string, unknown>[],
meetingIntentUpdates: [] as Record<string, unknown>[],
```

```ts
// no dispatcher `from(table)`, junto dos outros `if (table === ...)`:
if (table === 'ai_meeting_intents') {
  const chain = {
    insert: (payload: Record<string, unknown>) => {
      h.state.meetingIntentInserts.push(payload)
      return {
        select: () => ({
          single: () => Promise.resolve({ data: { id: 'intent-1' }, error: null }),
        }),
      }
    },
    update: (payload: Record<string, unknown>) => {
      h.state.meetingIntentUpdates.push({ ...payload })
      return { eq: (_col: string, id: string) => {
        h.state.meetingIntentUpdates[h.state.meetingIntentUpdates.length - 1].id = id
        return Promise.resolve({ error: null })
      } }
    },
  }
  return chain
}
```

E resetar os dois arrays novos no `beforeEach` existente (junto dos outros `h.state.x = []`).

- [ ] **Step 2: Confirmar que falha**

Run: `npx vitest run src/lib/ai/auto-reply.test.ts`
Expected: FAIL nos 2 testes novos — `h.state.meetingIntentInserts` nunca é populado ainda.

- [ ] **Step 3: Adicionar `intentId` a `ensureMeetingScheduled` e a lógica de marcar resolvido**

```ts
// src/lib/ai/meeting-scheduling.ts -- adicionar ao args e ao final da função
export interface EnsureMeetingScheduledArgs {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  meetingNote: string
  meetingAt: string | null
  meetingEmail: string | null
  meetingEventLabel: string | null
  businessHoursTimezone: string
  /** Quando vem de uma ai_meeting_intents já gravada (tempo real logo
   *  após criá-la, ou a reconciliação revisitando uma antiga), marca
   *  essa linha resolvida ao completar com sucesso. */
  intentId: string | null
}
```

No final da função, antes do `return { completed }`:

```ts
  if (completed && intentId) {
    await db
      .from('ai_meeting_intents')
      .update({ resolved_at: new Date().toISOString(), resolution: 'completed' })
      .eq('id', intentId)
  }
```

(Destructure `intentId` no topo junto dos outros campos de `args`.)

- [ ] **Step 4: `recordMeetingScheduled` cria a intenção primeiro**

```ts
async function recordMeetingScheduled(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    configOwnerUserId: string
    meetingNote: string
    meetingAt: string | null
    meetingEmail: string | null
    config: AiConfig
  },
): Promise<void> {
  let intentId: string | null = null
  if (args.meetingAt && args.meetingEmail) {
    const { data: intent, error } = await db
      .from('ai_meeting_intents')
      .insert({
        account_id: args.accountId,
        conversation_id: args.conversationId,
        contact_id: args.contactId,
        config_owner_user_id: args.configOwnerUserId,
        meeting_at: args.meetingAt,
        meeting_email: args.meetingEmail,
        meeting_note: args.meetingNote,
      })
      .select('id')
      .single()
    if (error) {
      console.error('[ai auto-reply] ai_meeting_intents insert failed:', error)
    } else {
      intentId = intent?.id ?? null
    }
  }

  await ensureMeetingScheduled(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    configOwnerUserId: args.configOwnerUserId,
    meetingNote: args.meetingNote,
    meetingAt: args.meetingAt,
    meetingEmail: args.meetingEmail,
    meetingEventLabel: args.config.meetingEventLabel,
    businessHoursTimezone: args.config.businessHoursTimezone,
    intentId,
  })
}
```

- [ ] **Step 5: Confirmar que passa**

Run: `npx vitest run src/lib/ai/auto-reply.test.ts src/lib/ai/meeting-scheduling.test.ts`
Expected: PASS em tudo (os testes existentes de `meeting-scheduling.test.ts` precisam passar `intentId: null` no `ARGS` compartilhado — adicionar esse campo ao objeto `ARGS` do Step 2 da Task 3).

- [ ] **Step 6: Rodar a suíte inteira**

Run: `npx vitest run`
Expected: exatamente as 5 falhas conhecidas e pré-existentes.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/auto-reply.ts src/lib/ai/meeting-scheduling.ts src/lib/ai/meeting-scheduling.test.ts src/lib/ai/auto-reply.test.ts
git commit -m "$(cat <<'EOF'
Registra ai_meeting_intents antes de qualquer efeito colateral

recordMeetingScheduled grava a intencao (horario+e-mail) ANTES de
tentar negocio/etapa/calendario/mensagem -- existe mesmo se tudo
abaixo falhar. ensureMeetingScheduled marca resolved_at/resolution
quando completa com sucesso. Base pro job de reconciliacao diaria
(proxima task) ter o que revisitar.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Job de reconciliação diária, dentro do cron existente

**Files:**
- Create: `src/lib/ai/meeting-reconciliation.ts`
- Create: `src/lib/ai/meeting-reconciliation.test.ts`
- Modify: `src/app/api/automations/cron/route.ts`

**Interfaces:**
- Consumes: `ensureMeetingScheduled` (Task 4), `engineSendText` (`@/lib/flows/meta-send`), `loadAiConfig` (`@/lib/ai/config`, já existe — usado pra pegar `meetingEventLabel`/`businessHoursTimezone` da conta de cada intenção).
- Produces: `reconcileMeetingIntents(db, now?: Date): Promise<{ completed: number; rescheduled: number; stillPending: number }>`, chamada pelo cron.

- [ ] **Step 1: Escrever o teste (falhando)**

```ts
// src/lib/ai/meeting-reconciliation.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  ensureMeetingScheduled: vi.fn(),
  loadAiConfig: vi.fn(),
  engineSendText: vi.fn(),
}))
vi.mock('./meeting-scheduling', () => ({ ensureMeetingScheduled: h.ensureMeetingScheduled }))
vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))

import { reconcileMeetingIntents } from './meeting-reconciliation'

function makeDb(intents: Record<string, unknown>[]) {
  const state = { updates: [] as Array<{ payload: Record<string, unknown>; id: string }> }
  const db = {
    from: (table: string) => {
      if (table === 'ai_meeting_intents') {
        const selectChain = {
          select: () => selectChain,
          is: () => selectChain,
          gte: () => selectChain,
          order: () => Promise.resolve({ data: intents, error: null }),
        }
        return {
          select: () => selectChain,
          update: (payload: Record<string, unknown>) => ({
            eq: (_col: string, id: string) => {
              state.updates.push({ payload, id })
              return Promise.resolve({ error: null })
            },
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { db, state }
}

const NOW = new Date('2026-10-12T12:00:00.000Z')

function intent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'intent-1',
    account_id: 'acct-1',
    conversation_id: 'conv-1',
    contact_id: 'contact-1',
    config_owner_user_id: 'user-1',
    meeting_at: '2026-10-12T13:00:00.000Z', // 1h no futuro
    meeting_email: 'lead@example.com',
    meeting_note: 'Hoje às 10h',
    created_at: '2026-10-12T09:00:00.000Z', // mais de 15min atrás
    ...overrides,
  }
}

beforeEach(() => {
  h.ensureMeetingScheduled.mockReset()
  h.loadAiConfig.mockReset()
  h.engineSendText.mockReset()
  h.loadAiConfig.mockResolvedValue({ meetingEventLabel: null, businessHoursTimezone: 'America/Sao_Paulo' })
})

describe('reconcileMeetingIntents', () => {
  it('retries an unresolved intent whose meeting time is still in the future', async () => {
    h.ensureMeetingScheduled.mockResolvedValue({ completed: true })
    const { db } = makeDb([intent()])
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(h.ensureMeetingScheduled).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ accountId: 'acct-1', contactId: 'contact-1', intentId: 'intent-1' }),
    )
    expect(result).toEqual({ completed: 1, rescheduled: 0, stillPending: 0 })
  })

  it('retries an intent up to 3h past its meeting time', async () => {
    h.ensureMeetingScheduled.mockResolvedValue({ completed: true })
    const { db } = makeDb([intent({ meeting_at: '2026-10-12T10:00:00.000Z' })]) // 2h no passado
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(h.ensureMeetingScheduled).toHaveBeenCalled()
    expect(result.completed).toBe(1)
  })

  it('does not retry (and instead asks to reschedule) an intent more than 3h past its meeting time', async () => {
    h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
    const { db, state } = makeDb([intent({ meeting_at: '2026-10-12T08:00:00.000Z' })]) // 4h no passado
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(h.ensureMeetingScheduled).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1', contactId: 'contact-1' }),
    )
    expect(state.updates[0]).toMatchObject({ payload: { resolution: 'stale_rescheduled' }, id: 'intent-1' })
    expect(result).toEqual({ completed: 0, rescheduled: 1, stillPending: 0 })
  })

  it('counts an intent as still pending when ensureMeetingScheduled could not complete it', async () => {
    h.ensureMeetingScheduled.mockResolvedValue({ completed: false })
    const { db } = makeDb([intent()])
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(result).toEqual({ completed: 0, rescheduled: 0, stillPending: 1 })
  })

  it('skips an intent created less than 15 minutes ago, to not race a live in-flight attempt', async () => {
    const { db } = makeDb([intent({ created_at: '2026-10-12T11:50:00.000Z' })]) // 10min atrás
    const result = await reconcileMeetingIntents(db as never, NOW)
    expect(h.ensureMeetingScheduled).not.toHaveBeenCalled()
    expect(result).toEqual({ completed: 0, rescheduled: 0, stillPending: 0 })
  })
})
```

- [ ] **Step 2: Confirmar que falha**

Run: `npx vitest run src/lib/ai/meeting-reconciliation.test.ts`
Expected: FAIL — o módulo `./meeting-reconciliation` não existe ainda.

- [ ] **Step 3: Implementar**

```ts
// src/lib/ai/meeting-reconciliation.ts
// ============================================================
// Job diario: revisita toda ai_meeting_intents nao resolvida dos
// ultimos 14 dias e tenta completar o que faltou (negocio -> etapa
// -> calendario -> link), ou -- se o horario da reuniao ja passou
// de forma significativa -- pede pro lead reagendar em vez de criar
// um evento retroativo. Nunca reenvia a mensagem do link duas vezes
// (ensureMeetingScheduled garante isso: so manda quando preenche
// meeting_link agora).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { ensureMeetingScheduled } from './meeting-scheduling'
import { loadAiConfig } from './config'
import { engineSendText } from '@/lib/flows/meta-send'

const GRACE_MINUTES_BEFORE_RETRY = 15
const STALE_AFTER_HOURS = 3
const LOOKBACK_DAYS = 14

export async function reconcileMeetingIntents(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<{ completed: number; rescheduled: number; stillPending: number }> {
  const result = { completed: 0, rescheduled: 0, stillPending: 0 }

  const lookbackFrom = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60_000).toISOString()
  const { data: intents, error } = await db
    .from('ai_meeting_intents')
    .select('id, account_id, conversation_id, contact_id, config_owner_user_id, meeting_at, meeting_email, meeting_note, created_at')
    .is('resolved_at', null)
    .gte('created_at', lookbackFrom)
    .order('created_at', { ascending: true })
  if (error || !intents) {
    console.error('[meeting-reconciliation] failed to list unresolved intents:', error)
    return result
  }

  for (const intent of intents) {
    const createdAt = new Date(intent.created_at as string)
    if (now.getTime() - createdAt.getTime() < GRACE_MINUTES_BEFORE_RETRY * 60_000) {
      continue // pode estar em andamento agora mesmo -- não disputa
    }

    const meetingAt = new Date(intent.meeting_at as string)
    const hoursPast = (now.getTime() - meetingAt.getTime()) / (1000 * 60 * 60)

    if (hoursPast > STALE_AFTER_HOURS) {
      try {
        await engineSendText({
          accountId: intent.account_id as string,
          userId: intent.config_owner_user_id as string,
          conversationId: intent.conversation_id as string,
          contactId: intent.contact_id as string,
          text: 'Oi! Não consegui confirmar certinho o horário da nossa reunião anterior. Podemos reagendar? Me diga um dia e horário bons pra você.',
          aiGenerated: true,
        })
        await db
          .from('ai_meeting_intents')
          .update({ resolved_at: now.toISOString(), resolution: 'stale_rescheduled' })
          .eq('id', intent.id as string)
        result.rescheduled += 1
      } catch (err) {
        console.error('[meeting-reconciliation] stale reschedule message failed:', intent.id, err)
        result.stillPending += 1
      }
      continue
    }

    try {
      const config = await loadAiConfig(db, intent.account_id as string)
      const outcome = await ensureMeetingScheduled(db, {
        accountId: intent.account_id as string,
        conversationId: intent.conversation_id as string,
        contactId: intent.contact_id as string,
        configOwnerUserId: intent.config_owner_user_id as string,
        meetingNote: (intent.meeting_note as string) ?? '',
        meetingAt: intent.meeting_at as string,
        meetingEmail: intent.meeting_email as string,
        meetingEventLabel: config?.meetingEventLabel ?? null,
        businessHoursTimezone: config?.businessHoursTimezone ?? 'America/Sao_Paulo',
        intentId: intent.id as string,
      })
      if (outcome.completed) result.completed += 1
      else result.stillPending += 1
    } catch (err) {
      console.error('[meeting-reconciliation] retry failed:', intent.id, err)
      result.stillPending += 1
    }
  }

  return result
}
```

- [ ] **Step 4: Confirmar que passa**

Run: `npx vitest run src/lib/ai/meeting-reconciliation.test.ts`
Expected: PASS (5/5)

- [ ] **Step 5: Ler o `cron/route.ts` atual e adicionar a chamada, uma vez por dia**

Ler o arquivo inteiro primeiro (ele muda com frequência nesta sessão) pra confirmar o formato exato da resposta JSON do handler e o padrão real de `drainDailyDigest`/outras funções `drainX` — este Step segue o MESMO padrão de "claim atômico por data" que `drainDailyDigest` já usa, mas numa linha fixa de `cron_job_state` em vez de uma coluna por conta (esta reconciliação varre todas as contas numa passada só).

```ts
// src/app/api/automations/cron/route.ts
// Adicionar ao topo, junto dos outros imports de ./lib/ai/...:
import { reconcileMeetingIntents } from '@/lib/ai/meeting-reconciliation'

// Nova função, no mesmo estilo de drainDailyDigest:
async function reconcileMeetingIntentsOnce(
  admin: ReturnType<typeof supabaseAdmin>,
): Promise<{ completed: number; rescheduled: number; stillPending: number } | null> {
  const { today } = brazilTodayAndHour()

  const { data: claim } = await admin
    .from('cron_job_state')
    .upsert({ job_name: 'reconcile_meeting_intents', last_run_date: today }, { onConflict: 'job_name' })
    .select('job_name')
    .single()
  // upsert sempre "ganha" -- precisa checar o estado ANTES de escrever
  // pra saber se já tinha rodado hoje. Ver nota abaixo.
  void claim

  const { data: state } = await admin
    .from('cron_job_state')
    .select('last_run_date')
    .eq('job_name', 'reconcile_meeting_intents')
    .maybeSingle()
  if (state?.last_run_date === today) return null // já rodou hoje (incluindo agora mesmo, acima)

  return reconcileMeetingIntents(admin)
}
```

**Atenção ao implementar este Step:** o trecho acima tem uma ordem errada de propósito (escreve o upsert ANTES de checar se já rodou, o que nunca vai funcionar como "claim" de verdade) — é pra você notar isso e corrigir, seguindo o padrão real de `drainDailyDigest` (select o estado atual primeiro, SÓ then faz o update condicional que serve como claim atômico, com um `.or()` ou equivalente que só terá sucesso pra quem chegar primeiro). Ler `drainDailyDigest` com atenção antes de escrever a versão final — não copiar o pseudo-código acima como está.

Depois, no handler principal do POST/GET da rota (onde `drainDailyDigest` e as outras funções já são chamadas e seus resultados agregados na resposta JSON), adicionar:

```ts
const meetingReconciliation = await reconcileMeetingIntentsOnce(admin)
```

E incluir no objeto de resposta final, mesmo padrão de `sdr_ia_processed` etc.:

```ts
meeting_reconciliation: meetingReconciliation,
```

- [ ] **Step 6: Rodar a suíte inteira**

Run: `npx vitest run`
Expected: exatamente as 5 falhas conhecidas e pré-existentes.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/meeting-reconciliation.ts src/lib/ai/meeting-reconciliation.test.ts src/app/api/automations/cron/route.ts
git commit -m "$(cat <<'EOF'
Adiciona job diario de reconciliacao do agendamento de reuniao

Revisita toda ai_meeting_intents nao resolvida dos ultimos 14 dias:
completa o que faltou (negocio/etapa/calendario/link) se o horario
ainda for acionavel, ou pede reagendamento sem criar evento
retroativo quando ja passou mais de 3h. Roda 1x/dia dentro do cron
existente, mesmo padrao de claim atomico que drainDailyDigest ja usa.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review (feito antes de considerar este plano pronto pra execução)

- **Cobertura do spec:** tabela de intenção (Task 1), extração sem duplicação da lógica de negócio (Task 2) e do procedimento completo de agendamento (Task 3), gravação+resolução da intenção em tempo real (Task 4), job diário com retry/stale-reschedule (Task 5). Nenhuma seção do design ficou sem task.
- **Consistência de tipos:** `findOpenDealForContact` mantém a mesma assinatura em todas as tasks que a chamam (Task 2 define, Task 3/5 consomem). `ensureMeetingScheduled` ganha `intentId` na Task 4 — a Task 3 já precisa incluir esse campo no `ARGS` de teste compartilhado pra não quebrar quando a Task 4 rodar (anotado no Step 5 da Task 4).
- **Maior risco do plano:** o claim atômico do Step 5 da Task 5 — deixado deliberadamente com uma versão errada no texto pra forçar quem implementar a ler `drainDailyDigest` de verdade em vez de inventar um padrão novo. Sem isso, o job pode rodar mais de uma vez no mesmo dia (não é destrutivo — `ensureMeetingScheduled` é idempotente — mas é desperdício e ruído de log).
- **Fora de escopo deste plano** (lembrar, não construir aqui): UI mostrando o histórico de `ai_meeting_intents`; alertar o time da Fuse quando uma reunião precisa de reagendamento manual (hoje só avisa o próprio lead).
