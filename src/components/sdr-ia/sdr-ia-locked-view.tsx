"use client";

import { Bot, Check, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { supportWhatsAppUrl } from "@/lib/support";

/**
 * Shown on /sdr-ia for every account with accounts.sdr_ia_enabled =
 * false (the sellable-product default — see migration 070). The menu
 * item itself is always visible; this is where the actual gate lives.
 * CTA goes to support for now — same manual-upgrade pattern as
 * ChannelLimitDialog (src/components/settings/channel-limit-dialog.tsx)
 * until a real checkout exists.
 */
export function SdrIaLockedView() {
  const t = useTranslations("SdrIa");
  const benefits = [t("benefit1"), t("benefit2"), t("benefit3"), t("benefit4")];

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <Card className="border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Bot className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">{t("lockedTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("lockedSubtitle")}</p>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2.5 py-2">
            {benefits.map((b) => (
              <li key={b} className="flex items-start gap-2 text-sm text-foreground">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                {b}
              </li>
            ))}
          </ul>

          <div className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            <Lock className="size-3.5 shrink-0" />
            Recurso não incluso no seu plano atual
          </div>

          <Button
            onClick={() =>
              window.open(supportWhatsAppUrl(t("prefilledMessage")), "_blank", "noopener,noreferrer")
            }
            className="mt-4 w-full bg-[#25D366] text-white hover:bg-[#1fb757]"
          >
            {t("cta")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
