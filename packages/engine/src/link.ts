import { createHost, gitlabPathKind, HostError, hostTransport, ownerOnly, parseOwnerUrl, parseRepoUrl, reposWithOpenPullRequests, resolveToken, RepoUrlError, type HostKind, type RepoRef } from "@crewreview/hosts";
import { newRepoEntry, type LinkedRepo, type RepoEntry } from "./repos.ts";

export type LinkOverrides = Parameters<typeof newRepoEntry>[1];

export type PreparedLink =
  | { entry: RepoEntry; ref: RepoRef; user: string; scope: "repo" | "org"; openRepos?: number }
  | { error: "url" | "exists" | "no-token" | "host"; message?: string; id?: string; ref?: RepoRef };

/**
 * Turn a repository or organization address into an entry for repos.toml, after checking it can be reached with a
 * token found on this machine. A GitHub address with one path segment is an organization or user; on GitLab the host
 * says whether a path is a group or a project.
 */
export async function prepareLink(url: string, existing: readonly LinkedRepo[], o: { version: string; kind?: HostKind; overrides?: LinkOverrides }): Promise<PreparedLink> {
  let ref: RepoRef;
  let scope: "repo" | "org";
  try {
    scope = ownerOnly(url, o.kind) ? "org" : "repo";
    ref = scope === "org" ? parseOwnerUrl(url, o.kind) : parseRepoUrl(url, o.kind);
  } catch (e) {
    if (e instanceof RepoUrlError) return { error: "url", message: e.message };
    throw e;
  }
  const tk = await resolveToken(ref);
  if (!tk) return { error: "no-token", ref };
  const transport = hostTransport(ref, tk.token, `crewreview/${o.version}`);
  try {
    if (scope === "repo" && ref.kind === "gitlab") {
      const kind = await gitlabPathKind(ref, transport);
      if (!kind) return { error: "host", message: `${ref.webUrl}: not found` };
      if (kind === "group") scope = "org";
    }
    const entry = newRepoEntry(ref, { ...o.overrides, scope });
    if (existing.some((r) => r.id === entry.id || r.ref.webUrl.toLowerCase() === ref.webUrl.toLowerCase())) return { error: "exists", id: entry.id };
    const host = createHost(ref, transport);
    const user = await host.whoami();
    if (scope === "repo") {
      await host.listOpenPullRequests();
      return { entry, ref, user, scope };
    }
    const open = await reposWithOpenPullRequests(ref, transport, 1);
    return { entry, ref, user, scope, openRepos: open.length };
  } catch (e) {
    if (e instanceof HostError) return { error: "host", message: e.message };
    throw e;
  }
}
