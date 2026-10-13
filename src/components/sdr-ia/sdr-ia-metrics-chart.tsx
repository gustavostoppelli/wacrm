"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { BarChart } from "@/components/tremor/bar-chart";
import type { SdrIaMetrics } from "@/lib/sdr-ia/metrics";

const CONTACTED = "Contatados";
const RESPONDED = "Responderam";
const MEETINGS = "Reuniões agendadas";

/**
 * Acompanhamento do SDR IA: contatados / responderam de verdade /
 * negócios que chegaram a "Reunião Agendada", por dia, últimos 14
 * dias. Mostra assim que a conta já tiver algum histórico — mesmo
 * se o SDR IA estiver pausado agora, a performance passada continua
 * visível.
 */
export function SdrIaMetricsChart() {
  const t = useTranslations("SdrIa.metrics");
  const [metrics, setMetrics] = useState<SdrIaMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/sdr-ia/metrics?days=14", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => setMetrics(data.metrics ?? null))
      .catch(() => setMetrics(null))
      .finally(() => setLoading(false));
  }, []);

  const hasAnyData = (metrics?.totals.contacted ?? 0) > 0;

  const chartData =
    metrics?.days.map((d) => ({
      day: d.date.slice(5), // MM-DD, mais compacto no eixo
      [CONTACTED]: d.contacted,
      [RESPONDED]: d.responded,
      [MEETINGS]: d.meetingsScheduled,
    })) ?? [];

  return (
    <div className="mx-auto max-w-2xl px-4 py-4">
      <Card className="p-6">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
        </div>

        {metrics && hasAnyData && (
          <dl className="mb-4 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <dt className="text-xs text-muted-foreground">{t("totalContacted")}</dt>
              <dd className="mt-1 text-lg font-semibold text-foreground tabular-nums">
                {metrics.totals.contacted}
              </dd>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <dt className="text-xs text-muted-foreground">{t("responseRate")}</dt>
              <dd className="mt-1 text-lg font-semibold text-foreground tabular-nums">
                {(metrics.totals.responseRate * 100).toFixed(0)}%
              </dd>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <dt className="text-xs text-muted-foreground">{t("totalMeetings")}</dt>
              <dd className="mt-1 text-lg font-semibold text-foreground tabular-nums">
                {metrics.totals.meetingsScheduled}
              </dd>
            </div>
          </dl>
        )}

        {loading ? (
          <div className="h-[220px] animate-pulse rounded-lg bg-muted/40" />
        ) : !hasAnyData ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <BarChart
            data={chartData}
            index="day"
            categories={[CONTACTED, RESPONDED, MEETINGS]}
            colors={["violet", "emerald", "amber"]}
            showLegend
            yAxisWidth={32}
            className="h-[220px]"
          />
        )}
      </Card>
    </div>
  );
}
