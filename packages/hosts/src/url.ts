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

/** Host, kind and path segments of a URL, an SSH remote, or "owner/repo" with a kind. */
function splitUrl(input: string, kind?: HostKind): { k: HostKind; host: string; parts: string[]; path: string } {
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
  return { k, host, parts: path.split("/").filter(Boolean), path };
}

/**
 * Accepts https URLs (also with /pull/12 or /-/merge_requests/3 at the end), SSH remotes, and "owner/repo" with a
 * kind. Self-hosted instances whose name doesn't say github or gitlab need `kind`.
 */
export function parseRepoUrl(input: string, kind?: HostKind): RepoRef {
  const { k, host, parts, path } = splitUrl(input, kind);
  if (parts.length < 2 || (k === "github" && parts.length !== 2)) throw new RepoUrlError(`not a repository path: ${path}`);
  return repoRef(k, host, parts.join("/"));
}

/** An organization or user on GitHub (https://github.com/acme), or a group on GitLab (https://gitlab.com/acme/web). */
export function parseOwnerUrl(input: string, kind?: HostKind): RepoRef {
  const s = input.trim().replace(/\/+$/, "");
  const { k, host, parts, path } = splitUrl(/^https?:\/\//i.test(s) || s.includes("@") ? s : /\//.test(s) ? s : `https://${kind === "gitlab" ? "gitlab.com" : "github.com"}/${s}`, kind);
  if (parts.length < 1 || (k === "github" && parts.length !== 1)) throw new RepoUrlError(`not an organization or group: ${path}`);
  return repoRef(k, host, parts.join("/"));
}

/**
 * Whether a URL names an organization (GitHub, one path segment) rather than a repository. On GitLab a path can be
 * a group or a project at any depth, so only a single segment is known to be a group without asking the host.
 */
export function ownerOnly(input: string, kind?: HostKind): boolean {
  try {
    return splitUrl(input, kind).parts.length === 1;
  } catch {
    return false;
  }
}
