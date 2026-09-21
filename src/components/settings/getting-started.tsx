'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, ChevronRight, PlugZap, Bot, CalendarDays, Coins, UsersRound } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { SettingsPanelHead } from './settings-panel-head';
import type { SettingsSection } from './settings-sections';

interface StepStatus {
  whatsapp: boolean | null;
  ai: boolean | null;
  calendar: boolean | null;
}

/**
 * Static, text-based walkthrough for the handful of things a brand-new
 * account has to set up ITSELF before FuseHub is fully usable — none
 * of this needs Fuse's involvement, which is the point: a customer of
 * the sellable product should never need to wait on us for day-one
 * setup. Each step links an external provider (UAZAPI, Anthropic/
 * OpenAI, Google) the account brings its own credentials from, plus a
 * jump straight to the FuseHub settings screen that step configures.
 *
 * Status per step is read from the same endpoints/tables the Overview
 * tiles already use — this page doesn't duplicate that logic, just
 * surfaces it next to the instructions.
 */
export function GettingStarted({
  onSelect,
}: {
  onSelect: (section: SettingsSection) => void;
}) {
  const { accountId, canEditSettings, canManageMembers } = useAuth();
  const t = useTranslations('Settings.gettingStarted');
  const router = useRouter();

  const [status, setStatus] = useState<StepStatus>({ whatsapp: null, ai: null, calendar: null });

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const supabase = createClient();

    (async () => {
      const [whatsappRes, aiRes, calendarRes] = await Promise.allSettled([
        supabase.from('whatsapp_config').select('status').eq('account_id', accountId),
        fetch('/api/ai/config', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/calendar/google', { cache: 'no-store' }).then((r) => r.json()),
      ]);
      if (cancelled) return;
      setStatus({
        whatsapp:
          whatsappRes.status === 'fulfilled' &&
          !whatsappRes.value.error &&
          (whatsappRes.value.data?.length ?? 0) > 0,
        ai: aiRes.status === 'fulfilled' ? !!aiRes.value?.has_key : null,
        calendar: calendarRes.status === 'fulfilled' ? !!calendarRes.value?.connected : null,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // The AI Agent's setup lives on the dedicated /agents page (its
  // "Setup" tab), NOT under Settings — it's a separate top-level nav
  // item, so its action navigates there directly instead of going
  // through the `onSelect` Settings-section switcher the other two use.
  const steps: {
    key: 'whatsapp' | 'ai' | 'calendar';
    icon: typeof PlugZap;
    required: boolean;
    done: boolean | null;
    onAction: () => void;
  }[] = [
    {
      key: 'whatsapp',
      icon: PlugZap,
      required: true,
      done: status.whatsapp,
      onAction: () => onSelect('whatsapp'),
    },
    {
      key: 'ai',
      icon: Bot,
      required: false,
      done: status.ai,
      onAction: () => router.push('/agents'),
    },
    {
      key: 'calendar',
      icon: CalendarDays,
      required: false,
      done: status.calendar,
      onAction: () => onSelect('calendar'),
    },
  ];

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200 space-y-6">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {steps.map((step) => (
        <StepCard
          key={step.key}
          icon={step.icon}
          title={t(`${step.key}.title`)}
          badge={step.required ? t('requiredBadge') : t('optionalBadge')}
          done={step.done}
          instructions={t.raw(`${step.key}.steps`) as string[]}
          actionLabel={t(`${step.key}.actionLabel`)}
          onAction={step.onAction}
          disabled={!canEditSettings}
        />
      ))}

      <div className="border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-foreground">{t('alsoWorthTitle')}</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <ExtraTile
            icon={Coins}
            title={t('deals.title')}
            desc={t('deals.desc')}
            onClick={() => onSelect('deals')}
          />
          {canManageMembers && (
            <ExtraTile
              icon={UsersRound}
              title={t('members.title')}
              desc={t('members.desc')}
              onClick={() => onSelect('members')}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function StepCard({
  icon: Icon,
  title,
  badge,
  done,
  instructions,
  actionLabel,
  onAction,
  disabled,
}: {
  icon: typeof PlugZap;
  title: string;
  badge: string;
  done: boolean | null;
  instructions: string[];
  actionLabel: string;
  onAction: () => void;
  disabled: boolean;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start gap-3.5">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg',
            done ? 'bg-primary/15 text-primary' : 'bg-primary-soft text-primary',
          )}
        >
          {done ? <Check className="size-4" /> : <Icon className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                done
                  ? 'bg-primary/15 text-primary'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {badge}
            </span>
          </div>
          <ol className="mt-3 space-y-1.5 text-sm text-muted-foreground">
            {instructions.map((line, i) => (
              <li key={i} className="flex gap-2">
                <span className="shrink-0 text-muted-foreground/70">{i + 1}.</span>
                <span>{line}</span>
              </li>
            ))}
          </ol>
          <button
            type="button"
            onClick={onAction}
            disabled={disabled}
            className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            {actionLabel}
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>
    </Card>
  );
}

function ExtraTile({
  icon: Icon,
  title,
  desc,
  onClick,
}: {
  icon: typeof PlugZap;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary-soft-2 hover:bg-card-2"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{desc}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
