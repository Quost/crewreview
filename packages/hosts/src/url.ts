import type { HostKind, RepoRef } from "./types.ts";

export class RepoUrlError extends Error {}

function guessKind(host: string): HostKind | undefined {
  const h = host.toLowerCase();
  if (h === "github.com" || h.includes("github")) return "github";
  if (h === "gitlab.com" || h.includes("gitlab")) return "gitlab";
  return undefined;
}

export function repoRef(kind: HostKind, host: string, slug: string): RepoRef {
  const h = host.toLowerCase();
  const apiBase =
    kind === "github" ? (h === "github.com" ? "https://api.github.com" : `https://${h}/api/v3`) : `https://${h}/api/v4`;
  return { kind, host: h, slug, apiBase, webUrl: `https://${h}/${slug}`, cloneUrl: `https://${h}/${slug}.git` };
}

/**
 * Accepts https URLs (also with /pull/12 or /-/merge_requests/3 at the end), SSH remotes, and "owner/repo" with a
 * kind. Self-hosted instances whose name doesn't say github or gitlab need `kind`.
 */
export function parseRepoUrl(input: string, kind?: HostKind): RepoRef {
  const s = input.trim();
  let host: string;
  let path: string;
  const ssh = /^(?:ssh:\/\/)?[\w.-]+@([\w.-]+)(?::\d+)?[:/](.+)$/.exec(s);
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    host = u.host;
    path = u.pathname;
  } else if (ssh) {
    host = ssh[1]!;
    path = ssh[2]!;
  } else if (/^[\w.-]+(\/[\w.-]+)+$/.test(s)) {
    host = kind === "gitlab" ? "gitlab.com" : "github.com";
    path = s;
  } else {
    throw new RepoUrlError(`not a repository URL: ${input}`);
  }
  path = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .replace(/\/-\/.*$/, "") // GitLab: /-/merge_requests/3, /-/tree/main
    .replace(/\/(pull|pulls|tree|blob|issues|commit|actions)(\/.*)?$/, ""); // GitHub
  const k = kind ?? guessKind(host);
  if (!k) throw new RepoUrlError(`can't tell whether ${host} is GitHub or GitLab; pass the host kind`);
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2 || (k === "github" && parts.length !== 2)) throw new RepoUrlError(`not a repository path: ${path}`);
  return repoRef(k, host, parts.join("/"));
}
