"use client"

import { Filter } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { PipelineFunnelData } from '@/lib/dashboard/types'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface PipelineFunnelProps {
  data: PipelineFunnelData | null
  loading: boolean
}

/**
 * Total -> reached a meeting -> won, as three stacked bars sized by
 * share of the total. Reads live from `deals`/`pipeline_stages` on every
 * load (see loadPipelineFunnel), so a card dragged on the Kanban shows
 * up here on the next visit — no separate sync step to keep in mind.
 */
export function PipelineFunnel({ data, loading }: PipelineFunnelProps) {
  const t = useTranslations('Reports.funnel')

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
      </header>

      <div className="p-5">
        {loading || !data ? (
          <Skeleton className="h-32 w-full" />
        ) : data.totalDeals === 0 ? (
          <EmptyState icon={Filter} title={t('empty')} hint={t('emptyHint')} />
        ) : (
          <>
            <div className="space-y-3">
              <FunnelBar
                label={t('total')}
                count={data.totalDeals}
                of={data.totalDeals}
                color="var(--primary)"
              />
              <FunnelBar
                label={t('reachedMeeting')}
                count={data.reachedMeetingCount}
                of={data.totalDeals}
                color="#f59e0b"
              />
              <FunnelBar
                label={t('won')}
                count={data.wonCount}
                of={data.totalDeals}
                color="#4ade80"
              />
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4 sm:grid-cols-4">
              <Stat
                label={t('meetingToWonRate')}
                value={pct(data.wonFromMeetingCount, data.reachedMeetingCount)}
              />
              <Stat
                label={t('overallWinRate')}
                value={pct(data.wonCount, data.totalDeals)}
              />
              <Stat label={t('openCount')} value={String(data.openCount)} />
              <Stat label={t('lostCount')} value={String(data.lostCount)} />
            </dl>
          </>
        )}
      </div>
    </section>
  )
}

function FunnelBar({
  label,
  count,
  of,
  color,
}: {
  label: string
  count: number
  of: number
  color: string
}) {
  const share = of > 0 ? (count / of) * 100 : 0
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums font-medium text-foreground">{count}</span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${Math.max(share, count > 0 ? 2 : 0)}%`, background: color }}
        />
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  )
}

function pct(count: number, of: number): string {
  if (of <= 0) return '—'
  return `${((count / of) * 100).toFixed(0)}%`
}
