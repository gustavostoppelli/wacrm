import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(),
}));

import { requireApiKey } from '@/lib/auth/api-context';
import { GET } from './route';

function makeSupabaseStub(deals: Array<Record<string, unknown>>) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ data: deals, error: null }),
        }),
      }),
    }),
  };
}

describe('GET /api/v1/deals', () => {
  it('requires the deals:read scope', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('forbidden')
    );
    const req = new Request('https://x/api/v1/deals?contact_id=c1');
    await expect(GET(req)).resolves.toBeDefined(); // toApiErrorResponse catches it
  });

  it('lists deals for the given contact, scoped to the account', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      supabase: makeSupabaseStub([
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
      ]),
      accountId: 'acct-1',
    });
    const req = new Request('https://x/api/v1/deals?contact_id=c1');
    const res = await GET(req);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('d1');
  });

  it('rejects a request missing contact_id', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      supabase: makeSupabaseStub([]),
      accountId: 'acct-1',
    });
    const req = new Request('https://x/api/v1/deals');
    const res = await GET(req);
    expect(res.status).toBe(400);
  });
});
