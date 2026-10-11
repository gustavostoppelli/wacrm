// src/lib/campaigns/stats.ts
// ============================================================
// Calcula estatisticas por variante de uma campanha: quantos
// contatos foram atribuidos, quantos responderam de verdade (nunca
// contando saudacao automatica), e tempo medio por etapa do funil
// pros negocios ligados a essas atribuicoes.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { isAutoGreeting } from './auto-greeting';

export interface VariantStat {
  variantId: string;
  variantName: string;
  totalAssigned: number;
  totalResponded: number;
  responseRate: number;
  avgDaysPerStage: Record<string, number>;
}

export async function computeVariantStats(
  db: SupabaseClient,
  accountId: string,
  campaignId: string
): Promise<VariantStat[]> {
  const { data: variants } = await db
    .from('campaign_variants')
    .select('id, name')
    .eq('campaign_id', campaignId);

  const { data: assignments } = await db
    .from('campaign_assignments')
    .select('id, variant_id, contact_id, deal_id, assigned_at')
    .eq('campaign_id', campaignId);

  const results: VariantStat[] = [];
  for (const variant of variants ?? []) {
    const variantAssignments = (assignments ?? []).filter((a) => a.variant_id === variant.id);
    let responded = 0;

    for (const a of variantAssignments) {
      const { data: conv } = await db
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', a.contact_id)
        .maybeSingle();
      if (!conv) continue;

      const { data: messages } = await db
        .from('messages')
        .select('sender_type, content_text, created_at')
        .eq('conversation_id', conv.id);

      const realReply = (messages ?? []).some(
        (m) =>
          m.sender_type === 'customer' &&
          new Date(m.created_at) > new Date(a.assigned_at) &&
          !isAutoGreeting(m.content_text ?? '')
      );
      if (realReply) responded += 1;
    }

    results.push({
      variantId: variant.id,
      variantName: variant.name,
      totalAssigned: variantAssignments.length,
      totalResponded: responded,
      responseRate: variantAssignments.length > 0 ? responded / variantAssignments.length : 0,
      avgDaysPerStage: {}, // preenchido na Task 9, junto com a UI que consome isso
    });
  }
  return results;
}
