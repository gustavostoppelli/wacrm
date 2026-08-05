// ============================================================
// Shared deal logic for the public API (v1) `/api/v1/deals` endpoint.
//
// Lets an external automation (a lead form, an ads-lead sync script,
// a scraper) push a lead straight into a pipeline stage without going
// through the dashboard. Kept out of the route file for the same
// reason as `contacts.ts`: one serializer, one resolver, unit-
// testable without a live Supabase client.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isDealSource } from '@/lib/deals/source';

/** Thrown by the helpers below; the route maps `.status`/`.message`. */
export class DealError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DealError';
    this.status = status;
  }
}

export interface ApiDeal {
  id: string;
  title: string;
  value: number;
  currency: string | null;
  source: string | null;
  notes: string | null;
  status: string | null;
  pipeline_id: string;
  stage_id: string;
  contact_id: string | null;
  created_at: string;
}

export function serializeDeal(row: Record<string, unknown>): ApiDeal {
  return {
    id: row.id as string,
    title: row.title as string,
    value: Number(row.value ?? 0),
    currency: (row.currency as string | null) ?? null,
    source: (row.source as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    status: (row.status as string | null) ?? null,
    pipeline_id: row.pipeline_id as string,
    stage_id: row.stage_id as string,
    contact_id: (row.contact_id as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

/** Validate an optional caller-supplied `source` against the shared enum. */
export function resolveSource(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  if (!isDealSource(input)) {
    throw new DealError(
      `'source' must be one of the account's known deal sources`,
      400
    );
  }
  return input;
}

/**
 * Resolve a target pipeline + stage for a new deal.
 *
 * `pipelineName` / `stageName` match case-insensitively against the
 * account's data — the caller (an external script) has no UUIDs to
 * pass, only the names visible in the dashboard. Omitting either
 * falls back to a default: the account's oldest pipeline, and that
 * pipeline's first stage (`position` ascending) — i.e. wherever a
 * deal created by hand in the dashboard would land by default.
 */
export async function resolvePipelineAndStage(
  db: SupabaseClient,
  accountId: string,
  pipelineName?: string | null,
  stageName?: string | null
): Promise<{ pipelineId: string; stageId: string }> {
  let pipelineQuery = db
    .from('pipelines')
    .select('id, name')
    .eq('account_id', accountId);
  pipelineQuery = pipelineName
    ? pipelineQuery.ilike('name', pipelineName)
    : pipelineQuery.order('created_at', { ascending: true });

  const { data: pipelines, error: pipelineErr } = await pipelineQuery.limit(1);
  if (pipelineErr) {
    throw new DealError('Failed to resolve pipeline', 500);
  }
  const pipeline = pipelines?.[0];
  if (!pipeline) {
    throw new DealError(
      pipelineName
        ? `No pipeline named '${pipelineName}' was found`
        : 'This account has no pipelines yet — create one in the dashboard first',
      400
    );
  }

  let stageQuery = db
    .from('pipeline_stages')
    .select('id, name')
    .eq('pipeline_id', pipeline.id);
  stageQuery = stageName
    ? stageQuery.ilike('name', stageName)
    : stageQuery.order('position', { ascending: true });

  const { data: stages, error: stageErr } = await stageQuery.limit(1);
  if (stageErr) {
    throw new DealError('Failed to resolve pipeline stage', 500);
  }
  const stage = stages?.[0];
  if (!stage) {
    throw new DealError(
      stageName
        ? `No stage named '${stageName}' was found in pipeline '${pipeline.name}'`
        : `Pipeline '${pipeline.name}' has no stages yet`,
      400
    );
  }

  return { pipelineId: pipeline.id as string, stageId: stage.id as string };
}
