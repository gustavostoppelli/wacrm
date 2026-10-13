// src/lib/sdr-ia/metrics.ts
// ============================================================
// Metricas de acompanhamento do SDR IA: quantos contatos receberam
// o 1o contato por dia, quantos responderam de verdade, e quantos
// negocios chegaram a uma etapa de reuniao agendada.
//
// Le os dados do fluxo que RODA DE VERDADE hoje pra esta conta: o
// script externo opensquad/skills/sdr-frio, cujas tags
// (sdr_frio_tentativa_1, sdr_frio_respondeu) e etapas (Primeiro/
// Segundo/Terceiro Contato, via o deal_stage_history ja existente)
// sao a fonte de verdade -- NAO a feature nativa sdr_ia_config/
// wizard, que ainda nao foi ativada por nenhuma conta (confirmado
// em 2026-10-13: null pra conta do Gustavo, apesar do toggle/wizard
// ja existir). Na visao do usuario e "uma funcao so" (SDR IA); os
// dois sistemas tecnicos que hoje implementam ela sao um detalhe de
// implementacao, nao dois produtos -- ver conversa de 2026-10-13.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

const TAG_TENTATIVA_1 = 'sdr_frio_tentativa_1';
const TAG_RESPONDEU = 'sdr_frio_respondeu';
const MEETING_STAGE_ROLE = 'meeting_scheduled';

export interface SdrIaDayMetric {
  /** YYYY-MM-DD. */
  date: string;
  contacted: number;
  responded: number;
  meetingsScheduled: number;
}

export interface SdrIaMetrics {
  days: SdrIaDayMetric[];
  totals: {
    contacted: number;
    responded: number;
    meetingsScheduled: number;
    responseRate: number;
  };
}

function dateKey(iso: string): string {
  return iso.slice(0, 10);
}

function emptySeries(days: number, now: Date): SdrIaDayMetric[] {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(now.getTime() - (days - 1 - i) * 24 * 60 * 60_000);
    return { date: dateKey(d.toISOString()), contacted: 0, responded: 0, meetingsScheduled: 0 };
  });
}

/**
 * `days` janelas de calendario, incluindo hoje. `now` injetavel pra
 * teste deterministico.
 */
export async function computeSdrIaMetrics(
  db: SupabaseClient,
  accountId: string,
  days = 14,
  now: Date = new Date()
): Promise<SdrIaMetrics> {
  const byDay = new Map<string, SdrIaDayMetric>();
  for (const d of emptySeries(days, now)) byDay.set(d.date, d);
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString();

  const bump = (dateIso: string, field: keyof Omit<SdrIaDayMetric, 'date'>) => {
    const bucket = byDay.get(dateKey(dateIso));
    if (bucket) bucket[field] += 1;
  };

  const { data: tagRows } = await db
    .from('tags')
    .select('id, name')
    .eq('account_id', accountId)
    .in('name', [TAG_TENTATIVA_1, TAG_RESPONDEU]);
  const tentativa1TagId = tagRows?.find((t) => t.name === TAG_TENTATIVA_1)?.id as string | undefined;
  const respondeuTagId = tagRows?.find((t) => t.name === TAG_RESPONDEU)?.id as string | undefined;

  let totalContacted = 0;
  let totalResponded = 0;
  let totalMeetings = 0;

  // Todo contato ja tocado pelo sdr-frio (sem filtro de janela aqui
  // -- usado so pra escopar QUAIS negocios contam pra "reuniao
  // agendada" abaixo, nao pra contar quem foi contatado).
  let sdrFrioContactIds: string[] = [];

  if (tentativa1TagId) {
    const { data: allTentativaRows } = await db
      .from('contact_tags')
      .select('contact_id')
      .eq('tag_id', tentativa1TagId);
    sdrFrioContactIds = (allTentativaRows ?? []).map((r) => r.contact_id as string);

    const { data: contactedInWindow } = await db
      .from('contact_tags')
      .select('contact_id, created_at')
      .eq('tag_id', tentativa1TagId)
      .gte('created_at', cutoff);
    for (const row of contactedInWindow ?? []) {
      bump(row.created_at as string, 'contacted');
      totalContacted += 1;
    }
  }

  if (respondeuTagId && sdrFrioContactIds.length > 0) {
    const { data: respondedInWindow } = await db
      .from('contact_tags')
      .select('contact_id, created_at')
      .eq('tag_id', respondeuTagId)
      .in('contact_id', sdrFrioContactIds)
      .gte('created_at', cutoff);
    for (const row of respondedInWindow ?? []) {
      bump(row.created_at as string, 'responded');
      totalResponded += 1;
    }
  }

  if (sdrFrioContactIds.length > 0) {
    const { data: meetingStages } = await db
      .from('pipeline_stages')
      .select('id, pipeline_id, pipelines!inner(account_id)')
      .eq('stage_role', MEETING_STAGE_ROLE)
      .eq('pipelines.account_id', accountId);
    const meetingStageIds = (meetingStages ?? []).map((s) => s.id as string);

    if (meetingStageIds.length > 0) {
      const { data: deals } = await db
        .from('deals')
        .select('id')
        .eq('account_id', accountId)
        .in('contact_id', sdrFrioContactIds);
      const dealIds = (deals ?? []).map((d) => d.id as string);

      if (dealIds.length > 0) {
        const { data: meetingsInWindow } = await db
          .from('deal_stage_history')
          .select('entered_at')
          .in('deal_id', dealIds)
          .in('stage_id', meetingStageIds)
          .gte('entered_at', cutoff);
        for (const row of meetingsInWindow ?? []) {
          bump(row.entered_at as string, 'meetingsScheduled');
          totalMeetings += 1;
        }
      }
    }
  }

  return {
    days: Array.from(byDay.values()),
    totals: {
      contacted: totalContacted,
      responded: totalResponded,
      meetingsScheduled: totalMeetings,
      responseRate: totalContacted > 0 ? totalResponded / totalContacted : 0,
    },
  };
}
