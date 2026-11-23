import { existsSync } from "node:fs";
import { lstat, readlink, rename, rm, symlink } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve, dirname } from "node:path";
import { shouldLinkCommand, type CommandOnPath } from "@crewreview/core";
import { runProcess, scrubEnv } from "@crewreview/harness";

/** The first `crewreview` on this PATH, and what it is. */
export async function findCommand(path: string | undefined, name = "crewreview"): Promise<{ at?: string; found: CommandOnPath }> {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const at = join(dir, name);
    const st = await lstat(at).catch(() => undefined);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      const raw = await readlink(at);
      const target = resolve(dirname(at), raw);
      return { at, found: { kind: "link", target, exists: existsSync(target) } };
    }
    if (!st.isFile()) continue;
    return { at, found: { kind: "file", version: await crewreviewVersion(at) } };
  }
  return { found: { kind: "missing" } };
}

/** The version a Crewreview binary reports, or undefined when it isn't one (or doesn't answer). */
async function crewreviewVersion(bin: string): Promise<string | undefined> {
  const r = await runProcess({ argv: [bin, "--version"], cwd: dirname(bin), env: scrubEnv(process.env), timeoutMs: 10_000 }).catch(() => undefined);
  const v = r?.exitCode === 0 ? r.stdout.trim() : "";
  return /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v) ? v : undefined;
}

/**
 * Point the terminal's `crewreview` at this one (the desktop app's), so the app's updates reach the terminal too.
 * Only replaces what `shouldLinkCommand` allows, in one step: the new link takes the old file's place, never a moment
 * without either. Returns where and what it replaced, or undefined when nothing changed.
 */
export async function linkTerminalCommand(self: string, path: string | undefined): Promise<{ at: string; was?: string } | undefined> {
  const { at, found } = await findCommand(path);
  if (!at || !shouldLinkCommand(found, self)) return undefined;
  const tmp = `${at}.crewreview-link`;
  await rm(tmp, { force: true });
  await symlink(self, tmp);
  try {
    await rename(tmp, at);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return { at, was: found.kind === "file" ? found.version : undefined };
}
