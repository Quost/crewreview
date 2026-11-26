import { checkAccount, isOrg, resolveLink, loadRepos, prepareLink, previewLink, QuotaBook, REVIEW_MODES, reposFile, saveRepos, type LinkedRepo, type Preview, type RepoEntry } from "@crewreview/engine";
import type { HostKind, RepoRef } from "@crewreview/hosts";
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
  include?: string;
  exclude?: string;
  conflicts?: string;
  ci?: string;
  protected?: string;
  decide?: string;
  account?: string;
  paused?: string;
  guidelines?: string;
  approve?: string;
}

const onOff = (v: string | undefined, current: boolean) => (v === undefined ? current : v === "on");

const patterns = (v: string | undefined) => (v === undefined ? undefined : v.split(",").map((p) => p.trim()).filter(Boolean));

const AUTHORS = ["others", "all", "mine"] as const;

/**
 * `--account`: post this repository's reviews as another account, checked before it's saved. "none" goes back to
 * you. Returns the text of what's wrong, or the account to save and who it is.
 */
async function reviewAccount(c: Ctx, ref: RepoRef, value: string): Promise<{ account?: string; user?: string } | string> {
  if (value === "none" || value === "") return {};
  const check = await checkAccount(ref, value, c.version);
  if ("error" in check) return c.t.t(`account.error.${check.error}` as never, { name: check.name, message: check.message ?? "" });
  return { account: value, user: check.user };
}

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
  const link = await resolveLink(idOrUrl, repos, c.version);
  return "error" in link ? c.t.t("error.repoUrl", { message: link.message }) : link;
}

export async function repo(c: Ctx, sub: string | undefined, rest: string[], a: RepoArgs): Promise<number> {
  const { t } = c;
  const file = reposFile(c.dirs);
  const bad =
    check(c, "--mode", a.mode, REVIEW_MODES) ??
    check(c, "--authors", a.authors, AUTHORS) ??
    check(c, "--kind", a.kind, ["github", "gitlab"]) ??
    check(c, "--attend", a.attend, REVIEW_MODES) ??
    check(c, "--polish", a.polish, ["on", "off"]) ??
    check(c, "--conflicts", a.conflicts, ["on", "off"]) ??
    check(c, "--ci", a.ci, ["on", "off"]) ??
    check(c, "--protected", a.protected, ["approve", "auto"]) ??
    check(c, "--decide", a.decide, ["ask", "own"]) ??
    check(c, "--paused", a.paused, ["on", "off"]) ??
    check(c, "--approve", a.approve, ["on", "off", "default"]);
  if (bad) return (c.err(bad), 2);
  const repos = await loadRepos(file);
  const entries = (): RepoEntry[] => repos.map(({ ref: _ref, ...e }) => e);

  if (sub === undefined || sub === "list") {
    if (repos.length === 0) return (c.out(t.t("repo.none")), 0);
    table(
      c,
      [t.t("repo.col.id"), t.t("repo.col.url"), t.t("repo.col.mode"), t.t("repo.col.authors"), t.t("repo.col.attend")],
      repos.map((r) => [r.id, isOrg(r) ? `${r.ref.webUrl} (${t.t(r.ref.kind === "gitlab" ? "repo.group" : "repo.org")})` : r.ref.webUrl, r.review.mode, r.review.authors, `${r.attend.mode}${r.attend.fromCrew ? " + polish" : ""}`]),
    );
    return 0;
  }

  if (sub === "add") {
    const url = rest[0];
    if (!url) return (c.err(t.t("error.usage", { usage: "crewreview repo add <repository or organization url> [--mode inbox|auto|off] [--authors others|all|mine]" })), 2);
    const p = await prepareLink(url, repos, {
      version: c.version,
      kind: a.kind as HostKind | undefined,
      overrides: {
        id: a.id,
        clone: a.clone,
        include: patterns(a.include),
        exclude: patterns(a.exclude),
        review: { mode: (a.mode as RepoEntry["review"]["mode"]) ?? "inbox", authors: (a.authors as RepoEntry["review"]["authors"]) ?? "others", commentLanguage: a.lang },
        attend: { mode: (a.attend as RepoEntry["attend"]["mode"]) ?? "off", fromCrew: a.polish === "on", conflicts: a.conflicts === "on", ci: a.ci === "on" },
      },
    });
    if ("error" in p) {
      if (p.error === "url") return (c.err(t.t("error.repoUrl", { message: p.message ?? url })), 2);
      if (p.error === "exists") return (c.err(t.t("error.repoExists", { id: p.id ?? url })), 2);
      if (p.error === "no-token" && p.ref) return (c.err(noTokenText(c, { ref: p.ref })), 2);
      return (c.err(t.t("error.host", { message: p.message ?? "" })), 2);
    }
    const { entry, ref, user } = p;
    let as: string | undefined;
    if (a.account !== undefined) {
      const acc = await reviewAccount(c, ref, a.account);
      if (typeof acc === "string") return (c.err(acc), 2);
      entry.review.account = acc.account;
      as = acc.user;
    }
    await saveRepos(file, [...entries(), entry]);
    if (p.scope === "org") c.out(t.t("repo.orgAdded", { id: entry.id, url: ref.webUrl, mode: entry.review.mode, authors: entry.review.authors, user, open: p.openRepos ?? 0 }));
    else c.out(t.t("repo.added", { id: entry.id, url: ref.webUrl, mode: entry.review.mode, authors: entry.review.authors, user }));
    if (as) c.out(t.t("repo.accountSet", { id: entry.id, user: as }));
    return 0;
  }

  if (sub === "preview") {
    const target = rest[0];
    if (!target) return (c.err(t.t("error.usage", { usage: "crewreview repo preview <id or url>" })), 2);
    const link = await findRepo(c, target);
    if (typeof link === "string") return (c.err(link), 2);
    const { deps } = await import("./review.ts");
    const d = deps(c, undefined, true);
    try {
      for (const line of previewText(c, await previewLink({ ...d, quota: QuotaBook.in(c.dirs.state) }, link))) c.out(line);
    } finally {
      d.close();
    }
    return 0;
  }

  const id = rest[0];
  const idx = repos.findIndex((r) => r.id === id);
  if (!id || (sub !== "set" && sub !== "remove")) return (c.err(t.t("error.usage", { usage: "crewreview repo [list | add <url> | preview <id or url> | set <id> --mode … | remove <id>]" })), 2);
  if (idx === -1) return (c.err(t.t("error.unknownRepo", { id })), 2);
  const list = entries();
  if (sub === "remove") {
    list.splice(idx, 1);
    await saveRepos(file, list);
    c.out(t.t("repo.removed", { id }));
    return 0;
  }
  const e = list[idx]!;
  let account = e.review.account;
  let as: string | undefined;
  if (a.account !== undefined) {
    const acc = await reviewAccount(c, repos[idx]!.ref, a.account);
    if (typeof acc === "string") return (c.err(acc), 2);
    account = acc.account;
    as = acc.user;
  }
  list[idx] = {
    ...e,
    paused: a.paused === undefined ? e.paused : a.paused === "on" || undefined,
    clone: a.clone ?? e.clone,
    include: isOrg(e) ? (patterns(a.include) ?? e.include) : e.include,
    exclude: isOrg(e) ? (patterns(a.exclude) ?? e.exclude) : e.exclude,
    review: {
      ...e.review,
      mode: (a.mode as RepoEntry["review"]["mode"]) ?? e.review.mode,
      authors: (a.authors as RepoEntry["review"]["authors"]) ?? e.review.authors,
      commentLanguage: a.lang ?? e.review.commentLanguage,
      account,
      // "none" empties the list: back to the usual files only.
      guidelines: a.guidelines === undefined ? e.review.guidelines : a.guidelines.trim() === "none" ? undefined : patterns(a.guidelines),
      // default: follow review.policy.allowApprove, the setting for every repository.
      allowApprove: a.approve === undefined ? e.review.allowApprove : a.approve === "default" ? undefined : a.approve === "on",
    },
    attend: {
      ...e.attend,
      mode: (a.attend as RepoEntry["attend"]["mode"]) ?? e.attend.mode,
      fromCrew: a.polish === undefined ? e.attend.fromCrew : a.polish === "on",
      conflicts: onOff(a.conflicts, e.attend.conflicts),
      ci: onOff(a.ci, e.attend.ci),
      protectedFiles: (a.protected as RepoEntry["attend"]["protectedFiles"] | undefined) ?? e.attend.protectedFiles,
      decide: (a.decide as RepoEntry["attend"]["decide"] | undefined) ?? e.attend.decide,
    },
  };
  await saveRepos(file, list);
  c.out(t.t("repo.updated", { id }));
  if (a.account !== undefined) c.out(as ? t.t("repo.accountSet", { id, user: as }) : t.t("repo.accountCleared", { id }));
  return 0;
}

