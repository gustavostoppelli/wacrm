import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: vi.fn() }));

import { requireApiKey } from '@/lib/auth/api-context';
import { PATCH } from './route';

function makeSupabaseStub(opts: {
  existingDeal: Record<string, unknown> | null;
  stageId?: string;
  updatedDeal?: Record<string, unknown>;
}) {
  return {
    from: (table: string) => {
      if (table === 'deals') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: opts.existingDeal, error: null }),
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: opts.updatedDeal ?? null, error: null }),
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
              ilike: () => ({
                limit: () =>
                  Promise.resolve({
                    data: opts.stageId ? [{ id: opts.stageId }] : [],
                    error: null,
                  }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe('PATCH /api/v1/deals/{id}', () => {
  it('returns 404 when the deal does not belong to the account', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      supabase: makeSupabaseStub({ existingDeal: null }),
      accountId: 'acct-1',
    });
    const req = new Request('https://x/api/v1/deals/d1', {
      method: 'PATCH',
      body: JSON.stringify({ stage: 'Segundo Contato' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'd1' }) });
    expect(res.status).toBe(404);
  });

  it('rejects an unknown stage name with bad_request', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      supabase: makeSupabaseStub({
        existingDeal: { id: 'd1', pipeline_id: 'p1', account_id: 'acct-1' },
        stageId: undefined,
      }),
      accountId: 'acct-1',
    });
    const req = new Request('https://x/api/v1/deals/d1', {
      method: 'PATCH',
      body: JSON.stringify({ stage: 'Etapa Que Nao Existe' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'd1' }) });
    expect(res.status).toBe(400);
  });

  it('updates the stage and returns the serialized deal', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      supabase: makeSupabaseStub({
        existingDeal: { id: 'd1', pipeline_id: 'p1', account_id: 'acct-1' },
        stageId: 'stage-2',
        updatedDeal: {
          id: 'd1', title: 'x', value: 0, currency: null, source: null, campaign: null,
          city: null, lead_score: null, notes: null, status: 'open', pipeline_id: 'p1',
          stage_id: 'stage-2', contact_id: 'c1', meeting_scheduled_at: null,
          meeting_note: null, meeting_link: null, created_at: '2026-01-01T00:00:00Z',
        },
      }),
      accountId: 'acct-1',
    });
    const req = new Request('https://x/api/v1/deals/d1', {
      method: 'PATCH',
      body: JSON.stringify({ stage: 'Segundo Contato' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'd1' }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.stage_id).toBe('stage-2');
  });

  it('returns 404 when the update affects zero rows (e.g. a concurrent delete)', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      supabase: makeSupabaseStub({
        existingDeal: { id: 'd1', pipeline_id: 'p1', account_id: 'acct-1' },
        stageId: 'stage-2',
        updatedDeal: undefined,
      }),
      accountId: 'acct-1',
    });
    const req = new Request('https://x/api/v1/deals/d1', {
      method: 'PATCH',
      body: JSON.stringify({ stage: 'Segundo Contato' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'd1' }) });
    expect(res.status).toBe(404);
  });
});
