import { createHost, hostTransport, resolveAccountToken, resolveToken, type AccountTokenError, type HostAdapter, type RepoRef } from "@crewreview/hosts";
import type { LinkedRepo } from "./repos.ts";

/** Why an account can't post reviews for a repository. */
export type AccountProblem = { error: AccountTokenError | "same-account" | "host"; name: string; message?: string };

export interface AccountDeps {
  resolveAccount?: typeof resolveAccountToken;
  resolveOwn?: (ref: RepoRef) => Promise<{ token: string } | undefined>;
  whoami?: (ref: RepoRef, token: string) => Promise<string>;
}

const defaultWhoami = (version: string) => (ref: RepoRef, token: string) => createHost(ref, hostTransport(ref, token, `crewreview/${version}`)).whoami();

/**
 * Before an account is saved as a repository's reviewer: its token is found, the host says who it is, and it isn't
 * you (your own account still couldn't approve your pull requests).
 */
export async function checkAccount(ref: RepoRef, account: string, version: string, d: AccountDeps = {}): Promise<{ user: string } | AccountProblem> {
  const tk = await (d.resolveAccount ?? resolveAccountToken)(ref, account);
  if ("error" in tk) return tk;
  const whoami = d.whoami ?? defaultWhoami(version);
  let user: string;
  try {
    user = await whoami(ref, tk.token);
  } catch (e) {
    return { error: "host", name: account, message: (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200) };
  }
  const own = await (d.resolveOwn ?? resolveToken)(ref);
  if (own) {
    const me = await whoami(ref, own.token).catch(() => undefined);
    if (me && me.toLowerCase() === user.toLowerCase()) return { error: "same-account", name: user };
  }
  return { user };
}

/**
 * Who posts a repository's reviews: its review account when it has one, or undefined for you. An account whose token
 * can't be found is an error, never a quiet fallback to your account.
 */
export async function posterFor(repo: LinkedRepo, version: string, resolve: typeof resolveAccountToken = resolveAccountToken): Promise<HostAdapter | { error: string } | undefined> {
  const account = repo.review.account;
  if (!account) return undefined;
  const tk = await resolve(repo.ref, account);
  if ("error" in tk) return { error: `can't post as ${tk.name}: ${ACCOUNT_HINT[tk.error]}` };
  return createHost(repo.ref, hostTransport(repo.ref, tk.token, `crewreview/${version}`));
}

/** For logs and failed reviews; the dashboard and the terminal show translated texts from the error codes. */
const ACCOUNT_HINT: Record<AccountTokenError, string> = {
  "bad-name": "not an account name (use a login, or env:VARIABLE)",
  "env-unset": "that environment variable isn't set where the crew runs",
  "not-signed-in": "not signed in to gh on this computer (gh auth login as that account, then gh auth switch back)",
  "gitlab-needs-env": "glab keeps one account per host; put the token in an environment variable and use env:NAME",
};
