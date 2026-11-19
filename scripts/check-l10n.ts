#!/usr/bin/env bun
// Every locale must have exactly the English keys, the same {placeholders}, and no empty strings.
// Plural keys: "<key>.other" is required everywhere; "<key>.one" only where the language uses it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "packages", "i18n", "locales");
const load = (f: string): Record<string, string> => {
  const text = readFileSync(join(dir, f), "utf8");
  const seen = new Set<string>();
  for (const m of text.matchAll(/^\s*"([^"]+)"\s*:/gm)) {
    if (seen.has(m[1]!)) throw new Error(`${f}: duplicate key ${m[1]}`);
    seen.add(m[1]!);
  }
  return JSON.parse(text);
};
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const base = (k: string) => k.replace(/\.(zero|one|two|few|many|other)$/, "");

const en = load("en.json");
const errors: string[] = [];
const enBases = new Set(Object.keys(en).map(base));

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "en.json")) {
  const cat = load(file);
  const keys = new Set(Object.keys(cat));
  for (const k of Object.keys(en)) {
    const plural = k !== base(k);
    if (plural && !k.endsWith(".other")) continue; // .one etc. are per language
    if (!keys.has(k)) errors.push(`${file}: missing ${k}`);
  }
  for (const k of keys) {
    if (!enBases.has(base(k))) errors.push(`${file}: unknown key ${k}`);
    const value = cat[k]!;
    if (value.trim() === "") errors.push(`${file}: empty ${k}`);
    const ref = en[k] ?? en[`${base(k)}.other`];
    if (ref !== undefined && placeholders(ref) !== placeholders(value)) {
      errors.push(`${file}: placeholders of ${k} differ ({${placeholders(value)}} vs {${placeholders(ref)}})`);
    }
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`translations ok (${Object.keys(en).length} keys)`);
