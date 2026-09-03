"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { Deal, PipelineStage } from "@/types";
import {
  Calendar,
  CalendarClock,
  Check,
  Clock,
  Loader2,
  MapPin,
  MessageSquare,
  X,
} from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { daysInStage, isStaleInStage } from "@/lib/deals/stage-age";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
  const stageDays = daysInStage(deal.stage_entered_at);
  const isOpen = !deal.status || deal.status === "open";
  const stageStale = isOpen && isStaleInStage(stageDays, stage?.stale_after_days);

  // Shortcut to message this lead without leaving the pipeline —
  // opens the same plain-text send used on the Contact detail view
  // (/api/whatsapp/send, contact_id + message_type "text"). Resolves
  // to whichever channel is assigned to the sender automatically
  // (see resolveSenderChannel) — no picker here either, same as there.
  const [messageOpen, setMessageOpen] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);

  async function handleSendMessage() {
    if (!deal.contact_id || !messageText.trim()) return;
    setSendingMessage(true);
    try {
      const res = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: deal.contact_id,
          message_type: "text",
          content_text: messageText.trim(),
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t("toastMessageFailed", { reason: payload?.error || `HTTP ${res.status}` }));
        return;
      }
      toast.success(t("toastMessageSent"));
      setMessageText("");
      setMessageOpen(false);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "network error";
      toast.error(t("toastMessageFailed", { reason }));
    } finally {
      setSendingMessage(false);
    }
  }

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
          {deal.city && (
            <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground/70">
              <MapPin className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{deal.city}</span>
            </p>
          )}
        </div>
        {deal.contact_id && (
          // A <button> can't nest inside the card's own root <button> (invalid
          // HTML — browsers close the outer one early, breaking the
          // click-to-edit). A keyboard-operable <span role="button"> sidesteps
          // that while still stopping the click from reaching the card.
          <span
            role="button"
            tabIndex={0}
            title={t("sendMessageBtn")}
            aria-label={t("sendMessageBtn")}
            onClick={(e) => {
              e.stopPropagation();
              setMessageOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                setMessageOpen(true);
              }
            }}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-primary/15 hover:text-primary"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </span>
        )}
      </div>

      {messageOpen && (
        <Dialog open={messageOpen} onOpenChange={setMessageOpen}>
          <DialogContent
            className="bg-popover border-border sm:max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {t("sendMessageBtn")} — {contactLabel}
              </DialogTitle>
            </DialogHeader>
            <Textarea
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              placeholder={t("sendMessagePlaceholder")}
              rows={3}
              className="border-border bg-muted text-sm text-foreground"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setMessageOpen(false)}
                className="border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                {t("cancel")}
              </Button>
              <Button
                type="button"
                onClick={handleSendMessage}
                disabled={sendingMessage || !messageText.trim()}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {sendingMessage ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <MessageSquare className="h-4 w-4" />
                )}
                {t("sendMessageBtn")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {(deal.source || isOpen) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {deal.source && (
            <span className="inline-flex max-w-full items-center truncate rounded-full bg-muted-foreground/10 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {deal.source}
            </span>
          )}
          {isOpen && (
            <span
              title={stageDays === 0 ? t("stageAgeToday") : t("stageAge", { count: stageDays })}
              className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                stageStale
                  ? "bg-red-500/15 font-semibold text-red-400"
                  : "bg-muted-foreground/10 text-muted-foreground"
              }`}
            >
              <Clock className="h-3 w-3" />
              {stageDays}d
            </span>
          )}
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
