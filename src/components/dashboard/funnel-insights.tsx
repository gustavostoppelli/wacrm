"use client"

import { useTranslations } from 'next-intl'
import { TrendingUp } from 'lucide-react'
import type { FunnelInsightsData } from '@/lib/dashboard/types'
import { formatCurrencyShort } from '@/lib/currency'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface FunnelInsightsProps {
  data: FunnelInsightsData | null
  loading: boolean
  currency: string
}

/**
 * Second row of Reports metrics: time-to-close, ticket size, stalled
 * deals, and average time per stage. Built on `deal_stage_history` +
 * `deals.closed_at` (migration 047) — same "reads live DB state on
 * every load" model as PipelineFunnel, so it reflects Kanban changes
 * on the next visit without any separate sync step.
 */
export function FunnelInsights({ data, loading, currency }: FunnelInsightsProps) {
  const t = useTranslations('Reports.insights')

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
      </header>

      <div className="p-5">
        {loading || !data ? (
          <Skeleton className="h-32 w-full" />
        ) : data.avgTimeInStage.length === 0 && data.avgDaysToClose === null ? (
          <EmptyState icon={TrendingUp} title={t('empty')} hint={t('emptyHint')} />
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat
                label={t('avgDaysToClose')}
                value={data.avgDaysToClose !== null ? t('days', { count: Math.round(data.avgDaysToClose) }) : '—'}
              />
              <Stat
                label={t('avgValueWon')}
                value={data.avgValueWon !== null ? formatCurrencyShort(data.avgValueWon, currency) : '—'}
              />
              <Stat
                label={t('avgValueOpen')}
                value={data.avgValueOpen !== null ? formatCurrencyShort(data.avgValueOpen, currency) : '—'}
              />
              <Stat
                label={t('stuckInMeeting', { days: data.stallThresholdDays })}
                value={String(data.stuckInMeetingCount)}
                warn={data.stuckInMeetingCount > 0}
              />
            </dl>

            {data.avgTimeInStage.length > 0 && (
              <div className="mt-5 border-t border-border pt-4">
                <p className="mb-3 text-xs font-medium text-muted-foreground">
                  {t('avgTimeInStageTitle')}
                </p>
                <div className="space-y-2">
                  {data.avgTimeInStage.map((s) => (
                    <div key={s.stageId} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{s.stageName}</span>
                      <span className="tabular-nums font-medium text-foreground">
                        {t('days', { count: Math.round(s.avgDays) })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={
          warn
            ? 'text-lg font-semibold tabular-nums text-amber-500'
            : 'text-lg font-semibold tabular-nums text-foreground'
        }
      >
        {value}
      </dd>
    </div>
  )
}
