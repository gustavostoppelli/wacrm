'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { toast } from 'sonner';
import { QrCode, CheckCircle2, XCircle, Loader2, RefreshCw } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { WhatsAppConfig } from '@/types';

type MyChannel = Pick<WhatsAppConfig, 'id' | 'name' | 'status' | 'connected_at'>;

const STATUS_POLL_MS = 3000;

/**
 * The non-admin counterpart to UazapiChannelsPanel — shown instead of
 * it on the WhatsApp settings tab for anyone below admin (migration
 * 060). Lists only the channel(s) an admin explicitly assigned to the
 * current user (`whatsapp_config.assigned_to`) and lets them complete
 * the QR pairing themselves. No server credentials, no add/delete, no
 * AI toggle, no visibility into any other channel on the account —
 * those stay admin-only by design (the account bills per connected
 * number, so which channels exist is a decision the admin makes, not
 * something a teammate can do on their own).
 */
export function MyWhatsAppChannelPanel() {
  const supabase = createClient();
  const { accountId, user, loading: authLoading, profileLoading } = useAuth();

  const [channels, setChannels] = useState<MyChannel[]>([]);
  const [loading, setLoading] = useState(true);

  const [connectChannelId, setConnectChannelId] = useState<string | null>(null);
  const [qrcode, setQrcode] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchChannels = useCallback(async (acctId: string, userId: string) => {
    setLoading(true);
    const { data, error } = await supabase
      .from('whatsapp_config')
      .select('id, name, status, connected_at')
      .eq('account_id', acctId)
      .eq('assigned_to', userId)
      .order('created_at', { ascending: true });
    if (error) console.error('Failed to load assigned WhatsApp channel:', error);
    setChannels(data || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    if (authLoading || profileLoading || !accountId || !user?.id) return;
    // `whatsapp_config.assigned_to` is an auth.users id — `user.id`
    // (the raw session user), not `profile.id` (profiles has its own
    // separate primary key), is the matching value here.
    fetchChannels(accountId, user.id);
  }, [authLoading, profileLoading, accountId, user, fetchChannels]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function startConnect(channelId: string) {
    setConnectChannelId(channelId);
    setQrcode(null);
    setConnectError(null);
    setConnecting(true);
    try {
      const res = await fetch(`/api/uazapi/channels/${channelId}/connect`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setConnectError(data.error || 'Failed to start connection');
        return;
      }
      if (data.connected) {
        toast.success('Already connected!');
        setConnectChannelId(null);
        return;
      }
      setQrcode(data.qrcode || null);
      pollRef.current = setInterval(() => pollStatus(channelId), STATUS_POLL_MS);
    } catch (err) {
      console.error('UAZAPI connect error:', err);
      setConnectError('Failed to reach the WhatsApp server');
    } finally {
      setConnecting(false);
    }
  }

  async function pollStatus(channelId: string) {
    try {
      const res = await fetch(`/api/uazapi/channels/${channelId}/status`);
      const data = await res.json();
      if (!res.ok) return;
      if (data.qrcode) setQrcode(data.qrcode);
      if (data.connected) {
        stopPolling();
        toast.success('WhatsApp connected!');
        setConnectChannelId(null);
        setQrcode(null);
        if (accountId && user?.id) fetchChannels(accountId, user.id);
      }
    } catch (err) {
      console.error('UAZAPI status poll error:', err);
    }
  }

  function closeConnectDialog(open: boolean) {
    if (!open) {
      stopPolling();
      setConnectChannelId(null);
      setQrcode(null);
      setConnectError(null);
    }
  }

  if (!loading && channels.length === 0) {
    // No channel assigned yet — nothing to show. An admin assigns one
    // from Settings → WhatsApp on their own account.
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">Your WhatsApp number</CardTitle>
        <CardDescription className="text-muted-foreground">
          Connect the phone your account was set up with.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          channels.map((ch) => (
            <div
              key={ch.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                {ch.status === 'connected' ? (
                  <CheckCircle2 className="size-4 text-emerald-400 shrink-0" />
                ) : (
                  <XCircle className="size-4 text-red-500 shrink-0" />
                )}
                <p className="text-sm font-medium text-foreground truncate">
                  {ch.name || 'WhatsApp'}
                </p>
                <Badge
                  className={
                    ch.status === 'connected'
                      ? 'bg-emerald-600/20 text-emerald-400 border-emerald-600/30'
                      : 'bg-red-600/20 text-red-400 border-red-600/30'
                  }
                >
                  {ch.status}
                </Badge>
              </div>
              {ch.status !== 'connected' && (
                <Button size="sm" onClick={() => startConnect(ch.id)}>
                  <QrCode className="size-3.5" />
                  Connect
                </Button>
              )}
            </div>
          ))
        )}
      </CardContent>

      <Dialog open={!!connectChannelId} onOpenChange={closeConnectDialog}>
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">Scan to connect</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Open WhatsApp on your phone → Linked Devices → Link a Device,
              then scan this code.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center justify-center gap-3 py-4">
            {connecting ? (
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
            ) : connectError ? (
              <div className="text-center space-y-3">
                <XCircle className="size-8 text-red-500 mx-auto" />
                <p className="text-sm text-red-400">{connectError}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => connectChannelId && startConnect(connectChannelId)}
                >
                  <RefreshCw className="size-3.5" />
                  Retry
                </Button>
              </div>
            ) : qrcode ? (
              <>
                <Image
                  src={qrcode}
                  alt="WhatsApp QR code"
                  width={256}
                  height={256}
                  unoptimized
                  className="rounded-lg border border-border"
                />
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" />
                  Waiting for scan…
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Generating QR code…</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
