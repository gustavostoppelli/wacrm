"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SdrIaConfig, SdrIaConfigInput } from "@/lib/sdr-ia/config";
import { StepLeadSource } from "./steps/step-lead-source";
import { StepChannel } from "./steps/step-channel";
import { StepMessages } from "./steps/step-messages";
import { StepGuardrails } from "./steps/step-guardrails";
import { StepReview } from "./steps/step-review";

export type WizardDraft = Partial<SdrIaConfigInput> & {
  leadTagName?: string;
};

const STEP_COUNT = 5;

/**
 * 5-step config wizard (see docs/superpowers/specs/2026-09-24-sdr-ia-
 * first-party-feature-design.md): lead source, channel, messages,
 * guardrails, review+activate. Draft state lives here; each step is a
 * pure form that reads/writes `draft` via props — no step fetches or
 * persists on its own except StepReview, which does the final PUT.
 */
export function SdrIaWizard() {
  const t = useTranslations("SdrIa.wizard");
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<WizardDraft>({
    sendMode: "template",
    templateLanguage: "pt_BR",
    messageVariants: [],
    dailyCap: 5,
    hoursStart: 9,
    hoursEnd: 18,
  });
  const [existing, setExisting] = useState<SdrIaConfig | null>(null);

  useEffect(() => {
    fetch("/api/sdr-ia/config", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (data.config) {
          setExisting(data.config as SdrIaConfig);
          setDraft(data.config as SdrIaConfig);
        }
      })
      .catch(() => {});
  }, []);

  const update = (patch: Partial<WizardDraft>) => setDraft((prev) => ({ ...prev, ...patch }));

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6 flex items-center gap-2">
        {Array.from({ length: STEP_COUNT }, (_, i) => i + 1).map((n) => (
          <div
            key={n}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              n <= step ? "bg-primary" : "bg-muted",
            )}
          />
        ))}
      </div>

      <Card className="p-6">
        {step === 1 && <StepLeadSource draft={draft} onChange={update} />}
        {step === 2 && <StepChannel draft={draft} onChange={update} />}
        {step === 3 && <StepMessages draft={draft} onChange={update} />}
        {step === 4 && <StepGuardrails draft={draft} onChange={update} />}
        {step === 5 && <StepReview draft={draft} existing={existing} />}

        <div className="mt-6 flex items-center justify-between">
          <Button
            variant="outline"
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            disabled={step === 1}
          >
            {t("back")}
          </Button>
          {step < STEP_COUNT ? (
            <Button onClick={() => setStep((s) => Math.min(STEP_COUNT, s + 1))}>
              {t("next")}
            </Button>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
