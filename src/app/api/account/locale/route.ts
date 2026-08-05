import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { LOCALE_COOKIE, isSupportedLocale } from '@/i18n/locales';

/**
 * POST /api/account/locale
 *
 * Sets the `NEXT_LOCALE` cookie read by `src/i18n/request.ts` on every
 * request. No auth check needed beyond "you can set a cookie for your
 * own browser" — this only changes which JSON dictionary renders the
 * UI, not any account data. `router.refresh()` on the client re-fetches
 * the RSC tree so the switch is visible immediately, no full reload.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const locale = body?.locale;

  if (!isSupportedLocale(locale)) {
    return NextResponse.json({ error: 'Unsupported locale' }, { status: 400 });
  }

  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });

  return NextResponse.json({ success: true, locale });
}
