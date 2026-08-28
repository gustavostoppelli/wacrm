"use client"

import { useTranslations } from "next-intl"
import { XCircle } from "lucide-react"
import type { LostReasonReportRow } from "@/lib/dashboard/types"
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

interface LostReasonsTableProps {
  rows: LostReasonReportRow[] | null
  loading: boolean
  currency: string
}

/** Lost deals grouped by `lost_reason` (migration 053) — surfaces
 *  which objection actually costs the most deals/value, not just how
 *  many deals were lost overall. */
export function LostReasonsTable({ rows, loading, currency }: LostReasonsTableProps) {
  const t = useTranslations("Reports.lostReasons")

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
          <EmptyState icon={XCircle} title={t("empty")} hint={t("emptyHint")} />
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("reason")}</TableHead>
              <TableHead className="text-right">{t("count")}</TableHead>
              <TableHead className="text-right">{t("totalValue")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.reason ?? "__unset"}>
                <TableCell className="font-medium text-foreground">
                  {row.reason || <span className="text-muted-foreground">{t("unsetReason")}</span>}
                </TableCell>
                <TableCell className="text-right">{row.count}</TableCell>
                <TableCell className="text-right">
                  {formatCurrencyShort(row.totalValue, currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}
