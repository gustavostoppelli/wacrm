// ============================================================
// PATCH /api/v1/deals/{id} — update a deal's title, notes and/or
// stage (scope: deals:write)
//
// Account-scoped: looks the deal up by id + account_id FIRST and
// returns 404 (never 403 — don't reveal it exists elsewhere) before
// attempting any update. `stage` (a name, not an id) is resolved via
// `resolveStageByName` within the deal's OWN pipeline — this endpoint
// never moves a deal to a different pipeline.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  serializeDeal,
  resolveDealUpdates,
  resolveStageByName,
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

    const { data: existing, error: findErr } = await ctx.supabase
      .from('deals')
      .select('id, pipeline_id, account_id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (findErr) {
      console.error('[api/v1/deals] lookup error:', findErr);
      return fail('internal', 'Failed to look up deal', 500);
    }
    if (!existing) return fail('not_found', 'Deal not found', 404);

    const updates: Record<string, unknown> = resolveDealUpdates(body);
    if (typeof body.stage === 'string' && body.stage.trim()) {
      updates.stage_id = await resolveStageByName(
        ctx.supabase,
        existing.pipeline_id as string,
        body.stage.trim()
      );
    }

    if (Object.keys(updates).length === 0) {
      return fail(
        'bad_request',
        "Provide 'title', 'notes' and/or 'stage' to update",
        400
      );
    }

    const { data: deal, error } = await ctx.supabase
      .from('deals')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error || !deal) {
      console.error('[api/v1/deals] update error:', error);
      return fail('internal', 'Failed to update deal', 500);
    }

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
