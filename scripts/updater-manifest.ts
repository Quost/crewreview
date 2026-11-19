#!/usr/bin/env bun
// Write <dir>/latest.json, which the desktop app's updater reads, from the signed update packages in <dir>.
//   bun scripts/updater-manifest.ts <version> <dir> [notes-file]
// Sign each package first (bun scripts/release-key.ts sign <file>): its <file>.minisig must sit next to it.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DESKTOP_UPDATE_PACKAGES, desktopManifest } from "../packages/engine/src/update.ts";

const [version, dir = "dist", notesFile] = process.argv.slice(2);
if (!version) {
  console.error("usage: bun scripts/updater-manifest.ts <version> <dir> [notes-file]");
  process.exit(2);
}
const signatures: Record<string, string> = {};
for (const file of Object.values(DESKTOP_UPDATE_PACKAGES)) {
  const minisig = await readFile(join(dir, `${file}.minisig`), "utf8").catch(() => undefined);
  if (minisig) signatures[file] = minisig;
}
const notes = notesFile ? (await readFile(notesFile, "utf8")).trim() : "";
await writeFile(join(dir, "latest.json"), `${JSON.stringify(desktopManifest(version, signatures, notes, new Date()), null, 2)}\n`);
console.log(`latest.json: ${Object.keys(signatures).length} platforms, version ${version}`);
