"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Label } from "@/components/ui/label";
import type { WizardDraft } from "../sdr-ia-wizard";

interface Channel {
  id: string;
  name: string | null;
  provider: string;
}

export function StepChannel({
  draft,
  onChange,
}: {
  draft: WizardDraft;
  onChange: (patch: Partial<WizardDraft>) => void;
}) {
  const t = useTranslations("SdrIa.wizard.channel");
  const [channels, setChannels] = useState<Channel[]>([]);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("whatsapp_config")
      .select("id, name, provider")
      .then(({ data }) => setChannels((data as Channel[]) ?? []));
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="channel">{t("channelLabel")}</Label>
        <select
          id="channel"
          value={draft.whatsappConfigId ?? ""}
          onChange={(e) => onChange({ whatsappConfigId: e.target.value || undefined })}
          className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground"
        >
          <option value="">{t("channelPlaceholder")}</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name ?? c.id} ({c.provider})
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label>{t("modeLabel")}</Label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => onChange({ sendMode: "template" })}
            className={`rounded-lg border p-3 text-left text-sm ${draft.sendMode === "template" ? "border-primary bg-primary/10" : "border-border"}`}
          >
            <p className="font-medium text-foreground">{t("modeTemplateTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("modeTemplateDesc")}</p>
          </button>
          <button
            type="button"
            onClick={() => onChange({ sendMode: "text" })}
            className={`rounded-lg border p-3 text-left text-sm ${draft.sendMode === "text" ? "border-primary bg-primary/10" : "border-border"}`}
          >
            <p className="font-medium text-foreground">{t("modeTextTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("modeTextDesc")}</p>
          </button>
        </div>
        {draft.sendMode === "text" && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {t("modeTextWarning")}
          </div>
        )}
      </div>
    </div>
  );
}
