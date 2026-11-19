#!/usr/bin/env bun
// Write <dir>/SHA256SUMS for every crewreview-* (CLI) and Crewreview-* (desktop app) file in <dir>. Run after signing:
// signing changes the bytes.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dir = process.argv[2] ?? "dist";
const files = (await readdir(dir)).filter((f) => /^crewreview-/i.test(f) && !f.endsWith(".minisig")).sort();
if (files.length === 0) throw new Error(`no crewreview-* files in ${dir}`);
const lines: string[] = [];
for (const f of files) lines.push(`${createHash("sha256").update(await readFile(join(dir, f))).digest("hex")}  ${f}`);
await writeFile(join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
console.log(`SHA256SUMS: ${files.length} files`);
