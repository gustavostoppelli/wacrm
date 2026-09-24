"use client";

import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type { WizardDraft } from "../sdr-ia-wizard";

export function StepGuardrails({
  draft,
  onChange,
}: {
  draft: WizardDraft;
  onChange: (patch: Partial<WizardDraft>) => void;
}) {
  const t = useTranslations("SdrIa.wizard.guardrails");

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="hoursStart">{t("hoursStartLabel")}</Label>
          <Input
            id="hoursStart"
            type="number"
            min={0}
            max={23}
            value={draft.hoursStart ?? 9}
            onChange={(e) => onChange({ hoursStart: Number(e.target.value) })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="hoursEnd">{t("hoursEndLabel")}</Label>
          <Input
            id="hoursEnd"
            type="number"
            min={0}
            max={23}
            value={draft.hoursEnd ?? 18}
            onChange={(e) => onChange({ hoursEnd: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="dailyCap">{t("dailyCapLabel")}</Label>
        <Input
          id="dailyCap"
          type="number"
          min={1}
          max={100}
          value={draft.dailyCap ?? 5}
          onChange={(e) => onChange({ dailyCap: Number(e.target.value) })}
        />
        <p className="text-xs text-muted-foreground">{t("dailyCapHint")}</p>
      </div>
    </div>
  );
}
