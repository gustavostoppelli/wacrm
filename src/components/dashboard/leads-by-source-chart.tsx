"use client"

import { BarChart3 } from 'lucide-react'
import type { CampaignReportRow } from '@/lib/dashboard/types'
import { BarChart } from '@/components/tremor/bar-chart'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

import { useTranslations } from 'next-intl'

interface LeadsBySourceChartProps {
  /** Same rows the campaign table below already loads — this chart is
   *  just a coarser view (summed across campaign) of the same data,
   *  so it never fires its own query. */
  rows: CampaignReportRow[] | null
  loading: boolean
}

const DEALS_CATEGORY = 'Negócios'
const QUALIFIED_CATEGORY = 'Qualificados'

/**
 * "Which channel are our leads actually coming from" at a glance —
 * `loadCampaignReport` rows collapsed from (source, campaign) down to
 * just `source`. Drill-down into the specific campaign/ad still lives
 * in the table below this chart.
 */
export function LeadsBySourceChart({ rows, loading }: LeadsBySourceChartProps) {
  const t = useTranslations('Reports.sourceChart')
  const unsetLabel = t('unsetSource')

  const bySource = new Map<string, { totalDeals: number; qualified: number }>()
  for (const row of rows ?? []) {
    const key = row.source || unsetLabel
    const bucket = bySource.get(key) ?? { totalDeals: 0, qualified: 0 }
    bucket.totalDeals += row.totalDeals
    bucket.qualified += Math.max(row.meetingScheduledCount, row.wonCount)
    bySource.set(key, bucket)
  }

  const chartData = Array.from(bySource.entries())
    .map(([source, v]) => ({
      source,
      [DEALS_CATEGORY]: v.totalDeals,
      [QUALIFIED_CATEGORY]: v.qualified,
    }))
    .sort((a, b) => (b[DEALS_CATEGORY] as number) - (a[DEALS_CATEGORY] as number))

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
      </header>

      <div className="p-5">
        {loading || !rows ? (
          <Skeleton className="h-[260px] w-full" />
        ) : chartData.length === 0 ? (
          <EmptyState icon={BarChart3} title={t('empty')} hint={t('emptyHint')} />
        ) : (
          <BarChart
            data={chartData}
            index="source"
            categories={[DEALS_CATEGORY, QUALIFIED_CATEGORY]}
            colors={['violet', 'emerald']}
            valueFormatter={(value) => `${value}`}
            yAxisWidth={40}
            className="h-[260px]"
          />
        )}
      </div>
    </section>
  )
}
