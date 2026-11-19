import de from "../locales/de.json";
import en from "../locales/en.json";
import es from "../locales/es.json";
import ptBR from "../locales/pt-BR.json";
import zhCN from "../locales/zh-CN.json";

export const LOCALES = ["en", "pt-BR", "es", "de", "zh-CN"] as const;
export type Locale = (typeof LOCALES)[number];

type Catalog = Record<string, string>;
const CATALOGS: Record<Locale, Catalog> = { en, "pt-BR": ptBR, es, de, "zh-CN": zhCN };

/** Every key of the English catalog, with plural suffixes folded into their base key. */
type RawKey = keyof typeof en;
type PluralBase<K> = K extends `${infer B}.other` ? B : never;
export type MessageKey = Exclude<RawKey, `${string}.one` | `${string}.other`>;
export type PluralKey = PluralBase<RawKey>;

export type Vars = Record<string, string | number>;

function fill(template: string, vars: Vars = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** Map anything like "pt_BR.UTF-8", "pt", "zh-Hans" or "de-AT" to a supported locale. */
export function matchLocale(raw: string | undefined): Locale | undefined {
  if (!raw) return undefined;
  const tag = raw.split(".")[0]!.replace("_", "-").toLowerCase();
  if (tag === "" || tag === "c" || tag === "posix") return undefined;
  const lang = tag.split("-")[0];
  if (lang === "pt") return "pt-BR";
  if (lang === "zh") return "zh-CN";
  if (lang === "es") return "es";
  if (lang === "de") return "de";
  if (lang === "en") return "en";
  return undefined;
}

export function detectLocale(preferred?: string, env: Record<string, string | undefined> = process.env): Locale {
  return (
    matchLocale(preferred) ??
    matchLocale(env.CREWREVIEW_LANG) ??
    matchLocale(env.LC_ALL) ??
    matchLocale(env.LC_MESSAGES) ??
    matchLocale(env.LANG) ??
    matchLocale(Intl.DateTimeFormat().resolvedOptions().locale) ??
    "en"
  );
}

export interface Translator {
  locale: Locale;
  t(key: MessageKey, vars?: Vars): string;
  tp(key: PluralKey, count: number, vars?: Vars): string;
}

export function createTranslator(locale: Locale): Translator {
  const cat = CATALOGS[locale];
  const plural = new Intl.PluralRules(locale);
  const get = (key: string): string => cat[key] ?? (en as Catalog)[key] ?? key;
  return {
    locale,
    t: (key, vars) => fill(get(key), vars),
    tp: (key, count, vars) => {
      const rule = plural.select(count);
      const k = `${key}.${rule}` in cat ? `${key}.${rule}` : `${key}.other`;
      return fill(get(k), { count, ...vars });
    },
  };
}

/** English name of a language code, for telling an agent which language to write in. */
export function languageName(code: string): string {
  const names: Record<string, string> = {
    en: "English",
    "pt-BR": "Brazilian Portuguese",
    pt: "Portuguese",
    "pt-PT": "European Portuguese",
    es: "Spanish",
    de: "German",
    fr: "French",
    it: "Italian",
    ja: "Japanese",
    ko: "Korean",
    "zh-CN": "Simplified Chinese",
    zh: "Simplified Chinese",
    "zh-TW": "Traditional Chinese",
  };
  return names[code] ?? names[code.split("-")[0] ?? ""] ?? code;
}

export const catalogs = CATALOGS;
