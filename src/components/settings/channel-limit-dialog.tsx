"use client";

import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { supportWhatsAppUrl } from "@/lib/support";

/**
 * Shown when a channel-creation call comes back with
 * `error: 'channel_limit_reached'` (see channel-limit.ts, migration
 * 067) — every account starts on a 1-number plan; this is the upsell
 * for a second connection. The CTA goes to support for now (manual
 * upgrade — the account owner raises `accounts.whatsapp_channel_limit`
 * by hand once payment is confirmed); swapping in a real checkout
 * later only changes this one href, nothing about the gate itself.
 */
export function ChannelLimitDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("Settings.whatsapp.channelLimit");
  const features = [
    t("featureQrCode"),
    t("featureUnlimitedAgents"),
    t("featureTextOrVoice"),
    t("featureAi"),
    t("featureFlows"),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-center text-popover-foreground">
            {t("title")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-1 text-center">
          <p className="text-3xl font-bold text-foreground">
            {t("price")}
            <span className="text-base font-normal text-muted-foreground">
              {t("perMonth")}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">{t("priceHint")}</p>
        </div>

        <ul className="space-y-2.5 py-2">
          {features.map((f) => (
            <li key={f} className="flex items-center gap-2 text-sm text-foreground">
              <Check className="size-4 shrink-0 text-primary" />
              {f}
            </li>
          ))}
        </ul>

        <Button
          onClick={() => window.open(supportWhatsAppUrl(t("prefilledMessage")), "_blank", "noopener,noreferrer")}
          className="w-full bg-[#25D366] text-white hover:bg-[#1fb757]"
        >
          {t("cta")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
