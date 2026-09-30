"use client";

import { useEffect, useState } from "react";
import { Loader2, Lock, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { supportWhatsAppUrl } from "@/lib/support";
import { WhatsAppConfig } from "./whatsapp-config";
import { UazapiChannelsPanel } from "./uazapi-channels-panel";

/**
 * Settings → WhatsApp, admin+ view. Gates the real config UI behind
 * accounts.whatsapp_enabled (migration 076) — same locked-marketing-
 * view pattern as InstagramConfigPanel and the SDR IA locked view.
 *
 * Unlike Instagram/SDR IA, this is the product's core already-live
 * feature: the migration backfills whatsapp_enabled = true for every
 * account that already has a channel, so this lock only ever appears
 * for a brand-new account before Fuse activates it post-payment.
 */
export function WhatsAppSettingsPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/whatsapp/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => setEnabled(!!json.enabled))
      .catch(() => setEnabled(false));
  }, []);

  if (enabled === null) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <Card className="border-border bg-card">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <MessageCircle className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl text-foreground">WhatsApp</CardTitle>
            <CardDescription className="mt-1 text-sm text-muted-foreground">
              Conecte um número de WhatsApp para atender e automatizar conversas com seus contatos.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mt-2 flex items-center justify-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
              <Lock className="size-3.5 shrink-0" />
              Recurso não incluso no seu plano atual
            </div>
            <Button
              onClick={() =>
                window.open(
                  supportWhatsAppUrl("Olá! Quero saber mais sobre a integração com WhatsApp do FuseHub."),
                  "_blank",
                  "noopener,noreferrer",
                )
              }
              className="mt-4 w-full bg-[#25D366] text-white hover:bg-[#1fb757]"
            >
              Falar com o suporte
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          API Oficial
        </h2>
        <p className="mb-4 text-xs text-muted-foreground">
          WhatsApp Cloud API da Meta — número verificado, exige aprovação de templates.
        </p>
        <WhatsAppConfig />
      </div>
      <div>
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          API Não Oficial
        </h2>
        <p className="mb-4 text-xs text-muted-foreground">
          UAZAPI — conecta pelo QR Code do próprio WhatsApp, sem aprovação da Meta.
        </p>
        <UazapiChannelsPanel />
      </div>
    </div>
  );
}
