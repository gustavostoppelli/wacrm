import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: vi.fn() }));
vi.mock('@/lib/api/v1/campaigns', () => ({
  createAssignment: vi.fn(),
  CampaignError: class CampaignError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'CampaignError';
      this.status = status;
    }
  },
}));
import { requireApiKey } from '@/lib/auth/api-context';
import { createAssignment, CampaignError } from '@/lib/api/v1/campaigns';
import { POST } from './route';

describe('POST /api/v1/campaigns/{id}/assignments', () => {
  it('requires variant_id and contact_id', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ supabase: {}, accountId: 'acct-1' });
    const req = new Request('https://x', { method: 'POST', body: JSON.stringify({}) });
    const res = await POST(req, { params: Promise.resolve({ id: 'camp-1' }) });
    expect(res.status).toBe(400);
  });

  it('creates the assignment', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ supabase: {}, accountId: 'acct-1' });
    (createAssignment as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'assign-1', created: true });
    const req = new Request('https://x', {
      method: 'POST', body: JSON.stringify({ variant_id: 'var-1', contact_id: 'c1' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'camp-1' }) });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data.id).toBe('assign-1');
  });

  it('returns 404 when the campaign belongs to a different account', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ supabase: {}, accountId: 'acct-other' });
    (createAssignment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new CampaignError('Campaign not found', 404)
    );
    const req = new Request('https://x', {
      method: 'POST', body: JSON.stringify({ variant_id: 'var-1', contact_id: 'c1' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'camp-1' }) });
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });
});
