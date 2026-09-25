"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Camera, CheckCircle2, Loader2, Lock } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { supportWhatsAppUrl } from "@/lib/support";

interface InstagramConfig {
  igUserId: string;
  igUsername: string | null;
  status: "connected" | "disconnected";
  connectedAt: string;
}

interface StatusResponse {
  enabled: boolean;
  config: InstagramConfig | null;
}

/**
 * Settings → Instagram. Mirrors the WhatsApp panel's shape: a locked
 * marketing view for accounts without accounts.instagram_enabled
 * (mirrors SdrIaLockedView), and a connect/connected view for accounts
 * that do have it.
 */
export function InstagramConfigPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);

  const load = () => {
    setLoading(true);
    fetch("/api/instagram/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => setData(json))
      .catch(() => setData({ enabled: false, config: null }))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const connected = searchParams.get("instagram_connected");
    const error = searchParams.get("instagram_error");
    if (connected) {
      toast.success("Instagram conectado com sucesso.");
      load();
    } else if (error) {
      toast.error(`Falha ao conectar o Instagram: ${error}`);
    }
    // Clean up OAuth callback params from URL after toasting
    if (connected || error) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("instagram_connected");
      params.delete("instagram_error");
      router.replace(`/settings?${params.toString()}`, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function disconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/instagram/status", { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("Instagram desconectado.");
      load();
    } catch {
      toast.error("Não foi possível desconectar. Tente novamente.");
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data?.enabled) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <Card className="border-border bg-card">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <Camera className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-xl font-semibold text-foreground">Integração com Instagram</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Use comentários em posts e mensagens via Direct como gatilho das suas automações.
            </p>
          </CardHeader>
          <CardContent>
            <div className="mt-2 flex items-center justify-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
              <Lock className="size-3.5 shrink-0" />
              Recurso não incluso no seu plano atual
            </div>
            <Button
              onClick={() =>
                window.open(
                  supportWhatsAppUrl("Olá! Quero saber mais sobre a integração com Instagram do FuseHub."),
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

  const config = data.config;

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="text-foreground">Instagram</CardTitle>
        <CardDescription className="text-muted-foreground">
          Conecte sua conta Instagram Business para usar comentários e Direct como gatilho de
          automação. Nunca pedimos sua senha — a conexão é feita pelo login oficial da Meta.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {config?.status === "connected" ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="size-4 text-emerald-400" />
              <div>
                <p className="text-sm font-medium text-foreground">
                  @{config.igUsername ?? config.igUserId}
                </p>
                <p className="text-xs text-muted-foreground">Conectado</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={disconnect} disabled={disconnecting}>
              {disconnecting ? "Desconectando..." : "Desconectar"}
            </Button>
          </div>
        ) : (
          // Anchor styled with `buttonVariants` rather than wrapping in
          // <Button asChild> — the wacrm Button is the Base UI
          // ButtonPrimitive, which has no Radix-style asChild slot (see
          // invite-member-dialog.tsx for the same pattern).
          <a href="/api/instagram/oauth/connect" className={buttonVariants({})}>
            Conectar Instagram
          </a>
        )}
      </CardContent>
    </Card>
  );
}
