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
import { Switch } from '@/components/ui/switch';
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

type UazapiChannel = Pick<
  WhatsAppConfig,
  'id' | 'name' | 'status' | 'uazapi_base_url' | 'connected_at' | 'ai_enabled'
>;

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

  // Whether this account already has a saved UAZAPI server (migration
  // 059) — once true, "Add channel" only asks for a name; a teammate
  // adding their own number never needs the admin token. `null` means
  // "still loading", so the dialog doesn't flash the credential form
  // before this resolves.
  const [serverConfigured, setServerConfigured] = useState<boolean | null>(null);
  const [serverBaseUrl, setServerBaseUrl] = useState<string | null>(null);
  const [showServerFields, setShowServerFields] = useState(false);

  const [connectChannelId, setConnectChannelId] = useState<string | null>(null);
  const [qrcode, setQrcode] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingAiId, setTogglingAiId] = useState<string | null>(null);

  const fetchChannels = useCallback(async (acctId: string) => {
    setLoading(true);
    const { data, error } = await supabase
      .from('whatsapp_config')
      .select('id, name, status, uazapi_base_url, connected_at, ai_enabled')
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

  const fetchServerConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/uazapi/server');
      const data = await res.json();
      if (!res.ok) return;
      setServerConfigured(!!data.configured);
      setServerBaseUrl(data.base_url || null);
    } catch (err) {
      console.error('Failed to load UAZAPI server config:', err);
    }
  }, []);

  useEffect(() => {
    if (authLoading || profileLoading || !accountId) return;
    fetchChannels(accountId);
    fetchServerConfig();
  }, [authLoading, profileLoading, accountId, fetchChannels, fetchServerConfig]);

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

  // Credential fields are only required the first time (or when the
  // teammate explicitly asks to use a different server) — once an
  // account has a saved server, adding another channel is just a name.
  const needsServerFields = !serverConfigured || showServerFields;

  async function handleCreate() {
    if (needsServerFields && (!baseUrl.trim() || !adminToken.trim())) {
      toast.error('Server URL and admin token are required');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/uazapi/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(needsServerFields
            ? { base_url: baseUrl.trim(), admin_token: adminToken.trim() }
            : {}),
          name: channelName.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to connect to UAZAPI');
        return;
      }
      toast.success('Channel created — scan the QR code to finish connecting.');
      fetchServerConfig();
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

  async function handleToggleAi(channelId: string, nextEnabled: boolean) {
    setTogglingAiId(channelId);
    // Optimistic — flip immediately, roll back on failure so the switch
    // never silently drifts from what the server actually has.
    setChannels((prev) =>
      prev.map((c) => (c.id === channelId ? { ...c, ai_enabled: nextEnabled } : c))
    );
    try {
      const res = await fetch(`/api/uazapi/channels/${channelId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ai_enabled: nextEnabled }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error || 'Failed to update channel');
        setChannels((prev) =>
          prev.map((c) => (c.id === channelId ? { ...c, ai_enabled: !nextEnabled } : c))
        );
        return;
      }
      toast.success(nextEnabled ? 'AI agent enabled on this channel' : 'AI agent disabled — channel is now human-only');
    } catch (err) {
      console.error('Toggle AI channel error:', err);
      toast.error('Failed to update channel');
      setChannels((prev) =>
        prev.map((c) => (c.id === channelId ? { ...c, ai_enabled: !nextEnabled } : c))
      );
    } finally {
      setTogglingAiId(null);
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
                <div className="flex items-center gap-1.5 pr-2 border-r border-border mr-1">
                  <Switch
                    checked={ch.ai_enabled !== false}
                    disabled={togglingAiId === ch.id}
                    onCheckedChange={(checked) => handleToggleAi(ch.id, checked)}
                  />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    AI agent
                  </span>
                </div>
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
      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (open) setShowServerFields(!serverConfigured);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {needsServerFields ? 'Connect a UAZAPI channel' : 'Add a channel'}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {needsServerFields
                ? 'Paste your UAZAPI server URL and admin token once — every channel after this one reuses it, so teammates never need to see it.'
                : 'Just give the channel a name. It reuses the server already configured for this account — no credentials needed.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {!needsServerFields && serverBaseUrl && (
              <p className="text-xs text-muted-foreground">
                Server: <span className="text-foreground">{serverBaseUrl}</span>{' '}
                <button
                  type="button"
                  onClick={() => setShowServerFields(true)}
                  className="underline hover:text-foreground"
                >
                  use a different one
                </button>
              </p>
            )}
            {needsServerFields && (
              <>
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
              </>
            )}
            <div className="space-y-2">
              <Label className="text-muted-foreground">
                Name <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                placeholder="e.g. Sales — Ana"
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
