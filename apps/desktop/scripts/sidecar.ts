#!/usr/bin/env bun
// Puts the crewreview CLI inside the desktop app as a Tauri sidecar: src-tauri/binaries/crewreview-<target triple>.
//   bun scripts/sidecar.ts                     compile it from source for this machine
//   bun scripts/sidecar.ts --target <triple>   for another target (Bun cross-compiles)
//   bun scripts/sidecar.ts --from <binary>     copy a binary built elsewhere (the release workflow does this)
//   bun scripts/sidecar.ts --if-missing        do nothing when it's already there (Tauri's before-build hook)
import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** Rust target triple → Bun compile target. */
export const TRIPLES: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
};

function hostTriple(): string {
  const os = process.platform === "darwin" ? "apple-darwin" : process.platform === "win32" ? "pc-windows-msvc" : "unknown-linux-gnu";
  return `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${os}`;
}

const { values: v } = parseArgs({
  options: { target: { type: "string" }, from: { type: "string" }, "if-missing": { type: "boolean", default: false } },
});
const target = v.target ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple();
const bunTarget = TRIPLES[target];
if (!bunTarget) {
  console.error(`no Crewreview build for ${target}; supported: ${Object.keys(TRIPLES).join(", ")}`);
  process.exit(1);
}
const root = join(import.meta.dir, "..", "..", "..");
const dir = join(import.meta.dir, "..", "src-tauri", "binaries");
const out = join(dir, `crewreview-${target}${target.includes("windows") ? ".exe" : ""}`);

if (v["if-missing"] && (await stat(out).catch(() => undefined))) process.exit(0);
await mkdir(dir, { recursive: true });
if (v.from) {
  await copyFile(v.from, out);
} else {
  const proc = Bun.spawn(["bun", "build", join(root, "apps/cli/src/main.ts"), "--compile", "--minify", `--target=${bunTarget}`, `--outfile=${out}`], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0) process.exit(1);
}
if (!target.includes("windows")) await chmod(out, 0o755);
console.log(`sidecar ready: ${out}`);
