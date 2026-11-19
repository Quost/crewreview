import type { RepoRef } from "./types.ts";

async function run(argv: string[]): Promise<string | undefined> {
  const exe = Bun.which(argv[0]!);
  if (!exe) return undefined;
  const proc = Bun.spawn([exe, ...argv.slice(1)], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1", GLAB_NO_PROMPT: "1" } });
  const timer = setTimeout(() => proc.kill(), 15_000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return code === 0 ? `${out}\n${err}` : undefined;
}

export type TokenSource = "env" | "gh" | "glab";

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
