#!/usr/bin/env bun
// One version everywhere: the workspace packages and the Claude Code plugin and marketplace. A release bumps them
// together; this catches the one that was forgotten. The Docker image installs the latest published release, so a
// version bumped on main before its tag is out never points it at a release that doesn't exist yet.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const want = JSON.parse(read("package.json")).version as string;
const found: [string, string | undefined][] = [];
for (const p of new Glob("{packages,apps}/*/package.json").scanSync(root)) found.push([p, JSON.parse(read(p)).version]);
found.push(["plugins/crewreview/.claude-plugin/plugin.json", JSON.parse(read("plugins/crewreview/.claude-plugin/plugin.json")).version]);
for (const pl of JSON.parse(read(".claude-plugin/marketplace.json")).plugins as { name: string; version: string }[]) found.push([`.claude-plugin/marketplace.json (${pl.name})`, pl.version]);
const wrong = found.filter(([, v]) => v !== want);
// The Bun types describe the Bun that runs the project: .bun-version, which CI and the release build install.
const bun = read(".bun-version").trim();
const types = JSON.parse(read("package.json")).devDependencies?.["@types/bun"] as string | undefined;
if (types !== bun) {
  console.error(`@types/bun is ${types ?? "missing"} but .bun-version is ${bun}: move them together`);
  process.exit(1);
}
if (wrong.length) {
  console.error(`every version should be ${want} (package.json):\n${wrong.map(([p, v]) => `  ${p}: ${v ?? "missing"}`).join("\n")}`);
  process.exit(1);
}
console.log(`versions ok (${want} in ${found.length + 1} places)`);
