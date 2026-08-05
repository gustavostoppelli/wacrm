/**
 * Locale constants shared between server-only code (`request.ts`, which
 * reads `next/headers` cookies()) and client components (the language
 * picker in `appearance-panel.tsx`). Kept in its own file with zero
 * server-only imports — a client component importing anything from
 * `request.ts` directly would pull `next/headers` into the browser
 * bundle and fail to build.
 */

/**
 * Locales with a full translation file in `messages/`. Keep in sync
 * with `messages/*.json` and `src/i18n/messages.test.ts`'s
 * `TRANSLATED_LOCALES` — a locale missing here is unreachable from the
 * Settings → Appearance language picker even if the JSON file exists.
 */
export const SUPPORTED_LOCALES = ['en', 'pt', 'ko'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_COOKIE = 'NEXT_LOCALE';

export function isSupportedLocale(value: string | undefined): value is SupportedLocale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
