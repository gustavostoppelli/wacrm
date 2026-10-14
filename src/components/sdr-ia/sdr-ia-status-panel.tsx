"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { SdrIaConfig } from "@/lib/sdr-ia/config";

// sent_today only resets when the next send happens, so a stale count
// from a previous day must read as 0 in the banner.
function todayInSaoPaulo() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

/**
 * Persistent on/off + hours control for an already-activated SDR IA,
 * shown instead of forcing the full 5-step wizard every time someone
 * just wants to pause it or nudge the hours. The wizard remains the
 * only path for changing lead source / channel / messages (via
 * "Editar configuração completa" below) — this panel only PATCHes the
 * two fields a day-to-day operator actually touches often.
 */
export function SdrIaStatusPanel({
  config,
  onConfigUpdated,
  onEditFull,
}: {
  config: SdrIaConfig;
  onConfigUpdated: (config: SdrIaConfig) => void;
  onEditFull: () => void;
}) {
  const t = useTranslations("SdrIa.status");
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [hoursStart, setHoursStart] = useState(config.hoursStart);
  const [hoursEnd, setHoursEnd] = useState(config.hoursEnd);
  const [savingHours, setSavingHours] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoursSaved, setHoursSaved] = useState(false);

  const patch = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/sdr-ia/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(
        typeof data?.error === "string" ? data.error : t("errorGeneric"),
      );
    }
    const data = await res.json();
    return data.config as SdrIaConfig;
  };

  const handleToggle = async (checked: boolean) => {
    setError(null);
    setTogglingEnabled(true);
    try {
      const updated = await patch({ enabled: checked });
      onConfigUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorGeneric"));
    } finally {
      setTogglingEnabled(false);
    }
  };

  const handleSaveHours = async () => {
    setError(null);
    setHoursSaved(false);
    setSavingHours(true);
    try {
      const updated = await patch({ hoursStart, hoursEnd });
      onConfigUpdated(updated);
      setHoursSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorGeneric"));
    } finally {
      setSavingHours(false);
    }
  };

  const hoursChanged = hoursStart !== config.hoursStart || hoursEnd !== config.hoursEnd;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div
        className={
          config.enabled
            ? "mb-4 flex items-center justify-between gap-4 rounded-lg border border-primary/30 bg-primary/10 px-4 py-3"
            : "mb-4 flex items-center justify-between gap-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3"
        }
        role="status"
      >
        <div>
          <p className="text-sm font-semibold text-foreground">
            {config.enabled
              ? t("bannerActive", {
                  sent: config.lastSentDate === todayInSaoPaulo() ? config.sentToday : 0,
                  cap: config.dailyCap,
                })
              : t("bannerPaused")}
          </p>
          {config.enabled && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("bannerWindow", { start: config.hoursStart, end: config.hoursEnd })}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant={config.enabled ? "outline" : "default"}
          disabled={togglingEnabled}
          onClick={() => handleToggle(!config.enabled)}
        >
          {config.enabled ? t("pause") : t("resume")}
        </Button>
      </div>
      <Card className="space-y-6 p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {config.enabled ? t("enabledDescription") : t("disabledDescription")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={
                config.enabled
                  ? "text-sm font-medium text-primary"
                  : "text-sm font-medium text-destructive"
              }
            >
              {config.enabled ? t("enabledLabel") : t("disabledLabel")}
            </span>
            <Switch
              checked={config.enabled}
              disabled={togglingEnabled}
              onCheckedChange={(v) => handleToggle(!!v)}
              aria-label={config.enabled ? t("enabledLabel") : t("disabledLabel")}
            />
          </div>
        </div>

        <div className="space-y-3 border-t border-border pt-4">
          <h2 className="text-sm font-medium text-foreground">{t("hoursTitle")}</h2>
          <p className="text-xs text-muted-foreground">{t("hoursDescription")}</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="status-hours-start">{t("hoursStartLabel")}</Label>
              <Input
                id="status-hours-start"
                type="number"
                min={0}
                max={23}
                value={hoursStart}
                onChange={(e) => {
                  setHoursSaved(false);
                  setHoursStart(Number(e.target.value));
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="status-hours-end">{t("hoursEndLabel")}</Label>
              <Input
                id="status-hours-end"
                type="number"
                min={0}
                max={23}
                value={hoursEnd}
                onChange={(e) => {
                  setHoursSaved(false);
                  setHoursEnd(Number(e.target.value));
                }}
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              disabled={!hoursChanged || savingHours}
              onClick={handleSaveHours}
            >
              {savingHours ? t("savingHours") : t("saveHours")}
            </Button>
            {hoursSaved && !hoursChanged && (
              <span className="text-xs text-muted-foreground">{t("hoursSaved")}</span>
            )}
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <div className="border-t border-border pt-4">
          <Button variant="ghost" size="sm" onClick={onEditFull}>
            {t("editFull")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
