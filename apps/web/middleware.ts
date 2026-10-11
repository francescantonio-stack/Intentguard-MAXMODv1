import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_LOCALE, localeFromNavigator, type Locale } from "@/lib/i18n/locale";

function fromRequest(req: NextRequest): Locale {
  const cookie = req.cookies.get(COOKIE_LOCALE)?.value;
  if (cookie === "en" || cookie === "it") return cookie;
  return localeFromNavigator(req.headers.get("accept-language") ?? "en");
}

export function middleware(req: NextRequest) {
  const locale = fromRequest(req);
  const headers = new Headers(req.headers);
  headers.set("x-intentguard-locale", locale);
  const res = NextResponse.next({ request: { headers } });
  if (!req.cookies.get(COOKIE_LOCALE)) {
    res.cookies.set(COOKIE_LOCALE, locale, { path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  }
  return res;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|sw\\.js|icon-|.*\\..*).*)"],
};
