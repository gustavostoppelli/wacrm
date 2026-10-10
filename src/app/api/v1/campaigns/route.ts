import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { findOrCreateCampaign, CampaignError } from '@/lib/api/v1/campaigns';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'campaigns:write');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return fail('bad_request', "'name' is required", 400);

    const { id, created } = await findOrCreateCampaign(ctx.supabase, ctx.accountId, name);
    return ok({ id, name, created }, created ? 201 : 200);
  } catch (err) {
    if (err instanceof CampaignError) return fail('internal', err.message, err.status);
    return toApiErrorResponse(err);
  }
}
