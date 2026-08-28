"use client";

import type { Deal, PipelineStage } from "@/types";
import { Calendar, CalendarClock, Check, X } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { useTranslations } from "next-intl";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function initials(name?: string, fallback?: string) {
  const source = (name || fallback || "?").trim();
  if (!source) return "?";
  return source.charAt(0).toUpperCase();
}

/**
 * Formats a stored phone (digits only, e.g. "5521970060194") as a
 * Brazilian number with DDD: "(21) 97006-0194". Falls back to the raw
 * digits with a leading "+" for anything that isn't a recognizable
 * BR mobile/landline length, rather than guessing at other countries'
 * formats.
 */
function formatPhoneDisplay(phone?: string): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }
  const ddd = digits.slice(0, 2);
  const rest = digits.slice(2);
  if (rest.length === 9) {
    return `(${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
  }
  if (rest.length === 8) {
    return `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
  }
  return `+${phone.replace(/\D/g, "")}`;
}

export function DealCard({ deal, stage, onEdit, isOverlay }: DealCardProps) {
  const t = useTranslations("Pipelines.card");
  const contactLabel = deal.contact?.name || deal.contact?.phone || t("noContact");
  const assigneeLabel = deal.assignee?.full_name || null;

  return (
    <button
      type="button"
      onClick={(e) => {
        // `onClick` still fires after a non-drag tap because the PointerSensor
        // requires 5px movement before it counts as a drag.
        if (isOverlay) return;
        e.stopPropagation();
        onEdit(deal);
      }}
      className={`group relative w-full cursor-pointer rounded-xl border border-border/50 bg-muted/70 pl-4 pr-3 py-3 text-left shadow-sm transition-all ${
        isOverlay
          ? "shadow-xl"
          : "hover:-translate-y-0.5 hover:border-border hover:bg-muted hover:shadow-lg"
      }`}
    >
      {/* 4px left accent bar using stage color */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-1 rounded-l-xl"
        style={{ backgroundColor: stage?.color ?? "#94a3b8" }}
      />

      <div className="flex items-start justify-between gap-2">
        <h4 className="flex-1 text-sm font-semibold leading-snug text-foreground break-words">
          {deal.title}
        </h4>
        {typeof deal.lead_score === "number" && (
          <span
            title={t("leadScore", { score: deal.lead_score })}
            className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${
              deal.lead_score >= 70
                ? "bg-primary/15 text-primary"
                : deal.lead_score >= 40
                  ? "bg-amber-500/15 text-amber-400"
                  : "bg-muted-foreground/15 text-muted-foreground"
            }`}
          >
            {deal.lead_score}
          </span>
        )}
        {deal.status === "won" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
            <Check className="h-3 w-3" />
            {t("won")}
          </span>
        )}
        {deal.status === "lost" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400">
            <X className="h-3 w-3" />
            {t("lost")}
          </span>
        )}
      </div>

      {/* Contact row */}
      <div className="mt-2 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
          {initials(deal.contact?.name, deal.contact?.phone)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">{contactLabel}</p>
          {deal.contact?.name && deal.contact?.phone && (
            <p className="truncate text-[10px] text-muted-foreground/70">
              {formatPhoneDisplay(deal.contact.phone)}
            </p>
          )}
        </div>
      </div>

      {deal.source && (
        <div className="mt-2">
          <span className="inline-flex max-w-full items-center truncate rounded-full bg-muted-foreground/10 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {deal.source}
          </span>
        </div>
      )}

      {(deal.meeting_note || deal.meeting_scheduled_at) && (
        <div className="mt-2 flex items-center gap-1.5 rounded-md bg-pink-500/15 px-2 py-1 text-[11px] font-semibold text-pink-400">
          <CalendarClock className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {deal.meeting_scheduled_at
              ? new Date(deal.meeting_scheduled_at).toLocaleString("pt-BR", {
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : deal.meeting_note}
          </span>
        </div>
      )}

      <div className="mt-2 flex items-center justify-between">
        <span className="text-sm font-bold text-primary">
          {formatCurrency(deal.value, deal.currency)}
        </span>
        {deal.expected_close_date &&
          (() => {
            const today = new Date().toISOString().slice(0, 10);
            const isOpen = !deal.status || deal.status === "open";
            const isOverdue = isOpen && deal.expected_close_date < today;
            const isDueToday = isOpen && deal.expected_close_date === today;
            return (
              <span
                className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] ${
                  isOverdue
                    ? "bg-red-500/15 font-semibold text-red-400"
                    : isDueToday
                      ? "bg-amber-500/15 font-semibold text-amber-400"
                      : "text-muted-foreground"
                }`}
              >
                <Calendar className="h-3 w-3" />
                {formatDate(deal.expected_close_date)}
                {isOverdue && ` · ${t("closeOverdue")}`}
                {isDueToday && ` · ${t("closeDueToday")}`}
              </span>
            );
          })()}
      </div>

      {assigneeLabel && (
        <div className="mt-2 flex items-center justify-end">
          <span
            title={assigneeLabel}
            className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
          >
            {initials(assigneeLabel)}
          </span>
        </div>
      )}
    </button>
  );
}
