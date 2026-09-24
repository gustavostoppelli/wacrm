"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { resolveOrCreateTagId, variantTagName } from "@/lib/sdr-ia/tags";
import type { SdrIaConfig } from "@/lib/sdr-ia/config";
import type { WizardDraft } from "../sdr-ia-wizard";

export function StepReview({
  draft,
  existing,
}: {
  draft: WizardDraft;
  existing: SdrIaConfig | null;
}) {
  const t = useTranslations("SdrIa.wizard.review");
  const router = useRouter();
  const { accountId, user } = useAuth();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleActivate = async () => {
    if (!accountId || !user) return;
    setSaving(true);
    setError(null);
    try {
      const supabase = createClient();
      // `tags.user_id` is an auth.users id — `user.id` (the raw session
      // user), not `profile.id` (profiles has its own separate primary
      // key). Same distinction documented in my-whatsapp-channel-panel.tsx.
      const userId = user.id;

      const leadTagId =
        draft.leadTagId ??
        (draft.leadTagName
          ? await resolveOrCreateTagId(supabase, accountId, userId, draft.leadTagName)
          : null);
      if (!leadTagId) throw new Error(t("errorNoLeadTag"));

      // Always resolves to the same fixed system tag name — find-or-create
      // is what makes this idempotent across repeated wizard runs, not a
      // branch on `existing` (there's only ever one contacted-tag name).
      const contactedTagId = await resolveOrCreateTagId(supabase, accountId, userId, "sdr_ia_contatado");

      if (draft.sendMode === "text") {
        const variants = (draft.messageVariants ?? []).filter((v) => v.trim());
        for (let i = 0; i < variants.length; i++) {
          await resolveOrCreateTagId(supabase, accountId, userId, variantTagName(i + 1));
        }
      }

      const res = await fetch("/api/sdr-ia/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...draft,
          leadTagId,
          contactedTagId,
          enabled: true,
        }),
      });
      if (!res.ok) throw new Error(t("errorSaveFailed"));

      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <dl className="space-y-2 rounded-lg border border-border bg-muted/50 p-4 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t("summaryMode")}</dt>
          <dd className="text-foreground">{draft.sendMode === "template" ? t("summaryModeTemplate") : t("summaryModeText")}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t("summaryHours")}</dt>
          <dd className="text-foreground">{draft.hoursStart}h–{draft.hoursEnd}h</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t("summaryDailyCap")}</dt>
          <dd className="text-foreground">{draft.dailyCap}</dd>
        </div>
      </dl>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <Button onClick={handleActivate} disabled={saving} className="w-full">
        {saving ? t("activating") : existing?.enabled ? t("update") : t("activate")}
      </Button>
    </div>
  );
}
