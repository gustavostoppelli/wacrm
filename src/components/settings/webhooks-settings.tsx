'use client';

// ============================================================
// WebhooksSettings — Settings → Integrações
//
// Self-service inbound webhook connections: an account pastes its own
// URL into whatever external tool it uses (a checkout platform, a
// form, anything that can POST JSON on an event) and FuseHub creates/
// updates a contact + deal from it. No platform is named anywhere in
// this UI — the account names each connection itself — and each one
// picks its own destination pipeline stage at creation time.
//
// One-time reveal: a freshly-created connection's URL (which embeds
// its bearer token) is shown ONCE in the creation dialog, mirroring
// ApiKeysSettings — the server only ever stores the token's hash.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, Plus, Trash2, Webhook } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { SettingsPanelHead } from './settings-panel-head';

interface WebhookRow {
  id: string;
  name: string;
  pipeline_id: string;
  stage_id: string;
  is_active: boolean;
  last_received_at: string | null;
  created_at: string;
}

interface PipelineOption {
  id: string;
  name: string;
}
interface StageOption {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function WebhooksSettings() {
  const { canEditSettings } = useAuth();
  const t = useTranslations('Settings.webhooks');

  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [pipelines, setPipelines] = useState<PipelineOption[]>([]);
  const [stages, setStages] = useState<StageOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const supabase = createClient();
      const [webhooksRes, pipelinesRes, stagesRes] = await Promise.all([
        fetch('/api/account/webhooks', { cache: 'no-store' }),
        supabase.from('pipelines').select('id, name').order('name'),
        supabase
          .from('pipeline_stages')
          .select('id, pipeline_id, name, position')
          .order('position'),
      ]);
      if (!webhooksRes.ok) {
        const payload = await webhooksRes.json().catch(() => ({}));
        toast.error(payload.error || t('loadFailed'));
      } else {
        const data = (await webhooksRes.json()) as { webhooks: WebhookRow[] };
        setWebhooks(data.webhooks);
      }
      setPipelines((pipelinesRes.data as PipelineOption[] | null) ?? []);
      setStages((stagesRes.data as StageOption[] | null) ?? []);
    } catch (err) {
      console.error('[WebhooksSettings] load error:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function stageLabel(w: WebhookRow): string {
    const pipeline = pipelines.find((p) => p.id === w.pipeline_id);
    const stage = stages.find((s) => s.id === w.stage_id);
    if (!pipeline || !stage) return '—';
    return `${pipeline.name} → ${stage.name}`;
  }

  async function handleToggle(w: WebhookRow, next: boolean) {
    setBusyId(w.id);
    setWebhooks((prev) => prev.map((x) => (x.id === w.id ? { ...x, is_active: next } : x)));
    try {
      const res = await fetch(`/api/account/webhooks/${w.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: next }),
      });
      if (!res.ok) {
        setWebhooks((prev) => prev.map((x) => (x.id === w.id ? { ...x, is_active: !next } : x)));
        toast.error(t('toggleFailed'));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(w: WebhookRow) {
    setBusyId(w.id);
    try {
      const res = await fetch(`/api/account/webhooks/${w.id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(t('deleteFailed'));
        return;
      }
      setWebhooks((prev) => prev.filter((x) => x.id !== w.id));
      toast.success(t('deleteSuccess', { name: w.name }));
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <RequireRole min="admin">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {t('newConnection')}
            </Button>
          </RequireRole>
        }
      />

      {webhooks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Webhook className="text-muted-foreground size-6" />
            <p className="text-muted-foreground mt-2 text-sm">{t('empty')}</p>
            {!canEditSettings && (
              <p className="text-muted-foreground mt-1 text-xs">{t('askAdminHint')}</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {webhooks.map((w) => (
                <li
                  key={w.id}
                  className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`truncate text-sm font-medium ${
                          w.is_active ? 'text-foreground' : 'text-muted-foreground line-through'
                        }`}
                      >
                        {w.name}
                      </span>
                      {!w.is_active && (
                        <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                          {t('disabled')}
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground mt-0.5 text-xs">{stageLabel(w)}</p>
                    <p className="text-muted-foreground mt-1.5 text-xs">
                      {t('created', { date: fmtDate(w.created_at) })}
                      {' · '}
                      {w.last_received_at
                        ? t('lastReceived', { date: fmtDate(w.last_received_at) })
                        : t('neverReceived')}
                    </p>
                  </div>

                  <RequireRole min="admin">
                    <div className="flex items-center gap-3 self-start sm:self-auto">
                      <Switch
                        checked={w.is_active}
                        disabled={busyId === w.id}
                        onCheckedChange={(v) => handleToggle(w, v)}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDelete(w)}
                        disabled={busyId === w.id}
                        className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </RequireRole>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <CreateWebhookDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        pipelines={pipelines}
        stages={stages}
        onCreated={load}
      />
    </section>
  );
}

// ------------------------------------------------------------
// Create dialog — form → one-time URL reveal.
// ------------------------------------------------------------

function CreateWebhookDialog({
  open,
  onOpenChange,
  pipelines,
  stages,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipelines: PipelineOption[];
  stages: StageOption[];
  onCreated: () => void;
}) {
  const t = useTranslations('Settings.webhooks');
  const [name, setName] = useState('');
  const [pipelineId, setPipelineId] = useState('');
  const [stageId, setStageId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  const stagesForPipeline = stages.filter((s) => s.pipeline_id === pipelineId);

  function reset() {
    setName('');
    setPipelineId('');
    setStageId('');
    setSubmitting(false);
    setCreatedUrl(null);
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed || !pipelineId || !stageId) {
      toast.error(t('fieldsRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, pipeline_id: pipelineId, stage_id: stageId }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('createError'));
        return;
      }
      setCreatedUrl(payload.url as string);
      onCreated();
    } catch (err) {
      console.error('[CreateWebhookDialog] create error:', err);
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyUrl() {
    if (!createdUrl) return;
    try {
      await navigator.clipboard.writeText(createdUrl);
      toast.success(t('copySuccess'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="border-border bg-popover sm:max-w-md">
        {createdUrl ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">{t('copyTitle')}</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t('copyDesc')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-1.5">
              <Label className="text-muted-foreground">{t('urlLabel')}</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={createdUrl}
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button type="button" variant="outline" onClick={copyUrl}>
                  <Copy className="size-4" />
                  {t('copy')}
                </Button>
              </div>
            </div>

            <DialogFooter>
              <Button
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                {t('done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">{t('newTitle')}</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t('newDesc')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="webhook-name" className="text-muted-foreground">
                  {t('nameLabel')}
                </Label>
                <Input
                  id="webhook-name"
                  value={name}
                  maxLength={80}
                  placeholder={t('namePlaceholder')}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-muted-foreground">{t('pipelineLabel')}</Label>
                <Select
                  value={pipelineId}
                  onValueChange={(v) => {
                    if (!v) return;
                    setPipelineId(v);
                    setStageId('');
                  }}
                >
                  <SelectTrigger className="w-full border-border bg-muted text-foreground">
                    <SelectValue>
                      {pipelines.find((p) => p.id === pipelineId)?.name ?? t('pipelinePlaceholder')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {pipelines.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-muted-foreground">{t('stageLabel')}</Label>
                <Select
                  value={stageId}
                  disabled={!pipelineId}
                  onValueChange={(v) => v && setStageId(v)}
                >
                  <SelectTrigger className="w-full border-border bg-muted text-foreground">
                    <SelectValue>
                      {stagesForPipeline.find((s) => s.id === stageId)?.name ?? t('stagePlaceholder')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {stagesForPipeline.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">{t('stageHint')}</p>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {t('cancel')}
              </Button>
              <Button onClick={handleCreate} disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('creating')}
                  </>
                ) : (
                  t('createConnection')
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
