'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { toast } from 'sonner';
import {
  Plus,
  Trash2,
  Loader2,
  QrCode,
  CheckCircle2,
  XCircle,
  RefreshCw,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import type { WhatsAppConfig } from '@/types';

type UazapiChannel = Pick<WhatsAppConfig, 'id' | 'name' | 'status' | 'uazapi_base_url' | 'connected_at'>;

const STATUS_POLL_MS = 3000;

/**
 * UAZAPI channels — an unofficial, QR-code-connected WhatsApp provider,
 * alongside (not instead of) the Meta Cloud API card above. An account
 * can run any mix of channels; each conversation remembers which one
 * it arrived on (migration 037).
 */
export function UazapiChannelsPanel() {
  const supabase = createClient();
  const { accountId, loading: authLoading, profileLoading } = useAuth();

  const [channels, setChannels] = useState<UazapiChannel[]>([]);
  const [loading, setLoading] = useState(true);

  const [addOpen, setAddOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [adminToken, setAdminToken] = useState('');
  const [channelName, setChannelName] = useState('');
  const [creating, setCreating] = useState(false);

  const [connectChannelId, setConnectChannelId] = useState<string | null>(null);
  const [qrcode, setQrcode] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchChannels = useCallback(async (acctId: string) => {
    setLoading(true);
    const { data, error } = await supabase
      .from('whatsapp_config')
      .select('id, name, status, uazapi_base_url, connected_at')
      .eq('account_id', acctId)
      .eq('provider', 'uazapi')
      .order('created_at', { ascending: true });
    if (error) console.error('Failed to load UAZAPI channels:', error);
    setChannels(data || []);
    setLoading(false);

    // The `status` column above is a snapshot from whenever it was last
    // written (channel creation, or a previous live check) -- it does NOT
    // track a session getting logged out on the WhatsApp side in between.
    // Confirmed live once (issue found 2026-08-23): a channel sat marked
    // "connected" in the DB for over a week after WhatsApp had actually
    // logged it out, and because the "Connect" button below is only shown
    // for non-connected channels, the stale flag hid the one control that
    // would have let the user reconnect. Re-check every channel's real
    // status right after loading so the badge (and the Connect button's
    // visibility) reflect reality, not a cached column.
    for (const ch of data || []) {
      fetch(`/api/uazapi/channels/${ch.id}/status`)
        .then((res) => res.json())
        .then((result) => {
          if (typeof result?.status !== 'string') return
          setChannels((prev) =>
            prev.map((c) => (c.id === ch.id ? { ...c, status: result.status } : c))
          )
        })
        .catch((err) => console.error('UAZAPI live status check failed:', err))
    }
  }, [supabase]);

  useEffect(() => {
    if (authLoading || profileLoading || !accountId) return;
    fetchChannels(accountId);
  }, [authLoading, profileLoading, accountId, fetchChannels]);

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

  async function handleCreate() {
    if (!baseUrl.trim() || !adminToken.trim()) {
      toast.error('Server URL and admin token are required');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/uazapi/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: baseUrl.trim(),
          admin_token: adminToken.trim(),
          name: channelName.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to connect to UAZAPI');
        return;
      }
      toast.success('Channel created — scan the QR code to finish connecting.');
      setAddOpen(false);
      setBaseUrl('');
      setAdminToken('');
      setChannelName('');
      if (accountId) await fetchChannels(accountId);
      startConnect(data.channel.id);
    } catch (err) {
      console.error('Create UAZAPI channel error:', err);
      toast.error('Failed to connect to UAZAPI');
    } finally {
      setCreating(false);
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
        if (accountId) await fetchChannels(accountId);
        return;
      }
      setQrcode(data.qrcode || null);
      pollRef.current = setInterval(() => pollStatus(channelId), STATUS_POLL_MS);
    } catch (err) {
      console.error('UAZAPI connect error:', err);
      setConnectError('Failed to reach the UAZAPI server');
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
        if (accountId) await fetchChannels(accountId);
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

  async function handleDelete(channelId: string) {
    if (!confirm('Disconnect and remove this WhatsApp channel? Conversation history is kept.')) {
      return;
    }
    setDeletingId(channelId);
    try {
      const res = await fetch(`/api/uazapi/channels/${channelId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to remove channel');
        return;
      }
      toast.success('Channel removed');
      if (accountId) await fetchChannels(accountId);
    } catch (err) {
      console.error('Delete UAZAPI channel error:', err);
      toast.error('Failed to remove channel');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <CardTitle className="text-foreground">UAZAPI channels</CardTitle>
          <CardDescription className="text-muted-foreground">
            Connect additional WhatsApp numbers via QR code — no Meta approval
            needed. Bring your own UAZAPI server (self-hosted or a subscription).
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="size-4" />
          Add channel
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : channels.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            No UAZAPI channels connected yet.
          </p>
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
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">
                    {ch.name || 'UAZAPI channel'}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {ch.uazapi_base_url}
                  </p>
                </div>
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
              <div className="flex items-center gap-2 shrink-0">
                {ch.status !== 'connected' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => startConnect(ch.id)}
                    className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                  >
                    <QrCode className="size-3.5" />
                    Connect
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => handleDelete(ch.id)}
                  disabled={deletingId === ch.id}
                  className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
                >
                  {deletingId === ch.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>

      {/* Add channel dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="bg-popover border-border sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">Connect a UAZAPI channel</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Paste your UAZAPI server URL and admin token. The admin token is
              used once to create your instance and is never stored.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">Server URL</Label>
              <Input
                placeholder="https://free.uazapi.com"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">Admin token</Label>
              <Input
                type="password"
                placeholder="Your UAZAPI server's admin token"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">
                Name <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                placeholder="e.g. Sales"
                value={channelName}
                onChange={(e) => setChannelName(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : null}
              Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* QR code dialog */}
      <Dialog open={!!connectChannelId} onOpenChange={closeConnectDialog}>
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">Scan to connect</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Open WhatsApp on the phone you want to connect → Linked Devices →
              Link a Device, then scan this code.
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
