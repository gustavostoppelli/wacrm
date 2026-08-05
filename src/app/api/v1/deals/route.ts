// ============================================================
// POST /api/v1/deals — create a pipeline deal (scope: deals:write)
//
// The generic write path for pushing a lead into a pipeline from
// outside the dashboard (a form, an ads-lead sync, a scraper). The
// linked contact is found-or-created inline (same dedupe path as
// `POST /api/v1/contacts`) — a caller only needs a phone number, not
// an internal contact id, mirroring how `POST /api/v1/messages`
// already auto-creates contacts under `messages:send`.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  findOrCreateContact,
  resolveAuditUserId,
  getContactById,
  ContactError,
} from '@/lib/api/v1/contacts';
import {
  serializeDeal,
  resolveSource,
  resolvePipelineAndStage,
  DealError,
} from '@/lib/api/v1/deals';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'deals:write');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const contactInput = body.contact as Record<string, unknown> | undefined;
    const phone =
      typeof contactInput?.phone === 'string' ? contactInput.phone.trim() : '';
    if (!phone) {
      return fail('bad_request', "'contact.phone' is required", 400);
    }

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const { id: contactId, created: contactCreated } = await findOrCreateContact(
      ctx.supabase,
      ctx.accountId,
      auditUserId,
      {
        phone,
        name: typeof contactInput?.name === 'string' ? contactInput.name : undefined,
        email:
          typeof contactInput?.email === 'string' ? contactInput.email : undefined,
        company:
          typeof contactInput?.company === 'string'
            ? contactInput.company
            : undefined,
      }
    );

    const { pipelineId, stageId } = await resolvePipelineAndStage(
      ctx.supabase,
      ctx.accountId,
      typeof body.pipeline === 'string' ? body.pipeline : undefined,
      typeof body.stage === 'string' ? body.stage : undefined
    );

    const source = resolveSource(body.source);

    const contact = await getContactById(ctx.supabase, ctx.accountId, contactId);
    const title =
      typeof body.title === 'string' && body.title.trim()
        ? body.title.trim()
        : contact?.name || phone;

    const value =
      typeof body.value === 'number' && Number.isFinite(body.value)
        ? body.value
        : 0;

    const { data: deal, error } = await ctx.supabase
      .from('deals')
      .insert({
        user_id: auditUserId,
        account_id: ctx.accountId,
        pipeline_id: pipelineId,
        stage_id: stageId,
        contact_id: contactId,
        title,
        value,
        currency: typeof body.currency === 'string' ? body.currency : null,
        notes: typeof body.notes === 'string' ? body.notes.trim() || null : null,
        source,
        status: 'open',
      })
      .select('*')
      .single();

    if (error || !deal) {
      console.error('[api/v1/deals] create error:', error);
      return fail('internal', 'Failed to create deal', 500);
    }

    return ok(
      { ...serializeDeal(deal), contact_created: contactCreated },
      201
    );
  } catch (err) {
    if (err instanceof ContactError || err instanceof DealError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
