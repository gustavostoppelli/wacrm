import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { LOCALE_COOKIE, isSupportedLocale } from './locales';

export default getRequestConfig(async () => {
  // Per-user override (Settings → Appearance → Language) takes priority
  // over the deployment-wide default — set via POST /api/account/locale,
  // read here on every request so the switch is instant, no rebuild.
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;

  const envDefault = process.env.NEXT_PUBLIC_APP_LOCALE || 'en';
  const locale = isSupportedLocale(cookieLocale) ? cookieLocale : envDefault;

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch (error) {
    // Fallback to English if the dictionary for the requested locale doesn't exist yet
    messages = (await import(`../../messages/en.json`)).default;
  }

  return {
    locale,
    messages
  };
});
