import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { createAssignment, CampaignError } from '@/lib/api/v1/campaigns';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'campaigns:write');
    const { id: campaignId } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const variantId = typeof body?.variant_id === 'string' ? body.variant_id : '';
    const contactId = typeof body?.contact_id === 'string' ? body.contact_id : '';
    const dealId = typeof body?.deal_id === 'string' ? body.deal_id : undefined;
    if (!variantId || !contactId) {
      return fail('bad_request', "'variant_id' and 'contact_id' are required", 400);
    }

    const { id, created } = await createAssignment(ctx.supabase, {
      accountId: ctx.accountId, campaignId, variantId, contactId, dealId,
    });
    return ok({ id, created }, created ? 201 : 200);
  } catch (err) {
    if (err instanceof CampaignError) {
      return fail(err.status === 404 ? 'not_found' : 'internal', err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
