"use client";

import { useEffect, useState } from "react";
import { SdrIaLockedView } from "@/components/sdr-ia/sdr-ia-locked-view";
import { SdrIaWizard } from "@/components/sdr-ia/sdr-ia-wizard";

export default function SdrIaPage() {
  const [status, setStatus] = useState<"loading" | "locked" | "unlocked">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sdr-ia/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setStatus(data.enabled ? "unlocked" : "locked");
      })
      .catch(() => {
        if (!cancelled) setStatus("locked");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "loading") return null;
  if (status === "locked") return <SdrIaLockedView />;
  return <SdrIaWizard />;
}
