"use client"

import { useTranslations } from "next-intl"
import { Activity } from "lucide-react"
import type { ActivityPeriod, TodayActivityRankingRow } from "@/lib/dashboard/types"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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

interface TodayActivityRankingTableProps {
  rows: TodayActivityRankingRow[] | null
  loading: boolean
  period: ActivityPeriod
  onPeriodChange: (period: ActivityPeriod) => void
}

/** Per-rep activity (first contacts, deals closed, follow-ups) for the
 *  selected period — see `loadTodayActivityRanking` for exactly what
 *  each column counts and why "follow-up" requires a stage marked
 *  `price_sent` in Pipeline Settings before it shows anything. */
export function TodayActivityRankingTable({
  rows,
  loading,
  period,
  onPeriodChange,
}: TodayActivityRankingTableProps) {
  const t = useTranslations("Reports.activityRanking")

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Select value={period} onValueChange={(v) => v && onPeriodChange(v as ActivityPeriod)}>
          <SelectTrigger className="w-[160px] border-border bg-muted text-foreground">
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
      </header>

      {loading || !rows ? (
        <div className="p-5">
          <Skeleton className="h-32 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-5">
          <EmptyState icon={Activity} title={t("empty")} hint={t("emptyHint")} />
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("name")}</TableHead>
              <TableHead className="text-right">{t("firstContacts")}</TableHead>
              <TableHead className="text-right">{t("dealsClosed")}</TableHead>
              <TableHead className="text-right">{t("followUps")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.userId}>
                <TableCell className="font-medium text-foreground">{row.name}</TableCell>
                <TableCell className="text-right">{row.firstContacts}</TableCell>
                <TableCell className="text-right">{row.dealsClosed}</TableCell>
                <TableCell className="text-right">{row.followUps}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}
