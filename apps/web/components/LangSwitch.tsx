"use client";

import { LOCALES, type Locale } from "@/lib/i18n";
import { useI18n } from "./I18nProvider";

export function LangSwitch() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className="inline-flex rounded-lg border border-white/15 p-0.5" role="group" aria-label={t("nav.language")}>
      {LOCALES.map((code) => (
        <LangButton key={code} code={code} active={locale === code} label={t(`nav.${code}`)} onSelect={setLocale} />
      ))}
    </div>
  );
}

function LangButton({
  code,
  active,
  label,
  onSelect,
}: {
  code: Locale;
  active: boolean;
  label: string;
  onSelect: (locale: Locale) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(code)}
      aria-pressed={active}
      aria-label={label}
      className={`rounded-md px-2.5 py-1 text-xs font-medium uppercase focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 ${
        active ? "bg-emerald-500 text-black" : "text-gray-300 hover:bg-white/10 hover:text-white"
      }`}
    >
      {code}
    </button>
  );
}
