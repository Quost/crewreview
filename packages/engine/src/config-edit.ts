import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseConfig, parseDuration, type Config } from "./config.ts";

/** The settings the dashboard can change, by their path in config.toml, and what kind of value each holds. */
export const EDITABLE = {
  "schedule.interval": "duration",
  "schedule.offHoursInterval": "duration",
  "schedule.peakHours": "hours",
  "schedule.maxReviewsPerCycle": "count",
  "schedule.keepAwake": "flag",
  "limits.maxConcurrentAgents": "count?",
  "limits.agentTimeout": "duration",
  "limits.stallTimeout": "duration",
  "limits.fullTimeout": "duration",
  "limits.maxDiffLines": "count",
  "limits.dailyRuns": "count?",
  "review.settle": "duration",
  "review.ciMaxWait": "duration",
  "review.policy.allowApprove": "flag",
  "attend.quiet": "duration",
  "attend.maxPerCycle": "count",
  "harness.default": "name",
  "harness.verifier": "name?",
  "updates.check": "flag",
} as const;

export type EditableKey = keyof typeof EDITABLE;

/** A value as the dashboard sends it, as TOML text; undefined removes the key (back to the default). */
export function tomlFor(key: EditableKey, value: unknown): string | undefined {
  const kind = EDITABLE[key];
  if (value === null || value === "") {
    if (kind.endsWith("?")) return undefined;
    throw new Error(`${key} needs a value`);
  }
  switch (kind.replace("?", "")) {
    case "duration": {
      const text = String(value).trim();
      parseDuration(text);
      return JSON.stringify(text);
    }
    case "count": {
      const n = typeof value === "number" ? value : Number(String(value).trim());
      if (!Number.isInteger(n) || n < 1) throw new Error(`${key}: a whole number from 1`);
      return String(n);
    }
    case "flag":
      if (typeof value !== "boolean") throw new Error(`${key}: on or off`);
      return String(value);
    case "hours":
    case "name":
      return JSON.stringify(String(value).trim());
  }
  throw new Error(`can't edit ${key}`);
}

const HEADER = /^\s*\[([^\]]+)\]\s*(#.*)?$/;
const keyLine = (name: string) => new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);

/**
 * Set or remove one key in TOML text, touching only its line: comments, order and everything else stay as written.
 * `a.b.c` is key `c` in table `[a.b]`; a missing table is added at the end.
 */
export function patchToml(text: string, key: string, value: string | undefined): string {
  const parts = key.split(".");
  const name = parts.pop()!;
  const table = parts.join(".");
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  // The table's lines: from its header to the next header.
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const h = HEADER.exec(lines[i]!)?.[1]?.trim();
    if (h === undefined) continue;
    if (start !== -1) {
      end = i;
      break;
    }
    if (h === table) start = i;
  }
  if (start === -1) {
    if (value === undefined) return text;
    const block = [`[${table}]`, `${name} = ${value}`];
    return [...lines, ...(lines.length && lines.at(-1) !== "" ? [""] : []), ...block].join("\n") + "\n";
  }
  const at = lines.slice(start + 1, end).findIndex((l) => keyLine(name).test(l));
  if (at === -1) {
    if (value === undefined) return text;
    // After the table's last key, before its trailing blank lines.
    let insert = end;
    while (insert > start + 1 && lines[insert - 1]!.trim() === "") insert--;
    lines.splice(insert, 0, `${name} = ${value}`);
  } else if (value === undefined) {
    lines.splice(start + 1 + at, 1);
  } else {
    const line = lines[start + 1 + at]!;
    const comment = /\s+#[^"']*$/.exec(line.slice(line.indexOf("=") + 1))?.[0] ?? "";
    lines[start + 1 + at] = `${line.slice(0, line.indexOf("=") + 1)} ${value}${comment}`;
  }
  return lines.join("\n") + "\n";
}

const get = (o: unknown, path: string) => path.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);

/**
 * Change settings in config.toml and return the config they make. Every key must be editable; the result is parsed
 * again and must hold exactly the asked values, or nothing is written (say, a key defined some way this can't edit).
 */
export async function editConfig(path: string, patch: Record<string, unknown>): Promise<{ config: Config } | { error: string; key?: string }> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { error: (e as Error).message };
  }
  const wanted: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in EDITABLE)) return { error: `not a setting the dashboard can change: ${key}`, key };
    try {
      wanted[key] = tomlFor(key as EditableKey, value);
      text = patchToml(text, key, wanted[key]);
    } catch (e) {
      return { error: (e as Error).message, key };
    }
  }
  let raw: unknown;
  let config: Config;
  try {
    raw = Bun.TOML.parse(text);
    config = parseConfig(raw, path);
  } catch (e) {
    return { error: (e as Error).message };
  }
  for (const [key, toml] of Object.entries(wanted)) {
    const now = get(raw, key);
    const expected = toml === undefined ? undefined : (Bun.TOML.parse(`v = ${toml}`) as { v: unknown }).v;
    if (JSON.stringify(now) !== JSON.stringify(expected)) return { error: `couldn't change ${key} in ${path}: edit it by hand`, key };
  }
  if (!text.startsWith("#")) text = `# Crewreview settings. The dashboard changes single lines here; edit by hand as you like.\n\n${text}`;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
  return { config };
}
