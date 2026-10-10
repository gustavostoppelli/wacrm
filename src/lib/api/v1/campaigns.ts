// ============================================================
// Logica compartilhada de campanhas pra API publica. Padrao
// find-or-create igual findOrCreateContact (lib/api/v1/contacts.ts):
// um nome duplicado nunca e erro, so retorna o existente.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';

export class CampaignError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CampaignError';
    this.status = status;
  }
}

export async function findOrCreateCampaign(
  db: SupabaseClient,
  accountId: string,
  name: string
): Promise<{ id: string; created: boolean }> {
  const { data: existing } = await db
    .from('campaigns')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', name)
    .maybeSingle();
  if (existing) return { id: existing.id as string, created: false };

  const { data: created, error } = await db
    .from('campaigns')
    .insert({ account_id: accountId, name })
    .select('id')
    .single();
  if (error || !created) {
    if (isUniqueViolation(error)) {
      const { data: raced } = await db
        .from('campaigns')
        .select('id')
        .eq('account_id', accountId)
        .eq('name', name)
        .maybeSingle();
      if (raced) return { id: raced.id as string, created: false };
    }
    throw new CampaignError('Failed to create campaign', 500);
  }
  return { id: created.id as string, created: true };
}

export async function findOrCreateVariant(
  db: SupabaseClient,
  campaignId: string,
  name: string
): Promise<{ id: string; created: boolean }> {
  const { data: existing } = await db
    .from('campaign_variants')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('name', name)
    .maybeSingle();
  if (existing) return { id: existing.id as string, created: false };

  const { data: created, error } = await db
    .from('campaign_variants')
    .insert({ campaign_id: campaignId, name })
    .select('id')
    .single();
  if (error || !created) {
    throw new CampaignError('Failed to create campaign variant', 500);
  }
  return { id: created.id as string, created: true };
}

export interface VariantWithCount {
  id: string;
  name: string;
  assignedCount: number;
}

/**
 * List a campaign's variants with how many assignments each has.
 * The SDR follow-up sender uses this to balance the next send across
 * A/B/C variants instead of picking randomly — with few leads a pure
 * random pick skews badly (e.g. 7/5/3 instead of 5/5/5), which
 * confounds the comparison.
 */
export async function listVariantsWithCounts(
  db: SupabaseClient,
  campaignId: string
): Promise<VariantWithCount[]> {
  const { data: variants } = await db
    .from('campaign_variants')
    .select('id, name')
    .eq('campaign_id', campaignId);
  const { data: assignments } = await db
    .from('campaign_assignments')
    .select('variant_id')
    .eq('campaign_id', campaignId);

  return (variants ?? []).map((v) => ({
    id: v.id as string,
    name: v.name as string,
    assignedCount: (assignments ?? []).filter((a) => a.variant_id === v.id).length,
  }));
}
