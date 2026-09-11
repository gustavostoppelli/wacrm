"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { createClient } from "@/lib/supabase/client"
import { loadTodayActivityRanking } from "@/lib/dashboard/queries"
import type { ActivityPeriod, TodayActivityRankingRow } from "@/lib/dashboard/types"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "./skeleton"

type Metric = "firstContacts" | "dealsClosed" | "followUps"

/**
 * Self-contained: each of the three mini-leaderboards below has its
 * OWN period selector (Today/This week/This month) and can sit on a
 * different period than its neighbors at the same time — e.g. "First
 * contact" showing today while "Closed" shows this month. That ruled
 * out the usual "page fetches, passes rows down" pattern every other
 * dashboard widget uses (one shared period couldn't satisfy three
 * independent ones), so this component fetches its own data instead.
 * A tiny per-period cache means switching a column back to an
 * already-viewed period is instant and doesn't re-fetch.
 *
 * Same component is used, unchanged, on both the main Dashboard and
 * the Reports page — deliberately not on the Pipeline page.
 */
export function TodayActivityRankingTable() {
  const t = useTranslations("Reports.activityRanking")
  const dbRef = useRef(createClient())

  const [firstContactsPeriod, setFirstContactsPeriod] = useState<ActivityPeriod>("today")
  const [followUpsPeriod, setFollowUpsPeriod] = useState<ActivityPeriod>("today")
  const [dealsClosedPeriod, setDealsClosedPeriod] = useState<ActivityPeriod>("today")

  const [cache, setCache] = useState<Partial<Record<ActivityPeriod, TodayActivityRankingRow[]>>>({})
  const [loadingPeriods, setLoadingPeriods] = useState<Set<ActivityPeriod>>(new Set())
  const inFlight = useRef<Set<ActivityPeriod>>(new Set())

  const ensurePeriodLoaded = useCallback((period: ActivityPeriod) => {
    if (inFlight.current.has(period)) return
    inFlight.current.add(period)
    setLoadingPeriods((prev) => new Set(prev).add(period))
    loadTodayActivityRanking(dbRef.current, period)
      .then((rows) => setCache((prev) => ({ ...prev, [period]: rows })))
      .catch((err) => console.error("[dashboard] activity ranking failed:", err))
      .finally(() => {
        inFlight.current.delete(period)
        setLoadingPeriods((prev) => {
          const next = new Set(prev)
          next.delete(period)
          return next
        })
      })
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    ensurePeriodLoaded(firstContactsPeriod)
  }, [firstContactsPeriod, ensurePeriodLoaded])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    ensurePeriodLoaded(followUpsPeriod)
  }, [followUpsPeriod, ensurePeriodLoaded])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    ensurePeriodLoaded(dealsClosedPeriod)
  }, [dealsClosedPeriod, ensurePeriodLoaded])

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
      </header>

      <div className="grid grid-cols-1 gap-6 p-5 sm:grid-cols-3 sm:divide-x sm:divide-border">
        <MetricColumn
          title={t("firstContacts")}
          metric="firstContacts"
          period={firstContactsPeriod}
          onPeriodChange={setFirstContactsPeriod}
          rows={cache[firstContactsPeriod]}
          loading={loadingPeriods.has(firstContactsPeriod)}
        />
        <div className="sm:pl-6">
          <MetricColumn
            title={t("followUps")}
            metric="followUps"
            period={followUpsPeriod}
            onPeriodChange={setFollowUpsPeriod}
            rows={cache[followUpsPeriod]}
            loading={loadingPeriods.has(followUpsPeriod)}
          />
        </div>
        <div className="sm:pl-6">
          <MetricColumn
            title={t("dealsClosed")}
            metric="dealsClosed"
            period={dealsClosedPeriod}
            onPeriodChange={setDealsClosedPeriod}
            rows={cache[dealsClosedPeriod]}
            loading={loadingPeriods.has(dealsClosedPeriod)}
          />
        </div>
      </div>
    </section>
  )
}

function MetricColumn({
  title,
  metric,
  period,
  onPeriodChange,
  rows,
  loading,
}: {
  title: string
  metric: Metric
  period: ActivityPeriod
  onPeriodChange: (period: ActivityPeriod) => void
  rows: TodayActivityRankingRow[] | undefined
  loading: boolean
}) {
  const t = useTranslations("Reports.activityRanking")

  const ranked = (rows ?? []).filter((r) => r[metric] > 0).sort((a, b) => b[metric] - a[metric])

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        <Select value={period} onValueChange={(v) => v && onPeriodChange(v as ActivityPeriod)}>
          <SelectTrigger className="h-7 w-auto shrink-0 border-border bg-muted text-xs text-foreground">
            <SelectValue>
              {period === "week" ? t("periodWeek") : period === "month" ? t("periodMonth") : t("periodToday")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="today">{t("periodToday")}</SelectItem>
            <SelectItem value="week">{t("periodWeek")}</SelectItem>
            <SelectItem value="month">{t("periodMonth")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading || !rows ? (
        <Skeleton className="mt-3 h-24 w-full" />
      ) : ranked.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{t("emptyColumn")}</p>
      ) : (
        <ol className="mt-3 space-y-2">
          {ranked.map((row, i) => (
            <li key={row.userId} className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2 truncate text-foreground">
                <span className="w-4 shrink-0 text-right text-xs font-medium text-muted-foreground">
                  {i + 1}
                </span>
                <span className="truncate">{row.name}</span>
              </span>
              <span className="shrink-0 font-semibold text-foreground">{row[metric]}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
