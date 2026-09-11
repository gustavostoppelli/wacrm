"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Bell, Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useTranslations } from "next-intl";
import { SettingsPanelHead } from "./settings-panel-head";

const NO_GROUP = "none";

interface UazapiGroupOption {
  jid: string;
  name: string;
}

/**
 * Account-wide notification settings — currently just the daily
 * WhatsApp activity digest (migration 065). Sent once a day, around
 * 18:00 America/Sao_Paulo, by the cron poller (drainDailyDigest in
 * src/app/api/automations/cron/route.ts) to every phone listed here,
 * plus one optional WhatsApp group. Mirrors DealsSettings' shape:
 * reads/writes straight to `accounts`, admin-gated the same way
 * (accounts_update RLS restricts writes to admin+, so non-admins get
 * a disabled, read-only view).
 */
export function NotificationsSettings() {
  const supabase = createClient();
  const { accountId, canEditSettings } = useAuth();
  const t = useTranslations("Settings.notifications");

  const [enabled, setEnabled] = useState(false);
  const [phones, setPhones] = useState("");
  const [groupJid, setGroupJid] = useState<string>(NO_GROUP);
  const [groups, setGroups] = useState<UazapiGroupOption[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("accounts")
        .select("daily_digest_enabled, daily_digest_phones, daily_digest_group_jid")
        .eq("id", accountId)
        .maybeSingle();
      if (cancelled || !data) return;
      setEnabled(!!data.daily_digest_enabled);
      setPhones(data.daily_digest_phones ?? "");
      setGroupJid(data.daily_digest_group_jid ?? NO_GROUP);
      setDirty(false);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, supabase]);

  const fetchGroups = useCallback(async () => {
    if (!canEditSettings) {
      setGroupsLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/uazapi/groups");
      const data = await res.json();
      if (res.ok) setGroups(data.groups ?? []);
    } catch {
      // Non-fatal — the group picker just shows no options.
    } finally {
      setGroupsLoading(false);
    }
  }, [canEditSettings]);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  async function handleSave() {
    if (!accountId) return;
    setSaving(true);
    const { error } = await supabase
      .from("accounts")
      .update({
        daily_digest_enabled: enabled,
        daily_digest_phones: phones.trim() || null,
        daily_digest_group_jid: groupJid === NO_GROUP ? null : groupJid,
      })
      .eq("id", accountId);
    setSaving(false);
    if (error) {
      toast.error(t("saveFailed"));
      return;
    }
    setDirty(false);
    toast.success(t("saveSuccess"));
  }

  // The saved group might not be in the freshly-fetched list (e.g. the
  // connected number left it) — still show something instead of
  // silently reverting to "None" and losing the saved value on next save.
  const groupOptions =
    groupJid !== NO_GROUP && !groups.some((g) => g.jid === groupJid)
      ? [{ jid: groupJid, name: groupJid }, ...groups]
      : groups;

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Bell className="size-4 text-primary" />
            {t("dailyDigestTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("dailyDigestDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/50 p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t("enableLabel")}</p>
              <p className="text-xs text-muted-foreground">{t("enableHint")}</p>
            </div>
            <Switch
              checked={enabled}
              disabled={!canEditSettings || loading}
              onCheckedChange={(v) => {
                setEnabled(v);
                setDirty(true);
              }}
            />
          </div>

          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("phonesLabel")}</Label>
            <Textarea
              value={phones}
              onChange={(e) => {
                setPhones(e.target.value);
                setDirty(true);
              }}
              placeholder={t("phonesPlaceholder")}
              disabled={!canEditSettings || loading}
              rows={2}
              className="border-border bg-muted text-sm text-foreground"
            />
            <p className="text-xs text-muted-foreground">{t("phonesHint")}</p>
          </div>

          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("groupLabel")}</Label>
            <Select
              value={groupJid}
              disabled={!canEditSettings || loading || groupsLoading}
              onValueChange={(v) => {
                if (!v) return;
                setGroupJid(v);
                setDirty(true);
              }}
            >
              <SelectTrigger className="w-full border-border bg-muted text-foreground">
                <SelectValue>
                  {groupJid === NO_GROUP
                    ? t("groupNone")
                    : groupOptions.find((g) => g.jid === groupJid)?.name ?? groupJid}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_GROUP}>{t("groupNone")}</SelectItem>
                {groupOptions.map((g) => (
                  <SelectItem key={g.jid} value={g.jid}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {groupsLoading ? t("groupLoading") : t("groupHint")}
            </p>
          </div>

          {!canEditSettings && (
            <p className="text-xs text-muted-foreground">{t("adminOnlyHint")}</p>
          )}

          {canEditSettings && (
            <Button
              onClick={handleSave}
              disabled={saving || loading || !dirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
