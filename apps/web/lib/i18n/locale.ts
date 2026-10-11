export const LOCALES = ["en", "it"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_KEY = "intentguard:locale";
export const COOKIE_LOCALE = "intentguard-locale";

export function isLocale(value: string | null | undefined): value is Locale {
  return value === "en" || value === "it";
}

/** First tag of `navigator.language` or `Accept-Language` → IT if `it`, else EN. */
export function localeFromNavigator(lang = ""): Locale {
  const first = lang.trim().toLowerCase().split(",")[0]?.split(";")[0]?.trim() ?? "";
  return first === "it" || first.startsWith("it-") ? "it" : "en";
}

function cookieLocale(): Locale | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(/(?:^|; )intentguard-locale=(en|it)/);
  return match ? (match[1] as Locale) : undefined;
}

export function detectLocale(): Locale {
  if (typeof window === "undefined") return "en";
  try {
    const saved = window.localStorage.getItem(LOCALE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    /* private mode */
  }
  const fromCookie = cookieLocale();
  if (fromCookie) return fromCookie;
  const nav = window.navigator.languages?.[0] || window.navigator.language || "en";
  return localeFromNavigator(nav);
}

export function persistLocale(locale: Locale) {
  try {
    window.localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    /* ignore */
  }
  try {
    document.cookie = `${COOKIE_LOCALE}=${locale}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    /* ignore */
  }
}
