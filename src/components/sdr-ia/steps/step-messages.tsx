"use client";

import { useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { templateHasVariables } from "@/lib/whatsapp/template-validators";
import type { MessageTemplate } from "@/types";
import type { WizardDraft } from "../sdr-ia-wizard";

export function StepMessages({
  draft,
  onChange,
  templates,
  templatesLoading,
}: {
  draft: WizardDraft;
  onChange: (patch: Partial<WizardDraft>) => void;
  templates: MessageTemplate[];
  templatesLoading: boolean;
}) {
  const t = useTranslations("SdrIa.wizard.messages");
  const variants = draft.messageVariants ?? [];

  const setVariant = (index: number, value: string) => {
    const next = [...variants];
    next[index] = value;
    onChange({ messageVariants: next.filter((v, i) => v.trim() || i < variants.length) });
  };

  if (draft.sendMode === "template") {
    const usableTemplates = templates.filter((tpl) => !templateHasVariables(tpl));
    const unusableCount = templates.length - usableTemplates.length;

    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t("templateTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("templateDescription")}</p>
        </div>

        {templatesLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : usableTemplates.length === 0 ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-400">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div>
                <p>{t("noUsableTemplates")}</p>
                {unusableCount > 0 && (
                  <p className="mt-1 text-xs">{t("templatesWithVariablesHint", { n: unusableCount })}</p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {usableTemplates.map((tpl) => {
              const selected = draft.templateName === tpl.name && draft.templateLanguage === tpl.language;
              return (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => onChange({ templateName: tpl.name, templateLanguage: tpl.language ?? "pt_BR" })}
                  className={`w-full rounded-lg border p-3 text-left text-sm ${selected ? "border-primary bg-primary/10" : "border-border"}`}
                >
                  <div className="flex items-center gap-2">
                    {selected && <CheckCircle2 className="size-4 shrink-0 text-primary" />}
                    <p className="font-medium text-foreground">{tpl.name}</p>
                    {tpl.language && (
                      <span className="text-xs uppercase text-muted-foreground">{tpl.language}</span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{tpl.body_text}</p>
                </button>
              );
            })}
          </div>
        )}
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
