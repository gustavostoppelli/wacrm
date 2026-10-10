import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: vi.fn() }));
vi.mock('@/lib/api/v1/campaigns', () => ({
  findOrCreateCampaign: vi.fn(),
}));
import { requireApiKey } from '@/lib/auth/api-context';
import { findOrCreateCampaign } from '@/lib/api/v1/campaigns';
import { POST } from './route';

describe('POST /api/v1/campaigns', () => {
  it('requires name', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      supabase: {}, accountId: 'acct-1',
    });
    const req = new Request('https://x/api/v1/campaigns', { method: 'POST', body: JSON.stringify({}) });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('creates/returns the campaign and sets the right status', async () => {
    (requireApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      supabase: {}, accountId: 'acct-1',
    });
    (findOrCreateCampaign as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'camp-1', created: true,
    });
    const req = new Request('https://x/api/v1/campaigns', {
      method: 'POST', body: JSON.stringify({ name: 'Contato Frio Outbound' }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data).toEqual({ id: 'camp-1', name: 'Contato Frio Outbound', created: true });
  });
});
