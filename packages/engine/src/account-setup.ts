import { which } from "@crewreview/harness";
import type { RepoRef } from "@crewreview/hosts";

/**
 * Signing a second account in to gh from the app, for a repository's `review.account`. gh's device flow: it prints a
 * one-time code, the person types it at github.com/login/device signed in as the second account, and gh keeps the
 * token in the system's credential store. gh makes the new account the active one, so the account that was active
 * before is switched back at the end, whatever happened.
 */
export type SignInState =
  | { state: "idle" }
  | { state: "waiting"; login: string; code: string; url: string; since: number }
  | { state: "done"; login: string; restoredTo?: string }
  | { state: "failed"; login: string; error: SignInError; who?: string; detail?: string; restoredTo?: string };

export type SignInError = "gh-missing" | "gh-token-env" | "wrong-account" | "no-code" | "failed";

export interface SignInDeps {
  /** gh's path; found on PATH by default. */
  gh?: string;
  env?: Record<string, string | undefined>;
  /** Who a token signs in as. */
  whoami: (token: string) => Promise<string>;
  /** How long to wait for gh to print the code. */
  codeTimeoutMs?: number;
}

const CODE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const URL_RE = /(https:\/\/[^\s]+\/login\/device)\b/;

/** The text gh prints, without its codes and colors: what the person sees when something went wrong. */
const lastLine = (s: string) =>
  s
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 200);

export class AccountSignIn {
  private current: SignInState = { state: "idle" };
  private proc?: ReturnType<typeof Bun.spawn>;

  constructor(
    private readonly ref: RepoRef,
    private readonly d: SignInDeps,
  ) {}

  status(): SignInState {
    return this.current;
  }

  cancel(): void {
    this.proc?.kill();
    this.proc = undefined;
    if (this.current.state === "waiting") this.current = { state: "idle" };
  }

  /** Start gh's sign-in for `login`. Resolves when the code is ready to show, or with what went wrong. */
  async start(login: string): Promise<SignInState> {
    this.cancel();
    const env = this.d.env ?? process.env;
    const gh = this.d.gh ?? which("gh");
    if (!gh) return (this.current = { state: "failed", login, error: "gh-missing" });
    // gh won't sign in another account while a token in the environment overrides its own.
    const tokenVar = this.ref.host === "github.com" ? ["GH_TOKEN", "GITHUB_TOKEN"] : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
    const set = tokenVar.find((v) => env[v]);
    if (set) return (this.current = { state: "failed", login, error: "gh-token-env", detail: set });

    const before = await this.active(gh, env);
    const proc = Bun.spawn([gh, "auth", "login", "--hostname", this.ref.host, "--web", "--git-protocol", "https", "--skip-ssh-key"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // No browser from here: the person opens the page in a window signed in as the second account.
      env: { ...env, GH_BROWSER: "true", BROWSER: "true", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    });
    this.proc = proc;
    proc.stdin.write("\n");
    proc.stdin.end();

    let text = "";
    let shown!: (s: SignInState) => void;
    const ready = new Promise<SignInState>((r) => (shown = r));
    const read = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) {
        text += new TextDecoder().decode(chunk);
        const code = CODE.exec(text)?.[1];
        const url = URL_RE.exec(text)?.[1];
        if (code && url && this.current.state !== "waiting" && this.proc === proc) {
          this.current = { state: "waiting", login, code, url, since: Date.now() };
          shown(this.current);
        }
      }
    };
    const reading = Promise.all([read(proc.stdout), read(proc.stderr)]);
    const timer = setTimeout(() => {
      if (this.current.state === "waiting" || this.proc !== proc) return;
      proc.kill();
      this.current = { state: "failed", login, error: "no-code", detail: lastLine(text) };
      shown(this.current);
    }, this.d.codeTimeoutMs ?? 20_000);

    void (async () => {
      const exit = await proc.exited;
      await reading;
      clearTimeout(timer);
      // Even when cancelled: a code authorized just before would have switched gh to the second account.
      const restoredTo = await this.restore(gh, env, before);
      if (this.proc !== proc) return; // cancelled, or a newer sign-in took over
      this.proc = undefined;
      if (exit !== 0) {
        if (this.current.state !== "failed") this.current = { state: "failed", login, error: "failed", detail: lastLine(text), restoredTo };
        shown(this.current);
        return;
      }
      // gh signed in whoever authorized the code: make sure that's the second account.
      const token = await this.tokenOf(gh, env, login);
      const who = token ? await this.d.whoami(token).catch(() => undefined) : undefined;
      if (who?.toLowerCase() === login.toLowerCase()) this.current = { state: "done", login: who, restoredTo };
      else this.current = { state: "failed", login, error: "wrong-account", who: /Logged in as (\S+)/.exec(text)?.[1], restoredTo };
      shown(this.current);
    })();
    return ready;
  }

  /** The account gh uses for this host right now. */
  private async active(gh: string, env: Record<string, string | undefined>): Promise<string | undefined> {
    const p = Bun.spawn([gh, "auth", "status", "--hostname", this.ref.host, "--json", "hosts"], { stdout: "pipe", stderr: "ignore", env: { ...env, NO_COLOR: "1" } });
    const out = await new Response(p.stdout).text();
    await p.exited;
    try {
      const hosts = JSON.parse(out).hosts?.[this.ref.host] as { login: string; active: boolean }[] | undefined;
      return hosts?.find((h) => h.active)?.login;
    } catch {
      return undefined;
    }
  }

  /** The token gh keeps for an account, if it has one. */
  private async tokenOf(gh: string, env: Record<string, string | undefined>, login: string): Promise<string | undefined> {
    const p = Bun.spawn([gh, "auth", "token", "--hostname", this.ref.host, "--user", login], { stdout: "pipe", stderr: "ignore", env: { ...env, NO_COLOR: "1" } });
    const out = (await new Response(p.stdout).text()).trim().split("\n")[0]?.trim();
    return (await p.exited) === 0 && out ? out : undefined;
  }

  /** Make the account that was active before the sign-in active again. */
  private async restore(gh: string, env: Record<string, string | undefined>, before: string | undefined): Promise<string | undefined> {
    if (!before) return undefined;
    if ((await this.active(gh, env))?.toLowerCase() === before.toLowerCase()) return before;
    const p = Bun.spawn([gh, "auth", "switch", "--hostname", this.ref.host, "--user", before], { stdout: "ignore", stderr: "ignore", env });
    return (await p.exited) === 0 ? before : undefined;
  }
}
