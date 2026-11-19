import { createContext, useContext } from "react";
import { createTranslator, LOCALES, matchLocale, type Locale, type Translator } from "@crewreview/i18n";

const KEY = "crewreview.lang";

export function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && (LOCALES as readonly string[]).includes(saved)) return saved as Locale;
  } catch {}
  return matchLocale(navigator.language) ?? "en";
}

export function saveLocale(l: Locale): void {
  try {
    localStorage.setItem(KEY, l);
  } catch {}
}

export const LANGUAGE_NAMES: Record<Locale, string> = { en: "English", "pt-BR": "Português (Brasil)", es: "Español", de: "Deutsch", "zh-CN": "简体中文" };

export const I18n = createContext<Translator>(createTranslator("en"));
export const useT = () => useContext(I18n);

export function relative(t: Translator, at: number, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(t.locale, { numeric: "auto" });
  const s = Math.round((at - now) / 1000);
  const a = Math.abs(s);
  if (a < 60) return rtf.format(s, "second");
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

export function clock(t: Translator, at: number): string {
  return new Date(at).toLocaleTimeString(t.locale, { hour: "2-digit", minute: "2-digit" });
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export { createTranslator, LOCALES, type Locale, type Translator };
