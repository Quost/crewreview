#!/usr/bin/env bun
// The changelog becomes the release notes: it must start with "## Unreleased" or a version, and every version
// heading must be unique and in descending order.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const text = readFileSync(join(import.meta.dir, "..", "CHANGELOG.md"), "utf8");
const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim());
const errors: string[] = [];
if (headings.length === 0) errors.push("CHANGELOG.md has no sections");
const versions = headings.filter((h) => h !== "Unreleased").map((h) => h.split(" ")[0]!);
if (headings.slice(1).includes("Unreleased")) errors.push('"## Unreleased" must be the first section');
const cmp = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)));
  const pb = b.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    if (pa[i] === undefined) return 1;
    if (pb[i] === undefined) return -1;
    return pa[i]! > pb[i]! ? 1 : -1;
  }
  return 0;
};
for (const v of versions) if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(v)) errors.push(`not a version: ${v}`);
if (new Set(versions).size !== versions.length) errors.push("a version appears twice");
for (let i = 1; i < versions.length; i++) if (cmp(versions[i - 1]!, versions[i]!) <= 0) errors.push(`${versions[i - 1]} should come after ${versions[i]}`);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`changelog ok (${versions.length} releases)`);
