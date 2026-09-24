"use client";

import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { WizardDraft } from "../sdr-ia-wizard";

export function StepMessages({
  draft,
  onChange,
}: {
  draft: WizardDraft;
  onChange: (patch: Partial<WizardDraft>) => void;
}) {
  const t = useTranslations("SdrIa.wizard.messages");
  const variants = draft.messageVariants ?? [];

  const setVariant = (index: number, value: string) => {
    const next = [...variants];
    next[index] = value;
    onChange({ messageVariants: next.filter((v, i) => v.trim() || i < variants.length) });
  };

  if (draft.sendMode === "template") {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t("templateTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("templateDescription")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="templateName">{t("templateNameLabel")}</Label>
          <Input
            id="templateName"
            value={draft.templateName ?? ""}
            onChange={(e) => onChange({ templateName: e.target.value })}
            placeholder={t("templateNamePlaceholder")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="templateLanguage">{t("templateLanguageLabel")}</Label>
          <Input
            id="templateLanguage"
            value={draft.templateLanguage ?? "pt_BR"}
            onChange={(e) => onChange({ templateLanguage: e.target.value })}
            placeholder="pt_BR"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("variantsTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("variantsDescription")}</p>
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2">
          <Label htmlFor={`variant-${i}`}>{t("variantLabel", { n: i + 1 })}</Label>
          <Textarea
            id={`variant-${i}`}
            value={variants[i] ?? ""}
            onChange={(e) => setVariant(i, e.target.value)}
            placeholder={t("variantPlaceholder")}
            rows={3}
          />
        </div>
      ))}
    </div>
  );
}
