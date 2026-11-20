import { createHost, gitlabPathKind, hostTransport, ownerOnly, parseOwnerUrl, parseRepoUrl, repoRef, RepoUrlError, resolveToken, signedInHosts, type HostKind, type RepoRef, type TokenSource } from "@crewreview/hosts";
import { isOrg, newRepoEntry, type LinkedRepo } from "./repos.ts";

/** Whether Crewreview can reach a git host from this machine, and as whom. Never carries the token itself. */
export interface HostAccess {
  kind: HostKind;
  host: string;
  /** Where the token came from; absent when there is none. */
  source?: TokenSource;
  /** The account the token signs in as. */
  user?: string;
  /** A token was found, but the host refused it or couldn't be reached. */
  error?: string;
}

const USUAL: readonly { kind: HostKind; host: string }[] = [
  { kind: "github", host: "github.com" },
  { kind: "gitlab", host: "gitlab.com" },
];

export interface AccessDeps {
  version: string;
  /** Hosts gh and glab hold a login for (tests pass a list). */
  signedIn?: () => Promise<{ kind: HostKind; host: string }[]>;
  timeoutMs?: number;
  resolve?: (ref: RepoRef) => Promise<{ token: string; source: TokenSource } | undefined>;
  whoami?: (ref: RepoRef, token: string) => Promise<string>;
}

/** GitHub.com, GitLab.com and the hosts of linked repositories, each once. */
export async function hostAccess(linked: readonly LinkedRepo[], d: AccessDeps): Promise<HostAccess[]> {
  const seen = new Set<string>();
  const cli = await (d.signedIn ?? signedInHosts)().catch(() => []);
  const known = [...cli, ...linked.map((r) => ({ kind: r.ref.kind, host: r.ref.host }))];
  // gitlab.com only when no other GitLab is known: someone on a company GitLab isn't missing a login there.
  const usual = USUAL.filter((u) => u.kind === "github" || !known.some((k) => k.kind === "gitlab" && k.host !== "gitlab.com"));
  const hosts = [...usual, ...known].filter((h) => {
    const key = `${h.kind}:${h.host.toLowerCase()}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  const resolve = d.resolve ?? ((ref: RepoRef) => resolveToken(ref));
  const whoami = d.whoami ?? ((ref: RepoRef, token: string) => createHost(ref, hostTransport(ref, token, `crewreview/${d.version}`)).whoami());
  const ms = d.timeoutMs ?? 10_000;
  return Promise.all(
    hosts.map(async ({ kind, host }): Promise<HostAccess> => {
      const ref = repoRef(kind, host, "crewreview");
      const tk = await resolve(ref);
      if (!tk) return { kind, host };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const late = new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error(`${host} didn't answer`)), ms)));
        return { kind, host, source: tk.source, user: await Promise.race([whoami(ref, tk.token), late]) };
      } catch (e) {
        return { kind, host, source: tk.source, error: (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200) };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

/**
 * A link for an address, asking the host when the address alone can't tell: on GitLab, `group/subgroup` is a group
 * or a project at any depth. A group becomes an organization link, so its subgroups' projects come along.
 */
export async function resolveLink(url: string, linked: readonly LinkedRepo[], version: string): Promise<LinkedRepo | { error: "url"; message: string }> {
  const link = linkFromUrl(url, linked);
  if ("error" in link || link.ref.kind !== "gitlab" || isOrg(link) || linked.includes(link)) return link;
  const tk = await resolveToken(link.ref);
  if (!tk) return link;
  const kind = await gitlabPathKind(link.ref, hostTransport(link.ref, tk.token, `crewreview/${version}`)).catch(() => undefined);
  if (kind !== "group") return link;
  const ref = repoRef("gitlab", link.ref.host, link.ref.slug);
  return { ...newRepoEntry(ref, { scope: "org" }), ref };
}

/**
 * A link for an address, without the network: the linked one with that address, or a new entry for a repository or
 * (one path segment on GitHub) an organization. A GitLab group with subgroups looks like a project here; linking it
 * asks the host.
 */
export function linkFromUrl(url: string, linked: readonly LinkedRepo[]): LinkedRepo | { error: "url"; message: string } {
  try {
    const org = ownerOnly(url);
    const ref = org ? parseOwnerUrl(url) : parseRepoUrl(url);
    return linked.find((r) => r.ref.webUrl.toLowerCase() === ref.webUrl.toLowerCase()) ?? { ...newRepoEntry(ref, org ? { scope: "org" } : {}), ref };
  } catch (e) {
    if (e instanceof RepoUrlError) return { error: "url", message: e.message };
    throw e;
  }
}
