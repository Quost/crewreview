#!/usr/bin/env bun
// Compile the CLI into single-file binaries. `--all` builds every release target from this one machine.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../package.json";

const TARGETS = [
  { target: "bun-darwin-arm64", file: "crewreview-darwin-arm64" },
  { target: "bun-darwin-x64", file: "crewreview-darwin-x64" },
  { target: "bun-linux-x64", file: "crewreview-linux-x64" },
  { target: "bun-linux-arm64", file: "crewreview-linux-arm64" },
  { target: "bun-windows-x64", file: "crewreview-windows-x64.exe" },
] as const;

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const all = process.argv.includes("--all");
const host = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const chosen = all ? TARGETS : TARGETS.filter((t) => t.target === host);
if (chosen.length === 0) {
  console.error(`no release target for ${host}`);
  process.exit(1);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const sums: string[] = [];
for (const t of chosen) {
  const out = join(dist, t.file);
  const proc = Bun.spawn(
    ["bun", "build", join(root, "apps/cli/src/main.ts"), "--compile", "--minify", `--target=${t.target}`, `--outfile=${out}`],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if ((await proc.exited) !== 0) process.exit(1);
  const hash = createHash("sha256").update(await readFile(out)).digest("hex");
  sums.push(`${hash}  ${t.file}`);
}
await writeFile(join(dist, "SHA256SUMS"), sums.join("\n") + "\n");
console.log(`built ${chosen.length} binaries for crewreview ${pkg.version} in dist/`);
