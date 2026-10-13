// src/lib/sdr-ia/metrics.ts
// ============================================================
// Metricas de acompanhamento do SDR IA: quantos contatos receberam
// o 1o contato por dia, quantos responderam de verdade (nunca
// contando saudacao automatica do WhatsApp Business), e quantos
// negocios chegaram a uma etapa de reuniao agendada -- mesmo
// detector de saudacao e mesmo padrao de calculo (N+1 simples) que
// computeVariantStats (lib/campaigns/stats.ts) ja usa.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { isAutoGreeting } from '@/lib/campaigns/auto-greeting';

export interface SdrIaDayMetric {
  /** YYYY-MM-DD, horario local do processo (mesma convencao de brazilTodayAndHour). */
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

/**
 * `days` janelas de calendario, incluindo hoje (days=14 -> hoje + 13
 * dias anteriores). `now` injetavel pra teste deterministico.
 */
export async function computeSdrIaMetrics(
  db: SupabaseClient,
  accountId: string,
  contactedTagId: string | null,
  days = 14,
  now: Date = new Date()
): Promise<SdrIaMetrics> {
  const emptyDays: SdrIaDayMetric[] = Array.from({ length: days }, (_, i) => {
    const d = new Date(now.getTime() - (days - 1 - i) * 24 * 60 * 60_000);
    return { date: dateKey(d.toISOString()), contacted: 0, responded: 0, meetingsScheduled: 0 };
  });
  const emptyResult: SdrIaMetrics = {
    days: emptyDays,
    totals: { contacted: 0, responded: 0, meetingsScheduled: 0, responseRate: 0 },
  };
  if (!contactedTagId) return emptyResult;

  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString();

  const { data: contactedRows } = await db
    .from('contact_tags')
    .select('contact_id, created_at')
    .eq('tag_id', contactedTagId)
    .gte('created_at', cutoff);
  if (!contactedRows || contactedRows.length === 0) return emptyResult;

  // Escopa por conta: contact_tags nao tem account_id proprio, e um
  // contato de outra conta nunca deveria aparecer aqui (a tag ja e
  // da conta), mas filtrar de novo e barato e mantem a mesma
  // disciplina de account_id usada em todo o resto do projeto.
  const contactIds = contactedRows.map((r) => r.contact_id as string);
  const { data: ownedContacts } = await db
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .in('id', contactIds);
  const ownedSet = new Set((ownedContacts ?? []).map((c) => c.id as string));

  const byDay = new Map<string, SdrIaDayMetric>();
  for (const d of emptyDays) byDay.set(d.date, { ...d });

  let totalContacted = 0;
  let totalResponded = 0;
  let totalMeetings = 0;

  for (const row of contactedRows) {
    const contactId = row.contact_id as string;
    if (!ownedSet.has(contactId)) continue;

    const contactedAt = row.created_at as string;
    const key = dateKey(contactedAt);
    const bucket = byDay.get(key);
    if (!bucket) continue; // fora da janela de dias retornada (nao deveria acontecer, dado o cutoff acima)

    bucket.contacted += 1;
    totalContacted += 1;

    const { data: conv } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .maybeSingle();

    if (conv) {
      const { data: messages } = await db
        .from('messages')
        .select('sender_type, content_text, created_at')
        .eq('conversation_id', conv.id as string);

      const realReply = (messages ?? []).some(
        (m) =>
          m.sender_type === 'customer' &&
          new Date(m.created_at as string) > new Date(contactedAt) &&
          !isAutoGreeting((m.content_text as string) ?? '')
      );
      if (realReply) {
        bucket.responded += 1;
        totalResponded += 1;
      }
    }

    const { data: deal } = await db
      .from('deals')
      .select('id, pipeline_id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (deal) {
      const { data: stage } = await db
        .from('pipeline_stages')
        .select('id')
        .eq('pipeline_id', deal.pipeline_id as string)
        .eq('stage_role', 'meeting_scheduled')
        .maybeSingle();
      if (stage) {
        const { data: history } = await db
          .from('deal_stage_history')
          .select('id')
          .eq('deal_id', deal.id as string)
          .eq('stage_id', stage.id as string)
          .limit(1)
          .maybeSingle();
        if (history) {
          bucket.meetingsScheduled += 1;
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
