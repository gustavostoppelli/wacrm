import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  update: vi.fn(),
  eqId: vi.fn(),
  eqAccount: vi.fn(),
  select: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'auth failed' }, { status: 403 })),
}));

import { POST } from './route';

const params = { params: Promise.resolve({ id: 'webhook-1' }) };
const request = () =>
  new Request('http://localhost/api/account/webhooks/webhook-1/rotate-token', { method: 'POST' });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  // supabase.from('inbound_webhooks').update(...).eq('id').eq('account_id').select('id').maybeSingle()
  mocks.eqAccount.mockReturnValue({ select: mocks.select });
  mocks.eqId.mockReturnValue({ eq: mocks.eqAccount });
  mocks.update.mockReturnValue({ eq: mocks.eqId });
  mocks.select.mockReturnValue({ maybeSingle: mocks.maybeSingle });
  mocks.requireRole.mockResolvedValue({
    supabase: { from: () => ({ update: mocks.update }) },
    accountId: 'account-1',
  });
});

describe('POST /api/account/webhooks/[id]/rotate-token', () => {
  it('requires an admin, stores only the new token hash and returns the URL once', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { id: 'webhook-1' }, error: null });

    const res = await POST(request(), params);
    const body = await res.json();

    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(res.status).toBe(200);
    expect(body.id).toBe('webhook-1');
    expect(body.url).toContain('/api/webhooks/inbound/webhook-1?token=');
    expect(body.url.endsWith(body.token)).toBe(true);

    // the DB gets the SHA-256 of the plaintext, never the plaintext itself
    const stored = mocks.update.mock.calls[0][0] as { token_hash: string };
    expect(stored.token_hash).toBe(createHash('sha256').update(body.token).digest('hex'));
    expect(JSON.stringify(mocks.update.mock.calls)).not.toContain(body.token);
    // scoped to this connection AND this account
    expect(mocks.eqId).toHaveBeenCalledWith('id', 'webhook-1');
    expect(mocks.eqAccount).toHaveBeenCalledWith('account_id', 'account-1');
  });

  it('issues a different token on every call', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { id: 'webhook-1' }, error: null });
    const a = await (await POST(request(), params)).json();
    const b = await (await POST(request(), params)).json();
    expect(a.token).not.toBe(b.token);
  });

  it('returns 404 when the connection is not in this account', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await POST(request(), params);
    expect(res.status).toBe(404);
  });

  it('returns 500 when the update fails', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await POST(request(), params);
    expect(res.status).toBe(500);
  });

  it('maps a failed role check to the auth error response', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await POST(request(), params);
    expect(res.status).toBe(403);
  });
});
