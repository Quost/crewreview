import { loadRepos, newRepoEntry, REVIEW_MODES, reposFile, saveRepos, connect, type LinkedRepo, type RepoEntry } from "@crewreview/engine";
import { HostError, parseRepoUrl, RepoUrlError, type HostKind } from "@crewreview/hosts";
import { table, type Ctx } from "../ctx.ts";

export interface RepoArgs {
  kind?: string;
  mode?: string;
  authors?: string;
  clone?: string;
  lang?: string;
  id?: string;
  attend?: string;
  polish?: string;
}

const AUTHORS = ["others", "all", "mine"] as const;

function check(c: Ctx, option: string, value: string | undefined, list: readonly string[]): string | undefined {
  if (value === undefined || list.includes(value)) return undefined;
  return c.t.t("error.badValue", { option, value, list: list.join(", ") });
}

export function noTokenText(c: Ctx, repo: { ref: { kind: HostKind; host: string } }): string {
  const gh = repo.ref.kind === "github";
  return c.t.t("error.noToken", { host: repo.ref.host, cli: gh ? "gh" : "glab", env: gh ? "GH_TOKEN" : "GITLAB_TOKEN" });
}

/** Find a linked repository by id, or treat the argument as a URL of one that isn't linked. */
export async function findRepo(c: Ctx, idOrUrl: string): Promise<LinkedRepo | string> {
  const repos = await loadRepos(reposFile(c.dirs));
  const hit = repos.find((r) => r.id === idOrUrl);
  if (hit) return hit;
  if (!idOrUrl.includes("/")) return c.t.t("error.unknownRepo", { id: idOrUrl });
  try {
    const ref = parseRepoUrl(idOrUrl);
    return repos.find((r) => r.ref.webUrl === ref.webUrl) ?? { ...newRepoEntry(ref), ref };
  } catch (e) {
    return c.t.t("error.repoUrl", { message: (e as Error).message });
  }
}

export async function repo(c: Ctx, sub: string | undefined, rest: string[], a: RepoArgs): Promise<number> {
  const { t } = c;
  const file = reposFile(c.dirs);
  const bad =
    check(c, "--mode", a.mode, REVIEW_MODES) ??
    check(c, "--authors", a.authors, AUTHORS) ??
    check(c, "--kind", a.kind, ["github", "gitlab"]) ??
    check(c, "--attend", a.attend, REVIEW_MODES) ??
    check(c, "--polish", a.polish, ["on", "off"]);
  if (bad) return (c.err(bad), 2);
  const repos = await loadRepos(file);
  const entries = (): RepoEntry[] => repos.map(({ ref: _ref, ...e }) => e);

  if (sub === undefined || sub === "list") {
    if (repos.length === 0) return (c.out(t.t("repo.none")), 0);
    table(
      c,
      [t.t("repo.col.id"), t.t("repo.col.url"), t.t("repo.col.mode"), t.t("repo.col.authors"), t.t("repo.col.attend")],
      repos.map((r) => [r.id, r.ref.webUrl, r.review.mode, r.review.authors, `${r.attend.mode}${r.attend.fromCrew ? " + polish" : ""}`]),
    );
    return 0;
  }

  if (sub === "add") {
    const url = rest[0];
    if (!url) return (c.err(t.t("error.usage", { usage: "crewreview repo add <url> [--mode inbox|auto|off] [--authors others|all|mine]" })), 2);
    let ref;
    try {
      ref = parseRepoUrl(url, a.kind as HostKind | undefined);
    } catch (e) {
      if (e instanceof RepoUrlError) return (c.err(t.t("error.repoUrl", { message: e.message })), 2);
      throw e;
    }
    const entry = newRepoEntry(ref, {
      id: a.id,
      clone: a.clone,
      review: { mode: (a.mode as RepoEntry["review"]["mode"]) ?? "inbox", authors: (a.authors as RepoEntry["review"]["authors"]) ?? "others", commentLanguage: a.lang },
      attend: { mode: (a.attend as RepoEntry["attend"]["mode"]) ?? "off", fromCrew: a.polish === "on" },
    });
    if (repos.some((r) => r.id === entry.id || r.ref.webUrl === ref.webUrl)) return (c.err(t.t("error.repoExists", { id: entry.id })), 2);
    const target = await connect({ ...entry, ref }, c.version);
    if ("error" in target) return (c.err(noTokenText(c, { ref })), 2);
    let user: string;
    try {
      user = await target.host.whoami();
      await target.host.listOpenPullRequests();
    } catch (e) {
      return (c.err(t.t("error.host", { message: e instanceof HostError ? e.message : String(e) })), 2);
    }
    await saveRepos(file, [...entries(), entry]);
    c.out(t.t("repo.added", { id: entry.id, url: ref.webUrl, mode: entry.review.mode, authors: entry.review.authors, user }));
    return 0;
  }

  const id = rest[0];
  const idx = repos.findIndex((r) => r.id === id);
  if (!id || (sub !== "set" && sub !== "remove")) return (c.err(t.t("error.usage", { usage: "crewreview repo [list | add <url> | set <id> --mode … | remove <id>]" })), 2);
  if (idx === -1) return (c.err(t.t("error.unknownRepo", { id })), 2);
  const list = entries();
  if (sub === "remove") {
    list.splice(idx, 1);
    await saveRepos(file, list);
    c.out(t.t("repo.removed", { id }));
    return 0;
  }
  const e = list[idx]!;
  list[idx] = {
    ...e,
    clone: a.clone ?? e.clone,
    review: {
      ...e.review,
      mode: (a.mode as RepoEntry["review"]["mode"]) ?? e.review.mode,
      authors: (a.authors as RepoEntry["review"]["authors"]) ?? e.review.authors,
      commentLanguage: a.lang ?? e.review.commentLanguage,
    },
    attend: {
      ...e.attend,
      mode: (a.attend as RepoEntry["attend"]["mode"]) ?? e.attend.mode,
      fromCrew: a.polish === undefined ? e.attend.fromCrew : a.polish === "on",
    },
  };
  await saveRepos(file, list);
  c.out(t.t("repo.updated", { id }));
  return 0;
}
