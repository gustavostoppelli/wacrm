import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  findOrCreateVariant,
  listVariantsWithCounts,
  CampaignError,
} from '@/lib/api/v1/campaigns';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'campaigns:write');
    const { id: campaignId } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return fail('bad_request', "'name' is required", 400);

    const { id, created } = await findOrCreateVariant(ctx.supabase, campaignId, name);
    return ok({ id, name, created }, created ? 201 : 200);
  } catch (err) {
    if (err instanceof CampaignError) return fail('internal', err.message, err.status);
    return toApiErrorResponse(err);
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'campaigns:read');
    const { id: campaignId } = await params;
    const variants = await listVariantsWithCounts(ctx.supabase, campaignId);
    return ok(variants);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
