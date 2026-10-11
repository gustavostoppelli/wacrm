import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { computeVariantStats } from '@/lib/campaigns/stats';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }
  const { supabase, accountId } = ctx;
  const { id } = await params;

  // Confirma que a campanha pertence a conta logada ANTES de tocar em
  // qualquer outra tabela. computeVariantStats so recebe campaignId (sem
  // accountId pra filtrar), e as consultas de campaign_assignments /
  // deal_stage_history abaixo tambem filtram so por campaign_id -- sem
  // esse check aqui, qualquer usuario logado poderia ler as estatisticas
  // de resposta/tempo-por-etapa de uma campanha de outra conta so
  // adivinhando ou enumerando o UUID. Mesma classe de bug corrigida em
  // findOrCreateVariant/listVariantsWithCounts (Task 4).
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  const stats = await computeVariantStats(supabase, accountId, id);

  // Tempo medio por etapa: junta deal_stage_history (por deal_id das
  // atribuicoes desta campanha) com pipeline_stages pra ter o NOME da
  // etapa, nao so o id -- e isso que a UI mostra.
  const { data: assignments } = await supabase
    .from('campaign_assignments')
    .select('deal_id')
    .eq('campaign_id', id)
    .not('deal_id', 'is', null);
  const dealIds = (assignments ?? []).map((a) => a.deal_id as string);

  const { data: history } = dealIds.length
    ? await supabase
        .from('deal_stage_history')
        .select('deal_id, stage_id, entered_at, pipeline_stages(name)')
        .in('deal_id', dealIds)
        .order('entered_at')
    : { data: [] };

  // Tempo em cada etapa = diferenca entre entered_at desta linha e a
  // proxima linha do MESMO deal_id (ou agora, se for a etapa atual).
  interface HistoryRow {
    deal_id: string;
    stage_id: string;
    entered_at: string;
    pipeline_stages: { name: string } | { name: string }[] | null;
  }
  const stageNameOf = (row: HistoryRow): string => {
    const ps = row.pipeline_stages;
    if (!ps) return 'Desconhecida';
    return Array.isArray(ps) ? ps[0]?.name ?? 'Desconhecida' : ps.name ?? 'Desconhecida';
  };

  const byDeal = new Map<string, HistoryRow[]>();
  for (const row of (history ?? []) as HistoryRow[]) {
    const list = byDeal.get(row.deal_id) ?? [];
    list.push(row);
    byDeal.set(row.deal_id, list);
  }
  const daysPerStageName: Record<string, number[]> = {};
  for (const rows of byDeal.values()) {
    for (let i = 0; i < rows.length; i++) {
      const stageName = stageNameOf(rows[i]);
      const start = new Date(rows[i].entered_at).getTime();
      const end = i + 1 < rows.length ? new Date(rows[i + 1].entered_at).getTime() : Date.now();
      const days = (end - start) / (1000 * 60 * 60 * 24);
      (daysPerStageName[stageName] ??= []).push(days);
    }
  }
  const avgDaysPerStage: Record<string, number> = {};
  for (const [stage, values] of Object.entries(daysPerStageName)) {
    avgDaysPerStage[stage] = values.reduce((a, b) => a + b, 0) / values.length;
  }

  return NextResponse.json({ stats: stats.map((s) => ({ ...s, avgDaysPerStage })) });
}