/** The preview as lines for the terminal; the dashboard shows the same texts. */
export function previewText(c: Ctx, p: Preview): string[] {
  const { t, style: st } = c;
  const out = [st.bold(t.t("preview.title", { link: p.link, prs: p.pullRequests, repos: p.repos }))];
  if (p.totalRepos !== undefined) out.push(t.t("preview.inOrg", { total: p.totalRepos, open: p.repos }));
  if (p.org && p.repoNames.length) out.push(st.dim(t.t("preview.names", { list: p.repoNames.slice(0, 10).join(", ") + (p.repoNames.length > 10 ? "…" : "") })));
  if (p.wouldReview.length === 0) out.push(t.t("preview.none"));
  else {
    out.push(t.t("preview.would", { count: p.wouldReview.length, perCycle: p.perCycle, runs: p.agentRuns }));
    for (const r of p.wouldReview.slice(0, 15)) out.push(`  ${r.repo}#${r.number} ${st.dim(r.title)}`);
    if (p.wouldReview.length > 15) out.push(st.dim(`  … +${p.wouldReview.length - 15}`));
  }
  const skipped = Object.entries(p.skipped).map(([reason, n]) => `${t.t(`skip.${reason}` as never)} (${n})`);
  if (skipped.length) out.push(t.t("preview.skipped", { list: skipped.join(", ") }));
  if (p.ownOpen) out.push(t.t("preview.own", { count: p.ownOpen }));
  if (p.budget) out.push(t.t("preview.budget", { used: p.budget.used, limit: p.budget.limit }));
  for (const e of p.errors) out.push(st.yellow(t.t("preview.error", { repo: e.repo, error: e.error === "no-token" ? t.t("web.log.noToken") : e.error })));
  out.push(st.dim(t.t("preview.note")));
  return out;
}
