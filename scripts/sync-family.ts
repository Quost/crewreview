#!/usr/bin/env bun
// Refresh site/family.json, the list of Pururucos products the site shows above its footer, and the images it
// names (into site/static/family/). Run it by hand when that list changes; the site build only reads the copy, so
// it stays offline and gives the same pages every time.
//
//   bun scripts/sync-family.ts                 # from https://pururucos.com.br/products.json
//   bun scripts/sync-family.ts ./products.json # from a local file (the images still come from their URLs)
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { familyImage, SELF, type Family } from "./lib/family.ts";

const ROOT = join(import.meta.dir, "..");
const SOURCE = process.argv[2] ?? "https://pururucos.com.br/products.json";

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { "user-agent": "crewreview-sync-family" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

const raw = /^https?:\/\//.test(SOURCE) ? await (await fetchOk(SOURCE)).text() : await readFile(SOURCE, "utf8");
const family = JSON.parse(raw) as Family;
if (!family.maker?.url || !Array.isArray(family.products)) throw new Error(`${SOURCE}: not a products.json`);

// This site's own entry isn't shown, so its icon isn't needed.
const images = [family.maker.logo, ...family.products.filter((p) => p.id !== SELF).map((p) => p.icon)];
const dir = join(ROOT, "site", "static", "family");
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
for (const url of images) {
  const name = familyImage(url).slice("/family/".length);
  const res = await fetchOk(url);
  const type = res.headers.get("content-type") ?? "";
  if (!/^image\/(webp|png|jpeg|svg\+xml)/.test(type)) throw new Error(`${url}: not an image (${type})`);
  await writeFile(join(dir, name), new Uint8Array(await res.arrayBuffer()));
  console.log(`  ${url} -> site/static/family/${name}`);
}

await writeFile(join(ROOT, "site", "family.json"), JSON.stringify(family, null, 2) + "\n");
console.log(`site/family.json: ${family.products.length} products`);
