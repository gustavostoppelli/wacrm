"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SdrIaWizard } from "./sdr-ia-wizard";
import { SdrIaStatusPanel } from "./sdr-ia-status-panel";
import { SdrIaMetricsChart } from "./sdr-ia-metrics-chart";
import type { SdrIaConfig } from "@/lib/sdr-ia/config";

/**
 * Entry point for an unlocked account. The metrics chart is always
 * shown — it reads the account's real cold-outreach activity
 * directly (see lib/sdr-ia/metrics.ts), independent of whether the
 * in-app wizard/config below it was ever completed. Below that:
 * once the account has activated the in-app sending at least once
 * (a saved sdr_ia_config row exists), day-to-day operation is the
 * status panel (on/off + hours); first-time setup (no row yet)
 * shows a short prompt instead of forcing the 5-step wizard open on
 * every page load — the wizard opens only when asked for.
 */
export function SdrIaHome() {
  const t = useTranslations("SdrIa.wizard");
  const [config, setConfig] = useState<SdrIaConfig | null | "loading">("loading");
  const [mode, setMode] = useState<"status" | "wizard">("status");

  const loadConfig = useCallback(() => {
    fetch("/api/sdr-ia/config", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => setConfig((data.config as SdrIaConfig | undefined) ?? null))
      .catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  function renderConfigSection() {
    if (config === "loading") return null;
    if (mode === "wizard") return <SdrIaWizard
          onActivated={() => {
            // The wizard saved a config the page never fetched: reload it,
            // otherwise the stale null renders "not activated" right after
            // the user activates.
            loadConfig();
            setMode("status");
          }}
        />;
    if (!config) {
      return (
        <div className="mx-auto max-w-2xl px-4 py-4">
          <Card className="flex items-center justify-between gap-4 p-6">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{t("notActivatedTitle")}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{t("notActivatedDescription")}</p>
            </div>
            <Button size="sm" onClick={() => setMode("wizard")}>
              {t("notActivatedCta")}
            </Button>
          </Card>
        </div>
      );
    }
    return (
      <SdrIaStatusPanel
        config={config}
        onConfigUpdated={setConfig}
        onEditFull={() => setMode("wizard")}
      />
    );
  }

  return (
    <>
      <SdrIaMetricsChart />
      {renderConfigSection()}
    </>
  );
}
