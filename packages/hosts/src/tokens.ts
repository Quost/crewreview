import { homedir } from "node:os";
import { join } from "node:path";
import type { RepoRef } from "./types.ts";

async function run(argv: string[]): Promise<string | undefined> {
  // The current PATH: Bun.which alone uses the one the process started with.
  const exe = Bun.which(argv[0]!, { PATH: process.env.PATH ?? "" });
  if (!exe) return undefined;
  const proc = Bun.spawn([exe, ...argv.slice(1)], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1", GLAB_NO_PROMPT: "1" } });
  const timer = setTimeout(() => proc.kill(), 15_000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return code === 0 ? `${out}\n${err}` : undefined;
}

export type TokenSource = "env" | "gh" | "glab" | "keychain";

/**
 * Find a token for the host without asking anyone: environment variables first, then the host's own CLI login
 * (`gh auth login`, `glab auth login`). The token stays in Crewreview's process memory.
 */
export async function resolveToken(
  repo: RepoRef,
  env: Record<string, string | undefined> = process.env,
): Promise<{ token: string; source: TokenSource } | undefined> {
  if (repo.kind === "github") {
    const fromEnv = repo.host === "github.com" ? (env.GH_TOKEN ?? env.GITHUB_TOKEN) : (env.GH_ENTERPRISE_TOKEN ?? env.GITHUB_ENTERPRISE_TOKEN);
    if (fromEnv) return { token: fromEnv, source: "env" };
    const out = await run(["gh", "auth", "token", "--hostname", repo.host]);
    const token = out?.trim().split("\n")[0]?.trim();
    return token ? { token, source: "gh" } : undefined;
  }
  const fromEnv = env.GITLAB_TOKEN ?? env.GLAB_TOKEN;
  if (fromEnv) return { token: fromEnv, source: "env" };
  const cfg = (await run(["glab", "config", "get", "token", "--host", repo.host]))?.trim().split("\n")[0]?.trim();
  if (cfg) return { token: cfg, source: "glab" };
  const status = await run(["glab", "auth", "status", "--hostname", repo.host, "--show-token"]);
  const m = status ? /Token(?: found)?:\s*([A-Za-z0-9_\-.]{20,})/.exec(status) : null;
  return m ? { token: m[1]!, source: "glab" } : undefined;
}

/** Env vars that make git use the token for one command, without writing it to disk or the command line. */
export function gitAuthEnv(repo: RepoRef, token: string): Record<string, string> {
  const user = repo.kind === "github" ? "x-access-token" : "oauth2";
  const basic = Buffer.from(`${user}:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.https://${repo.host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

export type AccountTokenError = "bad-name" | "env-unset" | "not-signed-in" | "gitlab-needs-env" | "keychain-missing";

/** Where Crewreview keeps tokens someone pasted: the system's credential store, under this service name. */
export const KEYCHAIN_SERVICE = "crewreview";

/** Read a token Crewreview stored in the system's credential store (macOS Keychain, Windows, libsecret). */
export async function keychainGet(name: string): Promise<string | undefined> {
  try {
    return (await Bun.secrets.get({ service: KEYCHAIN_SERVICE, name })) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The token of another account to post reviews as (a repository's `review.account`), so a pull request of yours can
 * be approved by someone who isn't you. `env:NAME` reads an environment variable; a login asks gh for that account's
 * token, since gh keeps several accounts per host. glab keeps one per host, so GitLab needs `env:`.
 */
export async function resolveAccountToken(
  repo: RepoRef,
  account: string,
  env: Record<string, string | undefined> = process.env,
  runCmd: (argv: string[]) => Promise<string | undefined> = run,
  secrets: (name: string) => Promise<string | undefined> = keychainGet,
): Promise<{ token: string; source: TokenSource } | { error: AccountTokenError; name: string }> {
  // A token pasted in the app (a GitLab group or project access token, a bot's GitHub token), kept in the keychain.
  const fromKeychain = /^keychain:([A-Za-z0-9._/@-]{1,200})$/.exec(account);
  if (fromKeychain) {
    const value = (await secrets(fromKeychain[1]!))?.trim();
    return value ? { token: value, source: "keychain" } : { error: "keychain-missing", name: fromKeychain[1]! };
  }
  const fromEnv = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(account);
  if (fromEnv) {
    const value = env[fromEnv[1]!]?.trim();
    return value ? { token: value, source: "env" } : { error: "env-unset", name: fromEnv[1]! };
  }
  // A login, never an option: it goes on gh's command line.
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(account)) return { error: "bad-name", name: account };
  if (repo.kind === "gitlab") return { error: "gitlab-needs-env", name: account };
  const out = await runCmd(["gh", "auth", "token", "--hostname", repo.host, "--user", account]);
  const token = out?.trim().split("\n")[0]?.trim();
  return token ? { token, source: "gh" } : { error: "not-signed-in", name: account };
}

/**
 * The hosts gh and glab hold a login for, as the setup shows them: a company GitLab or GitHub Enterprise appears
 * without linking anything first. Only host names are read, never tokens.
 */
export async function signedInHosts(
  runCmd: (argv: string[]) => Promise<string | undefined> = run,
  listGlab: () => Promise<string[]> = runCmd === run ? glabHosts : async () => [],
): Promise<{ kind: "github" | "gitlab"; host: string }[]> {
  const out: { kind: "github" | "gitlab"; host: string }[] = [];
  const configured = await listGlab().catch(() => []);
  const [gh, perHost, glab] = await Promise.all([
    runCmd(["gh", "auth", "status", "--json", "hosts", "--jq", ".hosts | keys | .[]"]),
    // Each glab host on its own and at once: `glab auth status` checks them one after another, so one host that
    // doesn't answer (gitlab.com timing out) used to hide a company GitLab that does.
    // A host that answers does so in a second or two; 8 seconds keeps the setup page from waiting on one that doesn't.
    Promise.all(configured.map((h) => runCmdAll(runCmd, ["glab", "auth", "status", "--hostname", h], 8_000))),
    configured.length ? undefined : runCmdAll(runCmd, ["glab", "auth", "status"]),
  ]);
  for (const line of (gh ?? "").split("\n")) if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(line.trim())) out.push({ kind: "github", host: line.trim().toLowerCase() });
  configured.forEach((host, i) => {
    if (new RegExp(`Logged in to ${host.replace(/[.]/g, "\\.")}`, "i").test(perHost[i] ?? "")) out.push({ kind: "gitlab", host });
  });
  // Without glab's config file, its listing: each host on a line of its own, then indented details. Only a host
  // it's logged in to counts: a configured host whose token fails (401) isn't one someone uses.
  let heading: string | undefined;
  for (const line of (glab ?? "").split("\n")) {
    const m = /^([a-z0-9.-]+\.[a-z]{2,})\s*$/i.exec(line);
    if (m) heading = m[1]!.toLowerCase();
    else if (heading && /Logged in to /i.test(line) && !out.some((o) => o.kind === "gitlab" && o.host === heading)) out.push({ kind: "gitlab", host: heading });
  }
  return out;
}

/** The hosts in glab's config file, wherever this glab keeps it. */
export async function glabHosts(env: Record<string, string | undefined> = process.env, home = homedir()): Promise<string[]> {
  const dirs = [
    env.GLAB_CONFIG_DIR,
    env.XDG_CONFIG_HOME && join(env.XDG_CONFIG_HOME, "glab-cli"),
    join(home, ".config", "glab-cli"),
    join(home, "Library", "Application Support", "glab-cli"),
    env.APPDATA && join(env.APPDATA, "glab-cli"),
  ].filter((d): d is string => !!d);
  const hosts = new Set<string>();
  for (const dir of dirs) {
    const f = Bun.file(join(dir, "config.yml"));
    if (await f.exists()) for (const h of parseGlabHosts(await f.text())) hosts.add(h);
  }
  return [...hosts];
}

/** The keys under `hosts:` in glab's config.yml. */
export function parseGlabHosts(yaml: string): string[] {
  const out: string[] = [];
  let inHosts = false;
  let indent = -1;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^hosts:\s*$/.test(line)) {
      inHosts = true;
      continue;
    }
    if (!inHosts || !line.trim() || line.trim().startsWith("#")) continue;
    const lead = line.length - line.trimStart().length;
    if (lead === 0) break;
    if (indent === -1) indent = lead;
    const m = /^([a-z0-9.-]+\.[a-z]{2,}):\s*$/i.exec(line.trim());
    if (lead === indent && m) out.push(m[1]!.toLowerCase());
  }
  return out;
}

/** glab auth status exits non-zero when any host fails; its listing is still what we want. */
async function runCmdAll(runCmd: (argv: string[]) => Promise<string | undefined>, argv: string[], timeoutMs = 15_000): Promise<string | undefined> {
  if (runCmd !== run) return runCmd(argv);
  const exe = Bun.which(argv[0]!, { PATH: process.env.PATH ?? "" });
  if (!exe) return undefined;
  const proc = Bun.spawn([exe, ...argv.slice(1)], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1", GLAB_NO_PROMPT: "1" } });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return `${o}\n${e}`;
}
