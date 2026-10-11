"use client";

import { useEffect, useState } from "react";
import { SdrIaWizard } from "./sdr-ia-wizard";
import { SdrIaStatusPanel } from "./sdr-ia-status-panel";
import type { SdrIaConfig } from "@/lib/sdr-ia/config";

/**
 * Entry point for an unlocked account: once the account has activated
 * SDR IA at least once (a saved sdr_ia_config row exists), day-to-day
 * operation is the status panel (on/off + hours) — reopening the full
 * 5-step wizard every time someone wants to pause it was the gap this
 * closes. First-time setup (no row yet) always goes straight to the
 * wizard, same as before.
 */
export function SdrIaHome() {
  const [config, setConfig] = useState<SdrIaConfig | null | "loading">("loading");
  const [mode, setMode] = useState<"status" | "wizard">("status");

  useEffect(() => {
    fetch("/api/sdr-ia/config", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => setConfig((data.config as SdrIaConfig | undefined) ?? null))
      .catch(() => setConfig(null));
  }, []);

  if (config === "loading") return null;

  if (!config || mode === "wizard") {
    return <SdrIaWizard onActivated={() => setMode("status")} />;
  }

  return (
    <SdrIaStatusPanel
      config={config}
      onConfigUpdated={setConfig}
      onEditFull={() => setMode("wizard")}
    />
  );
}
