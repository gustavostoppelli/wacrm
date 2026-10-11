import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: vi.fn() }));
vi.mock('@/lib/api/v1/campaigns', () => ({
  findOrCreateVariant: vi.fn(),
  listVariantsWithCounts: vi.fn(),
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
import { findOrCreateVariant, listVariantsWithCounts, CampaignError } from '@/lib/api/v1/campaigns';
import { POST, GET } from './route';

describe('POST /api/v1/campaigns/{id}/variants', () => {
  it('creates/returns the variant', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ supabase: {}, accountId: 'acct-1' });
    (findOrCreateVariant as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'var-1', created: true });
    const req = new Request('https://x/api/v1/campaigns/camp-1/variants', {
      method: 'POST', body: JSON.stringify({ name: 'A' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'camp-1' }) });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data).toEqual({ id: 'var-1', name: 'A', created: true });
    expect(findOrCreateVariant).toHaveBeenCalledWith({}, 'camp-1', 'acct-1', 'A');
  });

  it('returns 404 when the campaign belongs to a different account', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ supabase: {}, accountId: 'acct-other' });
    (findOrCreateVariant as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new CampaignError('Campaign not found', 404)
    );
    const req = new Request('https://x/api/v1/campaigns/camp-1/variants', {
      method: 'POST', body: JSON.stringify({ name: 'A' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'camp-1' }) });
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(findOrCreateVariant).toHaveBeenCalledWith({}, 'camp-1', 'acct-other', 'A');
  });
});

describe('GET /api/v1/campaigns/{id}/variants', () => {
  it('lists each variant with its assigned count', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ supabase: {}, accountId: 'acct-1' });
    (listVariantsWithCounts as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'var-a', name: 'A', assignedCount: 2 },
      { id: 'var-b', name: 'B', assignedCount: 1 },
    ]);
    const req = new Request('https://x/api/v1/campaigns/camp-1/variants', { method: 'GET' });
    const res = await GET(req, { params: Promise.resolve({ id: 'camp-1' }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual([
      { id: 'var-a', name: 'A', assignedCount: 2 },
      { id: 'var-b', name: 'B', assignedCount: 1 },
    ]);
    expect(requireApiKey).toHaveBeenCalledWith(req, 'campaigns:read');
    expect(listVariantsWithCounts).toHaveBeenCalledWith({}, 'camp-1', 'acct-1');
  });

  it('returns 404 when the campaign belongs to a different account', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ supabase: {}, accountId: 'acct-other' });
    (listVariantsWithCounts as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new CampaignError('Campaign not found', 404)
    );
    const req = new Request('https://x/api/v1/campaigns/camp-1/variants', { method: 'GET' });
    const res = await GET(req, { params: Promise.resolve({ id: 'camp-1' }) });
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(listVariantsWithCounts).toHaveBeenCalledWith({}, 'camp-1', 'acct-other');
  });
});
