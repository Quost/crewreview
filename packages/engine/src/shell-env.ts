import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * An app opened from the Dock, Finder or a desktop launcher gets a bare PATH (/usr/bin:/bin:…), not your terminal's,
 * so the agents' CLIs and gh aren't found. This asks your login shell, once, for PATH and the same few variables the
 * background service keeps, never tokens, and adds the usual install folders in case the shell can't answer.
 */
export const SHELL_KEEP = ["PATH", "LANG", "CREWREVIEW_HOME", "CREWREVIEW_LANG", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;

const MARK = "__crewreview_env__";

/** Where CLIs usually live when the shell doesn't say: Homebrew, ~/.local/bin (Claude Code), Bun, Cargo, npm. */
export function usualBinDirs(home: string = homedir()): string[] {
  return ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", join(home, ".local", "bin"), join(home, ".bun", "bin"), join(home, ".cargo", "bin"), join(home, ".npm-global", "bin"), join(home, ".volta", "bin")];
}

/** Parse what the shell printed after the marker: NUL-separated NAME=value pairs. Noise from rc files comes before. */
export function parseShellOutput(out: string): Record<string, string> {
  const at = out.lastIndexOf(`${MARK}\0`);
  if (at === -1) return {};
  const vars: Record<string, string> = {};
  for (const pair of out.slice(at + MARK.length + 1).split("\0")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const [name, value] = [pair.slice(0, eq), pair.slice(eq + 1)];
    if ((SHELL_KEEP as readonly string[]).includes(name) && value) vars[name] = value;
  }
  return vars;
}

/** PATH entries in order, without repeats or empties. */
export function mergePath(...parts: (string | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) for (const dir of (part ?? "").split(":")) if (dir && !seen.has(dir)) (seen.add(dir), out.push(dir));
  return out.join(":");
}

export interface ShellEnvOptions {
  shell?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  timeoutMs?: number;
  exists?: (dir: string) => boolean;
}

/**
 * The variables to add to this process: PATH from the login shell, then the current PATH, then the usual folders
 * that exist; the other kept variables only when the shell set them and this process didn't.
 */
export async function loginShellEnv(o: ShellEnvOptions = {}): Promise<Record<string, string>> {
  const env = o.env ?? process.env;
  const home = o.home ?? homedir();
  const shell = o.shell ?? env.SHELL ?? safeShell() ?? "/bin/zsh";
  // printf, not env: only the variables we keep, NUL-separated so values with newlines survive.
  const script = `printf '%s\\0' '${MARK}' ${SHELL_KEEP.map((k) => `"${k}=$${k}"`).join(" ")}`;
  let fromShell: Record<string, string> = {};
  try {
    const p = Bun.spawn([shell, "-ilc", script], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...env, HOME: home } });
    // The limit is on the wait, not only on the shell: something an rc file started can keep the pipe open.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<string>((r) => (timer = setTimeout(() => (p.kill("SIGKILL"), r("")), o.timeoutMs ?? 5000)));
    const out = await Promise.race([new Response(p.stdout).text(), late]);
    clearTimeout(timer);
    fromShell = parseShellOutput(out);
  } catch {}
  const exists = o.exists ?? existsSync;
  const result: Record<string, string> = {
    PATH: mergePath(fromShell.PATH, env.PATH, usualBinDirs(home).filter(exists).join(":")),
  };
  for (const k of SHELL_KEEP) if (k !== "PATH" && fromShell[k] && !env[k]) result[k] = fromShell[k]!;
  return result;
}

function safeShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}
