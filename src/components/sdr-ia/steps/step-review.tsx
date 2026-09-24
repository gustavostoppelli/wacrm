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

      // Tags are created before the PUT below; if the PUT fails, the
      // tags remain but are harmless orphans (resolveOrCreateTagId is
      // idempotent — a retry finds them again rather than duplicating).
      // Not rolled back because a partial DB transaction across two
      // separate calls (tag creation + config PUT) isn't feasible from
      // a client component.
      const leadTagId =
        draft.leadTagId ??
        (draft.leadTagName
          ? await resolveOrCreateTagId(supabase, accountId, userId, draft.leadTagName)
          : null);
      if (!leadTagId) throw new Error(t("errorNoLeadTag"));

      // Reuse the existing contacted-tag id when we have one — only
      // resolve-by-name on first activation. Re-resolving by name on
      // every save risked landing on a DIFFERENT tag (e.g. if the
      // lookup ever raced or the tag's name was edited/duplicated),
      // which would silently make every previously-contacted lead
      // look untouched again and get re-messaged.
      const contactedTagId =
        existing?.contactedTagId ??
        (await resolveOrCreateTagId(supabase, accountId, userId, "sdr_ia_contatado"));

      // Filter empty variants HERE (not just when creating their tags
      // below) — an empty string saved to message_variants would later
      // be picked by the cron's random-variant selection and fail to
      // send, after the contact is already tagged "contacted".
      const cleanedVariants = (draft.messageVariants ?? []).filter((v) => v.trim().length > 0);

      if (draft.sendMode === "text") {
        for (let i = 0; i < cleanedVariants.length; i++) {
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
          messageVariants: draft.sendMode === "text" ? cleanedVariants : draft.messageVariants,
          enabled: true,
        }),
      });
      if (!res.ok) {
        if (res.status === 403) {
          throw new Error(t("errorNeedsAdmin"));
        }
        // Surface the API's actual validation message (e.g. "Template
        // mode requires a Meta WhatsApp channel") instead of a generic
        // "couldn't save" — the specific reason is exactly what tells
        // the user which wizard step to go back and fix.
        let serverMessage: string | null = null;
        try {
          const body = await res.json();
          if (typeof body?.error === "string") serverMessage = body.error;
        } catch {
          // response wasn't JSON — fall through to the generic message
        }
        throw new Error(serverMessage ?? t("errorSaveFailed"));
      }

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
