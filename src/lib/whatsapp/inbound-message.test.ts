import { describe, expect, it, vi, beforeEach } from 'vitest';

// Every downstream dispatcher is mocked out — this test is about the
// shared contact/conversation/message pipeline (the part that changed
// when UAZAPI support was added), not about Flows/automations/AI
// themselves, which have their own test suites.
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn().mockResolvedValue({ consumed: false }),
}));
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/conversations/reopen', () => ({
  reopenClosedConversation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn().mockResolvedValue(null),
  isUniqueViolation: vi.fn().mockReturnValue(false),
}));

// ------------------------------------------------------------
// Minimal chainable Supabase stub, table-keyed. Good enough for the
// straight-line "contact doesn't exist, conversation doesn't exist,
// insert both, then insert the message" path plus the reaction path.
// ------------------------------------------------------------
const inserted: Record<string, unknown[]> = {
  contacts: [],
  conversations: [],
  messages: [],
  message_reactions: [],
  deals: [],
};

// Overridable per-table `maybeSingle`/`limit` results for the deal-
// auto-creation path (ensureDealForContact -> resolvePipelineAndStage
// -> accounts.default_currency). Defaults to "nothing exists" so most
// tests exercise the DealError("no pipelines yet") no-op branch;
// individual tests override these to exercise the happy path.
let pipelinesResult: { data: unknown[] | null; error: null } = { data: null, error: null };
let stagesResult: { data: unknown[] | null; error: null } = { data: null, error: null };
let accountResult: { data: unknown | null; error: null } = { data: null, error: null };
let existingOpenDeal: { data: unknown | null; error: null } = { data: null, error: null };

function makeDb() {
  const builder = (table: string) => {
    const api = {
      select: () => api,
      insert: (row: Record<string, unknown>) => {
        inserted[table]?.push(row);
        return api;
      },
      update: () => api,
      upsert: (row: Record<string, unknown>) => {
        inserted[table]?.push(row);
        return api;
      },
      delete: () => api,
      eq: () => api,
      order: () => api,
      ilike: () => api,
      // Chainable (real Supabase builders stay chainable through
      // `.limit()`, e.g. `.limit(1).maybeSingle()` in
      // ensureDealForContact) but also directly awaitable via `.then`
      // below, for call sites that terminate right at `.limit()`.
      limit: () => {
        if (table === 'pipelines') return { ...api, then: (r: (v: unknown) => void) => r(pipelinesResult) };
        if (table === 'pipeline_stages') return { ...api, then: (r: (v: unknown) => void) => r(stagesResult) };
        return api;
      },
      maybeSingle: () => {
        if (table === 'deals') return Promise.resolve(existingOpenDeal);
        if (table === 'accounts') return Promise.resolve(accountResult);
        return Promise.resolve({ data: null, error: null });
      },
      single: () =>
        Promise.resolve({
          data: { id: `${table}-1`, unread_count: 0 },
          error: null,
        }),
      then: (resolve: (v: { data: null; error: null; count: number }) => void) =>
        resolve({ data: null, error: null, count: 0 }),
    };
    return api;
  };
  return { from: (t: string) => builder(t) };
}

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => makeDb(),
}));

import { processInboundMessage } from './inbound-message';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';

describe('processInboundMessage', () => {
  beforeEach(() => {
    inserted.contacts = [];
    inserted.conversations = [];
    inserted.messages = [];
    inserted.message_reactions = [];
    inserted.deals = [];
    pipelinesResult = { data: null, error: null };
    stagesResult = { data: null, error: null };
    accountResult = { data: null, error: null };
    existingOpenDeal = { data: null, error: null };
    vi.clearAllMocks();
  });

  const base = {
    accountId: 'acct-1',
    configOwnerUserId: 'user-1',
    channelId: 'chan-1',
    senderPhone: '14155550123',
    senderName: 'Jane',
    externalMessageId: 'wamid.1',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    replyToExternalMessageId: null,
    reaction: null as { emoji: string; targetExternalMessageId: string } | null,
  };

  it('creates the conversation stamped with the channel id and inserts the message', async () => {
    const result = await processInboundMessage({
      ...base,
      contentType: 'text',
      contentText: 'hello',
      mediaUrl: null,
      interactiveReplyId: null,
    });

    expect(result).toEqual({ conversationId: 'conversations-1', contactId: 'contacts-1' });
    expect(inserted.conversations[0]).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'contacts-1',
      whatsapp_config_id: 'chan-1',
    });
    expect(inserted.messages[0]).toMatchObject({
      conversation_id: 'conversations-1',
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'hello',
      message_id: 'wamid.1',
    });
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'message.received',
      expect.objectContaining({ whatsapp_message_id: 'wamid.1' })
    );
  });

  it('falls back an unmapped content type to text before insert (CHECK constraint safety net)', async () => {
    await processInboundMessage({
      ...base,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contentType: 'sticker' as any,
      contentText: null,
      mediaUrl: 'https://x/y.webp',
      interactiveReplyId: null,
    });
    expect((inserted.messages[0] as { content_type: string }).content_type).toBe('text');
  });

  it('short-circuits reactions — no row inserted into messages', async () => {
    await processInboundMessage({
      ...base,
      contentType: 'text',
      contentText: null,
      mediaUrl: null,
      interactiveReplyId: null,
      reaction: { emoji: '👍', targetExternalMessageId: 'wamid.original' },
    });
    expect(inserted.messages).toHaveLength(0);
  });

  it('auto-creates an open deal in the default pipeline for a contact with none yet', async () => {
    pipelinesResult = { data: [{ id: 'pipe-1', name: 'Sales' }], error: null };
    stagesResult = { data: [{ id: 'stage-1', name: 'Novo Lead' }], error: null };
    accountResult = { data: { default_currency: 'BRL' }, error: null };

    await processInboundMessage({
      ...base,
      contentType: 'text',
      contentText: 'hello',
      mediaUrl: null,
      interactiveReplyId: null,
    });

    expect(inserted.deals).toHaveLength(1);
    expect(inserted.deals[0]).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'contacts-1',
      conversation_id: 'conversations-1',
      pipeline_id: 'pipe-1',
      stage_id: 'stage-1',
      source: 'WhatsApp Direto',
      currency: 'BRL',
      status: 'open',
    });
  });

  it('does not create a second deal when the contact already has an open one', async () => {
    existingOpenDeal = { data: { id: 'deal-existing' }, error: null };

    await processInboundMessage({
      ...base,
      contentType: 'text',
      contentText: 'hello',
      mediaUrl: null,
      interactiveReplyId: null,
    });

    expect(inserted.deals).toHaveLength(0);
  });
});
