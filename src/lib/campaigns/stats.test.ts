// src/lib/campaigns/stats.test.ts
import { describe, expect, it } from 'vitest';
import { computeVariantStats } from './stats';

function makeDb(opts: {
  assignments: Array<{ id: string; variant_id: string; contact_id: string; deal_id: string | null; assigned_at: string }>;
  variants: Array<{ id: string; name: string }>;
  messagesByContact: Record<string, Array<{ sender_type: string; content_text: string; created_at: string }>>;
  stageHistoryByDeal: Record<string, Array<{ stage_id: string; entered_at: string }>>;
}) {
  return {
    from: (table: string) => {
      if (table === 'campaign_variants') {
        return { select: () => ({ eq: () => Promise.resolve({ data: opts.variants, error: null }) }) };
      }
      if (table === 'campaign_assignments') {
        return { select: () => ({ eq: () => Promise.resolve({ data: opts.assignments, error: null }) }) };
      }
      if (table === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              eq: (_col: string, contactId: string) => ({
                maybeSingle: () => Promise.resolve({ data: { id: `conv-${contactId}` }, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'messages') {
        return {
          select: () => ({
            eq: (_col: string, conversationId: string) => {
              const contactId = conversationId.replace(/^conv-/, '');
              return Promise.resolve({ data: opts.messagesByContact[contactId] ?? [], error: null });
            },
          }),
        };
      }
      if (table === 'deal_stage_history') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: Object.values(opts.stageHistoryByDeal).flat(), error: null }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

describe('computeVariantStats', () => {
  it('computes total assigned and response rate per variant, ignoring auto-greetings', async () => {
    const db = makeDb({
      variants: [{ id: 'var-a', name: 'A' }, { id: 'var-b', name: 'B' }],
      assignments: [
        { id: 'a1', variant_id: 'var-a', contact_id: 'c1', deal_id: null, assigned_at: '2026-10-01T10:00:00Z' },
        { id: 'a2', variant_id: 'var-a', contact_id: 'c2', deal_id: null, assigned_at: '2026-10-01T10:00:00Z' },
        { id: 'a3', variant_id: 'var-b', contact_id: 'c3', deal_id: null, assigned_at: '2026-10-01T10:00:00Z' },
      ],
      messagesByContact: {
        c1: [{ sender_type: 'customer', content_text: 'Oi, pode ser', created_at: '2026-10-01T11:00:00Z' }],
        c2: [{ sender_type: 'customer', content_text: 'Seja bem-vindo ao consultório', created_at: '2026-10-01T11:00:00Z' }],
        c3: [],
      },
      stageHistoryByDeal: {},
    });

    const stats = await computeVariantStats(db, 'acct-1', 'camp-1');
    const a = stats.find((s) => s.variantName === 'A')!;
    const b = stats.find((s) => s.variantName === 'B')!;

    expect(a.totalAssigned).toBe(2);
    expect(a.totalResponded).toBe(1); // c2's reply is an auto-greeting, doesn't count
    expect(a.responseRate).toBeCloseTo(0.5);
    expect(b.totalAssigned).toBe(1);
    expect(b.totalResponded).toBe(0);
  });
});
