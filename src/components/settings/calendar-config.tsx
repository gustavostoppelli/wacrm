'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CalendarDays, CheckCircle2, ExternalLink, Loader2, Unplug } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

interface CalendarStatus {
  connected: boolean;
  google_email?: string;
  calendar_id?: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'Você cancelou a autorização no Google.',
  missing_code_or_state: 'A resposta do Google veio incompleta — tente novamente.',
  invalid_state: 'Sessão de conexão inválida — tente novamente.',
  state_mismatch: 'Sessão de conexão expirada ou inválida — tente novamente.',
  account_mismatch: 'Você trocou de conta durante a conexão — tente novamente.',
  not_logged_in: 'Sua sessão expirou — faça login de novo e tente conectar.',
  save_failed: 'Não conseguimos salvar a conexão — tente novamente.',
  exchange_failed: 'O Google recusou a autorização — tente novamente.',
};

/**
 * Native, multi-tenant Google Calendar connection panel. Any FuseHub
 * account — Fuse's own or a future customer's — connects its own
 * calendar here; nothing in this component is Fuse-specific.
 */
export function CalendarConfig() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/calendar/google');
      const data = await res.json();
      setStatus(res.ok ? data : { connected: false });
    } catch {
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Feedback from the OAuth round-trip lands here as query params
  // (the callback route always redirects back to ?tab=calendar).
  useEffect(() => {
    const connected = searchParams.get('calendar_connected');
    const error = searchParams.get('calendar_error');
    if (connected) {
      toast.success('Google Agenda conectado com sucesso!');
      fetchStatus();
    } else if (error) {
      toast.error(ERROR_MESSAGES[error] ?? 'Não foi possível conectar o Google Agenda.');
    }
    if (connected || error) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete('calendar_connected');
      params.delete('calendar_error');
      router.replace(`/settings?${params.toString()}`, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function disconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch('/api/calendar/google', { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body?.error ?? 'Não foi possível desconectar.');
        return;
      }
      toast.success('Google Agenda desconectado.');
      setStatus({ connected: false });
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div>
      <SettingsPanelHead
        title="Agenda"
        description="Conecte o Google Agenda para o Agente de IA verificar horários reais e marcar compromissos automaticamente, sem risco de choque de horário."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarDays className="h-4 w-4" />
            Google Agenda
          </CardTitle>
          <CardDescription>
            Uma conexão por conta. O acesso é criptografado e usado apenas para checar
            disponibilidade e criar eventos — nunca para ler o conteúdo dos seus outros
            compromissos.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando...
            </div>
          ) : status?.connected ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <span>
                  Conectado como <strong>{status.google_email}</strong>
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={disconnect}
                disabled={disconnecting}
              >
                {disconnecting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Unplug className="h-4 w-4" />
                )}
                Desconectar
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">Nenhuma agenda conectada ainda.</p>
              <Button
                size="sm"
                onClick={() => {
                  window.location.href = '/api/calendar/google/connect';
                }}
              >
                <ExternalLink className="h-4 w-4" />
                Conectar Google Agenda
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
