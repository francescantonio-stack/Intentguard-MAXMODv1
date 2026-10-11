import { en, type Messages } from "./en";
import { it } from "./it";
import type { Locale } from "./locale";

export type { Messages };
export { en, it };
export {
  COOKIE_LOCALE,
  detectLocale,
  isLocale,
  localeFromNavigator,
  LOCALES,
  LOCALE_KEY,
  persistLocale,
  type Locale,
} from "./locale";

export type InfoKey = keyof Messages["info"]["items"];

export const messages: Record<Locale, Messages> = { en, it };

type Vars = Record<string, string | number>;

/** Resolve a dotted path in the dictionary and replace `{name}` placeholders. */
export function translate(dict: Messages, path: string, vars?: Vars): string {
  const parts = path.split(".");
  let cur: unknown = dict;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object" || !(part in cur)) return path;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur !== "string") return path;
  if (!vars) return cur;
  return cur.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ""));
}
