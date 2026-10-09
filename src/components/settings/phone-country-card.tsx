'use client';

// ============================================================
// PhoneCountryCard — default country of phone numbers that arrive
// WITHOUT a country code (checkout webhooks).
//
// Brazil stays the default. An account outside Brazil picks its own
// country so a bare local number is completed with the right code
// (src/lib/phone/default-country.ts). Writes go straight to
// `accounts.default_phone_country` under the existing admin-only
// `accounts_update` RLS policy, like the default-currency setting.
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DEFAULT_PHONE_COUNTRY, PHONE_COUNTRIES } from '@/lib/phone/default-country';

export function PhoneCountryCard() {
  const t = useTranslations('PhoneCountry');
  const { accountId, canEditSettings } = useAuth();
  const [saved, setSaved] = useState<string | null>(null);
  const [selected, setSelected] = useState(DEFAULT_PHONE_COUNTRY);
  const [saving, setSaving] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await createClient()
        .from('accounts')
        .select('default_phone_country')
        .eq('id', accountId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        // Column not created yet (migration 080 pending): behave as Brazil.
        setUnavailable(true);
        setSaved(DEFAULT_PHONE_COUNTRY);
        return;
      }
      const value =
        (data as { default_phone_country?: string } | null)?.default_phone_country ??
        DEFAULT_PHONE_COUNTRY;
      setSaved(value);
      setSelected(value);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  async function handleSave() {
    if (!accountId || selected === saved) return;
    setSaving(true);
    const { error } = await createClient()
      .from('accounts')
      .update({ default_phone_country: selected })
      .eq('id', accountId);
    setSaving(false);
    if (error) {
      toast.error(t('saveFailed'));
      return;
    }
    setSaved(selected);
    toast.success(t('saveSuccess'));
  }

  if (saved === null) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="text-primary size-5 animate-spin" />
      </div>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center gap-2">
          <Phone className="text-muted-foreground size-4" />
          <h3 className="text-foreground text-sm font-medium">{t('title')}</h3>
        </div>
        <p className="text-muted-foreground text-xs">{t('description')}</p>
        {unavailable && <p className="text-xs text-amber-500">{t('unavailable')}</p>}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 space-y-1.5">
            <Label className="text-xs">{t('label')}</Label>
            <Select
              value={selected}
              onValueChange={(v) => v && setSelected(v)}
              disabled={!canEditSettings || unavailable}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PHONE_COUNTRIES.map((c) => (
                  <SelectItem key={c.iso} value={c.iso}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {canEditSettings && !unavailable && (
            <Button onClick={handleSave} disabled={saving || selected === saved}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : t('save')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
