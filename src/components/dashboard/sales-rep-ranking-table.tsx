"use client"

import { useTranslations } from "next-intl"
import { Trophy } from "lucide-react"
import type { SalesRepRankingRow } from "@/lib/dashboard/types"
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

interface SalesRepRankingTableProps {
  rows: SalesRepRankingRow[] | null
  loading: boolean
  currency: string
}

/** Deals grouped by `assigned_to` (migration-free — reuses the
 *  existing column), sorted by won value. `loadSalesRepRanking`
 *  already excludes unassigned deals, so every row here maps to a
 *  real teammate. */
export function SalesRepRankingTable({ rows, loading, currency }: SalesRepRankingTableProps) {
  const t = useTranslations("Reports.ranking")

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
          <EmptyState icon={Trophy} title={t("empty")} hint={t("emptyHint")} />
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("name")}</TableHead>
              <TableHead className="text-right">{t("totalDeals")}</TableHead>
              <TableHead className="text-right">{t("won")}</TableHead>
              <TableHead className="text-right">{t("lost")}</TableHead>
              <TableHead className="text-right">{t("wonValue")}</TableHead>
              <TableHead className="text-right">{t("winRate")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.userId}>
                <TableCell className="font-medium text-foreground">{row.name}</TableCell>
                <TableCell className="text-right">{row.totalDeals}</TableCell>
                <TableCell className="text-right">{row.wonCount}</TableCell>
                <TableCell className="text-right">{row.lostCount}</TableCell>
                <TableCell className="text-right">
                  {formatCurrencyShort(row.wonValue, currency)}
                </TableCell>
                <TableCell className="text-right">
                  {row.winRate !== null ? `${(row.winRate * 100).toFixed(0)}%` : t("unsetRate")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}
