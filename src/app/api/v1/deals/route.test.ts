import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(),
}));

import { requireApiKey } from '@/lib/auth/api-context';
import { forbidden } from '@/lib/api/v1/respond';
import { GET } from './route';

// Records every .eq(column, value) call so tests can assert the scoping filters.
function makeSupabaseStub(
  deals: Array<Record<string, unknown>>,
  eqCalls: Array<[string, unknown]>
) {
  return {
    from: () => ({
      select: () => ({
        eq: (col: string, val: unknown) => {
          eqCalls.push([col, val]);
          return {
            eq: (col2: string, val2: unknown) => {
              eqCalls.push([col2, val2]);
              return Promise.resolve({ data: deals, error: null });
            },
          };
        },
      }),
    }),
  };
}

describe('GET /api/v1/deals', () => {
  it('requires the deals:read scope', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      forbidden('Missing scope: deals:read')
    );
    const req = new Request('https://x/api/v1/deals?contact_id=c1');
    const res = await GET(req);
    expect(res.status).toBe(403);
    expect(requireApiKey).toHaveBeenCalledWith(expect.any(Request), 'deals:read');
  });

  it('lists deals for the given contact, scoped to the account', async () => {
    const eqCalls: Array<[string, unknown]> = [];
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      supabase: makeSupabaseStub(
        [
          {
            id: 'd1',
            title: 'Dr. Teste',
            value: 0,
            currency: null,
            source: null,
            campaign: null,
            city: null,
            lead_score: null,
            notes: null,
            status: 'open',
            pipeline_id: 'p1',
            stage_id: 's1',
            contact_id: 'c1',
            meeting_scheduled_at: null,
            meeting_note: null,
            meeting_link: null,
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
        eqCalls
      ),
      accountId: 'acct-1',
    });
    const req = new Request('https://x/api/v1/deals?contact_id=c1');
    const res = await GET(req);
    expect(requireApiKey).toHaveBeenLastCalledWith(expect.any(Request), 'deals:read');
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('d1');
    expect(eqCalls).toContainEqual(['account_id', 'acct-1']);
    expect(eqCalls).toContainEqual(['contact_id', 'c1']);
  });

  it('rejects a request missing contact_id', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      supabase: makeSupabaseStub([], []),
      accountId: 'acct-1',
    });
    const req = new Request('https://x/api/v1/deals');
    const res = await GET(req);
    expect(res.status).toBe(400);
  });
});
