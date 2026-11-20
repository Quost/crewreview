import { HostError, type Transport } from "./transport.ts";
import type { RepoRef } from "./types.ts";

/**
 * The repositories of an organization or user (GitHub) or a group and its subgroups (GitLab) that have open pull
 * requests, most recently updated first, as paths (`acme/shop`, `acme/platform/api`). One search per page instead of
 * one call per repository, so an organization with hundreds of repositories costs a few calls per cycle. Archived
 * repositories are left out. At most `maxPages` pages of 100 pull requests are read: the rest waits for a later cycle.
 */
export async function reposWithOpenPullRequests(owner: RepoRef, transport: Transport, maxPages = 3): Promise<string[]> {
  const seen = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    const items = owner.kind === "github" ? await githubPage(owner, transport, page) : await gitlabPage(owner, transport, page);
    for (const path of items.paths) seen.add(path);
    if (items.count < 100) break;
  }
  return [...seen];
}

async function githubPage(owner: RepoRef, transport: Transport, page: number): Promise<{ paths: string[]; count: number }> {
  // `user:` matches organizations and personal accounts alike.
  const res = await transport.request("GET", "/search/issues", {
    query: { q: `is:pr is:open archived:false user:${owner.slug}`, sort: "updated", order: "desc", per_page: 100, page },
  });
  const items: any[] = res.data?.items ?? [];
  const paths = items.map((i) => /\/repos\/([^/]+\/[^/]+)$/.exec(String(i.repository_url ?? ""))?.[1]).filter((p): p is string => Boolean(p));
  return { paths, count: items.length };
}

async function gitlabPage(owner: RepoRef, transport: Transport, page: number): Promise<{ paths: string[]; count: number }> {
  const res = await transport.request("GET", `/groups/${encodeURIComponent(owner.slug)}/merge_requests`, {
    query: { state: "opened", scope: "all", non_archived: true, order_by: "updated_at", sort: "desc", per_page: 100, page },
  });
  const items: any[] = Array.isArray(res.data) ? res.data : [];
  const paths = items
    .map((m) => String(m.references?.full ?? "").split("!")[0] || String(m.web_url ?? "").replace(/^https?:\/\/[^/]+\//, "").replace(/\/-\/merge_requests\/\d+$/, ""))
    .filter((p) => p.includes("/"));
  return { paths, count: items.length };
}

/** On GitLab a path can name a project or a group. Ask which: a project answers on /projects, a group on /groups. */
export async function gitlabPathKind(ref: RepoRef, transport: Transport): Promise<"project" | "group" | undefined> {
  for (const [kind, path] of [["project", "/projects"], ["group", "/groups"]] as const) {
    try {
      await transport.request("GET", `${path}/${encodeURIComponent(ref.slug)}`);
      return kind;
    } catch (e) {
      if (!(e instanceof HostError) || e.kind !== "not-found") throw e;
    }
  }
  return undefined;
}

/** `*` matches within a name, `**` across subgroups, `?` one character. Case doesn't matter. */
export function globMatch(pattern: string, path: string): boolean {
  const re = pattern
    .split(/(\*\*|\*|\?)/)
    .map((part) => (part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${re}$`, "i").test(path);
}
