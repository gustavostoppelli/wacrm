"use client"

import { useTranslations } from "next-intl"
import { Clock } from "lucide-react"
import type { StuckDealRow } from "@/lib/dashboard/types"
import { formatCurrencyShort } from "@/lib/currency"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { EmptyState } from "./empty-state"
import { Skeleton } from "./skeleton"

interface StuckDealsTableProps {
  rows: StuckDealRow[] | null
  loading: boolean
  currency: string
}

/** Every open deal ranked oldest-in-stage first (migration 056's
 *  `stage_entered_at`) — the per-deal counterpart to the averages in
 *  Funnel Insights. Answers "which specific leads has nobody touched
 *  in a while", so a manager can hold reps accountable deal by deal,
 *  not just watch an aggregate trend. Rows past their stage's alert
 *  threshold (set in pipeline settings) are highlighted. */
export function StuckDealsTable({ rows, loading, currency }: StuckDealsTableProps) {
  const t = useTranslations("Reports.stuckDeals")

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
      </header>

      {loading || !rows ? (
        <div className="p-5">
          <Skeleton className="h-32 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-5">
          <EmptyState icon={Clock} title={t("empty")} hint={t("emptyHint")} />
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("deal")}</TableHead>
              <TableHead>{t("stage")}</TableHead>
              <TableHead>{t("assignedTo")}</TableHead>
              <TableHead className="text-right">{t("value")}</TableHead>
              <TableHead className="text-right">{t("daysInStage")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.dealId}>
                <TableCell className="font-medium text-foreground">{row.title}</TableCell>
                <TableCell className="text-muted-foreground">{row.stageName}</TableCell>
                <TableCell className="text-muted-foreground">
                  {row.assignedToName || (
                    <span className="italic">{t("unassigned")}</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {formatCurrencyShort(row.value, currency)}
                </TableCell>
                <TableCell className="text-right">
                  <span
                    className={
                      row.isStale
                        ? "rounded-full bg-red-500/15 px-2 py-0.5 font-semibold text-red-400"
                        : "text-muted-foreground"
                    }
                  >
                    {t("days", { count: row.daysInStage })}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}
