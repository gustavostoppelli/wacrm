// ============================================================
// PATCH /api/v1/deals/{id} — update a deal's title and/or notes
// (scope: deals:write)
//
// Account-scoped: a deal belonging to another account returns 404
// (never 403 — don't reveal it exists elsewhere). Updates only the
// fields present in the body; see `resolveDealUpdates`.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  serializeDeal,
  resolveDealUpdates,
  DealError,
} from '@/lib/api/v1/deals';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'deals:write');
    const { id } = await params;

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const updates = resolveDealUpdates(body);
    if (Object.keys(updates).length === 0) {
      return fail('bad_request', "Provide 'title' and/or 'notes' to update", 400);
    }

    const { data: deal, error } = await ctx.supabase
      .from('deals')
      .update(updates)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('*')
      .maybeSingle();

    if (error) {
      console.error('[api/v1/deals] update error:', error);
      return fail('internal', 'Failed to update deal', 500);
    }
    if (!deal) return fail('not_found', 'Deal not found', 404);

    return ok(serializeDeal(deal));
  } catch (err) {
    if (err instanceof DealError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
