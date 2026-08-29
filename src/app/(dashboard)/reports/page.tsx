"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { createClient } from "@/lib/supabase/client"
import { useAuth } from "@/hooks/use-auth"
import {
  loadCampaignReport,
  loadFunnelInsights,
  loadLostReasonReport,
  loadPipelineFunnel,
  loadSalesRepRanking,
  loadStuckDeals,
} from "@/lib/dashboard/queries"
import type {
  CampaignReportRow,
  FunnelInsightsData,
  LostReasonReportRow,
  PipelineFunnelData,
  SalesRepRankingRow,
  StuckDealRow,
} from "@/lib/dashboard/types"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { PipelineFunnel } from "@/components/dashboard/pipeline-funnel"
import { FunnelInsights } from "@/components/dashboard/funnel-insights"
import { LeadsBySourceChart } from "@/components/dashboard/leads-by-source-chart"
import { LostReasonsTable } from "@/components/dashboard/lost-reasons-table"
import { SalesRepRankingTable } from "@/components/dashboard/sales-rep-ranking-table"
import { StuckDealsTable } from "@/components/dashboard/stuck-deals-table"
import { BarChart3 } from "lucide-react"

export default function ReportsPage() {
  const t = useTranslations("Reports.page")
  const { defaultCurrency } = useAuth()
  const [rows, setRows] = useState<CampaignReportRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [funnel, setFunnel] = useState<PipelineFunnelData | null>(null)
  const [funnelLoading, setFunnelLoading] = useState(true)
  const [insights, setInsights] = useState<FunnelInsightsData | null>(null)
  const [insightsLoading, setInsightsLoading] = useState(true)
  const [lostReasons, setLostReasons] = useState<LostReasonReportRow[] | null>(null)
  const [lostReasonsLoading, setLostReasonsLoading] = useState(true)
  const [ranking, setRanking] = useState<SalesRepRankingRow[] | null>(null)
  const [rankingLoading, setRankingLoading] = useState(true)
  const [stuckDeals, setStuckDeals] = useState<StuckDealRow[] | null>(null)
  const [stuckDealsLoading, setStuckDealsLoading] = useState(true)

  useEffect(() => {
    const db = createClient()
    loadCampaignReport(db)
      .then(setRows)
      .catch((err) => console.error("[reports] load failed:", err))
      .finally(() => setLoading(false))

    loadPipelineFunnel(db)
      .then(setFunnel)
      .catch((err) => console.error("[reports] funnel load failed:", err))
      .finally(() => setFunnelLoading(false))

    loadFunnelInsights(db)
      .then(setInsights)
      .catch((err) => console.error("[reports] insights load failed:", err))
      .finally(() => setInsightsLoading(false))

    loadLostReasonReport(db)
      .then(setLostReasons)
      .catch((err) => console.error("[reports] lost reasons load failed:", err))
      .finally(() => setLostReasonsLoading(false))

    loadSalesRepRanking(db)
      .then(setRanking)
      .catch((err) => console.error("[reports] ranking load failed:", err))
      .finally(() => setRankingLoading(false))

    loadStuckDeals(db)
      .then(setStuckDeals)
      .catch((err) => console.error("[reports] stuck deals load failed:", err))
      .finally(() => setStuckDealsLoading(false))
  }, [])

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <PipelineFunnel data={funnel} loading={funnelLoading} />

      <FunnelInsights data={insights} loading={insightsLoading} currency={defaultCurrency} />

      <StuckDealsTable rows={stuckDeals} loading={stuckDealsLoading} currency={defaultCurrency} />

      <LeadsBySourceChart rows={rows} loading={loading} />

      <div className="rounded-lg border border-border bg-card">
        {loading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {t("loading")}
          </div>
        ) : !rows || rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center">
            <BarChart3 className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">{t("empty")}</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {t("emptyHint")}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("source")}</TableHead>
                <TableHead>{t("campaign")}</TableHead>
                <TableHead className="text-right">{t("totalDeals")}</TableHead>
                <TableHead className="text-right">{t("meetingScheduled")}</TableHead>
                <TableHead className="text-right">{t("won")}</TableHead>
                <TableHead className="text-right">{t("conversionRate")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => {
                // "Qualified" = reached a meeting or won -- the two signals
                // already on `deals` that mean a lead was more than a cold
                // contact. Whichever's higher covers a deal that skipped
                // straight to won without a logged meeting.
                const qualified = Math.max(row.meetingScheduledCount, row.wonCount)
                const rate = row.totalDeals > 0 ? (qualified / row.totalDeals) * 100 : 0
                return (
                  <TableRow key={`${row.source}-${row.campaign}-${i}`}>
                    <TableCell className="font-medium text-foreground">
                      {row.source || (
                        <span className="text-muted-foreground">{t("unsetSource")}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.campaign || (
                        <span className="text-muted-foreground">{t("unsetCampaign")}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{row.totalDeals}</TableCell>
                    <TableCell className="text-right">{row.meetingScheduledCount}</TableCell>
                    <TableCell className="text-right">{row.wonCount}</TableCell>
                    <TableCell className="text-right">{rate.toFixed(0)}%</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <SalesRepRankingTable rows={ranking} loading={rankingLoading} currency={defaultCurrency} />

      <LostReasonsTable rows={lostReasons} loading={lostReasonsLoading} currency={defaultCurrency} />
    </div>
  )
}
