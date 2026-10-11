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
  accountId: string,
  name: string
): Promise<{ id: string; created: boolean }> {
  const { data: campaign } = await db
    .from('campaigns')
    .select('id')
    .eq('id', campaignId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!campaign) throw new CampaignError('Campaign not found', 404);

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
  campaignId: string,
  accountId: string
): Promise<VariantWithCount[]> {
  const { data: campaign } = await db
    .from('campaigns')
    .select('id')
    .eq('id', campaignId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!campaign) throw new CampaignError('Campaign not found', 404);

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

/**
 * Create (or return the existing) assignment of a contact to a campaign
 * variant. Idempotent by (campaign_id, contact_id) -- calling it again for
 * the same contact just returns the existing assignment, never duplicates.
 */
export async function createAssignment(
  db: SupabaseClient,
  args: { accountId: string; campaignId: string; variantId: string; contactId: string; dealId?: string }
): Promise<{ id: string; created: boolean }> {
  const { data: campaign } = await db
    .from('campaigns')
    .select('id')
    .eq('id', args.campaignId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (!campaign) throw new CampaignError('Campaign not found', 404);

  const { data: variant } = await db
    .from('campaign_variants')
    .select('id')
    .eq('id', args.variantId)
    .eq('campaign_id', args.campaignId)
    .maybeSingle();
  if (!variant) throw new CampaignError('Variant not found', 404);

  const { data: contact } = await db
    .from('contacts')
    .select('id')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (!contact) throw new CampaignError('Contact not found', 404);

  if (args.dealId) {
    const { data: deal } = await db
      .from('deals')
      .select('id')
      .eq('id', args.dealId)
      .eq('account_id', args.accountId)
      .maybeSingle();
    if (!deal) throw new CampaignError('Deal not found', 404);
  }

  const { data: existing } = await db
    .from('campaign_assignments')
    .select('id')
    .eq('campaign_id', args.campaignId)
    .eq('contact_id', args.contactId)
    .maybeSingle();
  if (existing) return { id: existing.id as string, created: false };

  const { data: created, error } = await db
    .from('campaign_assignments')
    .insert({
      account_id: args.accountId,
      campaign_id: args.campaignId,
      variant_id: args.variantId,
      contact_id: args.contactId,
      deal_id: args.dealId ?? null,
    })
    .select('id')
    .single();
  if (error || !created) {
    throw new CampaignError('Failed to create campaign assignment', 500);
  }
  return { id: created.id as string, created: true };
}
