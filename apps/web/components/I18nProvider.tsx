"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  detectLocale,
  messages,
  persistLocale,
  translate,
  type Locale,
} from "@/lib/i18n";

type Vars = Record<string, string | number>;

type I18n = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (path: string, vars?: Vars) => string;
};

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children, initialLocale = "en" }: { children: ReactNode; initialLocale?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    const stored = detectLocale();
    if (stored !== initialLocale) {
      setLocaleState(stored);
      persistLocale(stored);
    }
  }, [initialLocale]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    persistLocale(next);
  }, []);

  const value = useMemo<I18n>(
    () => ({
      locale,
      setLocale,
      t: (path, vars) => translate(messages[locale], path, vars),
    }),
    [locale, setLocale],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}
