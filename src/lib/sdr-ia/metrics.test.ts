import { describe, it, expect } from 'vitest';
import { computeSdrIaMetrics } from './metrics';

function makeDb(opts: {
  contactedRows?: Array<{ contact_id: string; created_at: string }>;
  ownedContactIds?: string[];
  conversationsByContact?: Record<string, { id: string } | null>;
  messagesByConversation?: Record<string, Array<{ sender_type: string; content_text: string; created_at: string }>>;
  dealsByContact?: Record<string, { id: string; pipeline_id: string } | null>;
  meetingStage?: { id: string } | null;
  historyByDeal?: Record<string, boolean>;
}) {
  return {
    from: (table: string) => {
      if (table === 'contact_tags') {
        return {
          select: () => ({
            eq: () => ({
              gte: () => Promise.resolve({ data: opts.contactedRows ?? [], error: null }),
            }),
          }),
        };
      }
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              in: () =>
                Promise.resolve({
                  data: (opts.ownedContactIds ?? []).map((id) => ({ id })),
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              eq: (_col: string, contactId: string) => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: opts.conversationsByContact?.[contactId] ?? null,
                    error: null,
                  }),
              }),
            }),
          }),
        };
      }
      if (table === 'messages') {
        return {
          select: () => ({
            eq: (_col: string, convId: string) =>
              Promise.resolve({ data: opts.messagesByConversation?.[convId] ?? [], error: null }),
          }),
        };
      }
      if (table === 'deals') {
        return {
          select: () => ({
            eq: () => ({
              eq: (_col: string, contactId: string) => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: () =>
                      Promise.resolve({ data: opts.dealsByContact?.[contactId] ?? null, error: null }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'pipeline_stages') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: opts.meetingStage ?? null, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'deal_stage_history') {
        return {
          select: () => ({
            eq: (_col: string, dealId: string) => ({
              eq: () => ({
                limit: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: opts.historyByDeal?.[dealId] ? { id: 'hist-1' } : null,
                      error: null,
                    }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

const NOW = new Date('2026-10-13T12:00:00.000Z');

describe('computeSdrIaMetrics', () => {
  it('returns an all-zero series across the window when there is no contactedTagId', async () => {
    const db = makeDb({});
    const result = await computeSdrIaMetrics(db, 'acct-1', null, 3, NOW);
    expect(result.days).toHaveLength(3);
    expect(result.days.every((d) => d.contacted === 0)).toBe(true);
    expect(result.totals).toEqual({ contacted: 0, responded: 0, meetingsScheduled: 0, responseRate: 0 });
  });

  it('counts a contacted contact on the right day, with no reply and no meeting', async () => {
    const db = makeDb({
      contactedRows: [{ contact_id: 'c1', created_at: '2026-10-13T09:00:00.000Z' }],
      ownedContactIds: ['c1'],
      conversationsByContact: { c1: { id: 'conv-1' } },
      messagesByConversation: { 'conv-1': [] },
      dealsByContact: { c1: null },
    });
    const result = await computeSdrIaMetrics(db, 'acct-1', 'tag-contacted', 3, NOW);
    const today = result.days.find((d) => d.date === '2026-10-13');
    expect(today?.contacted).toBe(1);
    expect(today?.responded).toBe(0);
    expect(today?.meetingsScheduled).toBe(0);
    expect(result.totals.contacted).toBe(1);
    expect(result.totals.responseRate).toBe(0);
  });

  it('counts a real reply but ignores an auto-greeting', async () => {
    const db = makeDb({
      contactedRows: [
        { contact_id: 'c1', created_at: '2026-10-13T09:00:00.000Z' },
        { contact_id: 'c2', created_at: '2026-10-13T09:00:00.000Z' },
      ],
      ownedContactIds: ['c1', 'c2'],
      conversationsByContact: { c1: { id: 'conv-1' }, c2: { id: 'conv-2' } },
      messagesByConversation: {
        'conv-1': [{ sender_type: 'customer', content_text: 'Oi, pode ser', created_at: '2026-10-13T10:00:00.000Z' }],
        'conv-2': [
          { sender_type: 'customer', content_text: 'Seja bem-vindo ao consultório', created_at: '2026-10-13T10:00:00.000Z' },
        ],
      },
      dealsByContact: { c1: null, c2: null },
    });
    const result = await computeSdrIaMetrics(db, 'acct-1', 'tag-contacted', 3, NOW);
    expect(result.totals.contacted).toBe(2);
    expect(result.totals.responded).toBe(1);
    expect(result.totals.responseRate).toBeCloseTo(0.5);
  });

  it('counts a meeting scheduled when the deal reached a meeting_scheduled stage', async () => {
    const db = makeDb({
      contactedRows: [{ contact_id: 'c1', created_at: '2026-10-13T09:00:00.000Z' }],
      ownedContactIds: ['c1'],
      conversationsByContact: { c1: null },
      dealsByContact: { c1: { id: 'deal-1', pipeline_id: 'pipe-1' } },
      meetingStage: { id: 'stage-meeting' },
      historyByDeal: { 'deal-1': true },
    });
    const result = await computeSdrIaMetrics(db, 'acct-1', 'tag-contacted', 3, NOW);
    expect(result.totals.meetingsScheduled).toBe(1);
  });

  it('ignores a contact that does not belong to this account', async () => {
    const db = makeDb({
      contactedRows: [{ contact_id: 'other-acct-contact', created_at: '2026-10-13T09:00:00.000Z' }],
      ownedContactIds: [], // the account-scoping query found none of these ids
    });
    const result = await computeSdrIaMetrics(db, 'acct-1', 'tag-contacted', 3, NOW);
    expect(result.totals.contacted).toBe(0);
  });
});
