import { connect, discardAttend, loadRepos, postReview, publishAttend, registryFor, renderTerminal, reposFile, type AttendPayload } from "@crewreview/engine";
import { HostError } from "@crewreview/hosts";
import { ago, conformanceStore, openStore, table, type Ctx } from "../ctx.ts";
import { noTokenText } from "./repo.ts";
import { attendText, renderPayload } from "./attend.ts";
import { outcomeText } from "./review.ts";

export async function inbox(c: Ctx, sub: string | undefined, rest: string[]): Promise<number> {
  const { t } = c;
  const store = openStore(c);
  try {
    if (sub === undefined || sub === "list") {
      const reviews = store.inbox();
      const fixes = store.attendInbox();
      if (reviews.length + fixes.length === 0) return (c.out(t.t("inbox.empty")), 0);
      const rows = [
        ...reviews.map((r) => ({ at: r.createdAt, row: [String(r.id), t.t("inbox.kind.review"), `${r.repo}#${r.number} ${r.title.slice(0, 48)}`, `${r.event ? t.t(`verdict.${r.event}` as never) : "—"} · ${r.findings}`, ago(r.createdAt, t.locale)] })),
        ...fixes.map((f) => {
          const p = f.payload ? (JSON.parse(f.payload) as AttendPayload) : undefined;
          const fixed = p?.decisions.filter((x) => x.action === "fixed").length ?? 0;
          const replies = p?.decisions.filter((x) => x.action !== "needs-human" && x.reply).length ?? 0;
          return { at: f.createdAt, row: [`f${f.id}`, t.t("inbox.kind.fix"), `${f.repo}#${f.number} ${f.title.slice(0, 48)}`, t.t("inbox.fixSummary", { fixed, replies }), ago(f.createdAt, t.locale)] };
        }),
      ].sort((a, b) => a.at - b.at);
      table(c, [t.t("inbox.col.id"), t.t("inbox.col.kind"), t.t("inbox.col.pr"), t.t("inbox.col.verdict"), t.t("inbox.col.age")], rows.map((r) => r.row));
      return 0;
    }
    if (rest[0]?.startsWith("f")) return await fixItem(c, sub, Number(rest[0].slice(1)), store);
    const id = Number(rest[0]);
    const row = Number.isInteger(id) ? store.get(id) : undefined;
    if (!row || row.status !== "pending") return (c.err(t.t("error.unknownInboxItem", { id: rest[0] ?? "?" })), 2);

    if (sub === "show") {
      const report = JSON.parse(await Bun.file(`${row.jobDir}/report.json`).text());
      c.out(renderTerminal(report, t, c.style, t.t("pr.title", { repo: row.repo, number: row.number })));
      c.out(c.style.dim(row.url));
      return 0;
    }
    if (sub === "discard") {
      store.update(id, { status: "discarded" });
      c.out(t.t("inbox.discarded", { id }));
      return 0;
    }
    if (sub === "approve") {
      const repo = (await loadRepos(reposFile(c.dirs))).find((r) => r.id === row.repo);
      if (!repo) return (c.err(t.t("error.unknownRepo", { id: row.repo })), 2);
      const target = await connect(repo, c.version);
      if ("error" in target) return (c.err(noTokenText(c, repo)), 2);
      const d = { dirs: c.dirs, config: c.config, store, conformance: conformanceStore(c), registry: registryFor(c.config), version: c.version, ui: t };
      try {
        const o = await postReview(d, target, id);
        c.out(outcomeText(c, row.repo, row.number, o));
        return o.kind === "posted" ? 0 : 1;
      } catch (e) {
        if (e instanceof HostError) return (c.err(t.t("error.host", { message: e.message })), 1);
        throw e;
      }
    }
    c.err(t.t("error.usage", { usage: "crewreview inbox [list | show <id> | approve <id> | discard <id>]" }));
    return 2;
  } finally {
    store.close();
  }
}

async function fixItem(c: Ctx, sub: string, id: number, store: ReturnType<typeof openStore>): Promise<number> {
  const { t } = c;
  const row = Number.isInteger(id) ? store.getAttend(id) : undefined;
  if (!row || row.status !== "pending") return (c.err(t.t("error.unknownInboxItem", { id: `f${id}` })), 2);
  const d = { dirs: c.dirs, config: c.config, store, conformance: conformanceStore(c), registry: registryFor(c.config), version: c.version, ui: t };
  if (sub === "show") {
    c.out(c.style.bold(t.t("pr.title", { repo: row.repo, number: row.number })));
    c.out(c.style.dim(row.url));
    c.out();
    if (row.payload) c.out(renderPayload(c, JSON.parse(row.payload)));
    if (row.jobDir) {
      const diff = await Bun.file(`${row.jobDir}/diff.patch`).text().catch(() => "");
      if (diff) c.out(`\n${c.style.dim(diff)}`);
    }
    return 0;
  }
  if (sub === "discard") {
    await discardAttend(d, id);
    c.out(t.t("inbox.discarded", { id: `f${id}` }));
    return 0;
  }
  if (sub === "approve") {
    const repo = (await loadRepos(reposFile(c.dirs))).find((r) => r.id === row.repo);
    if (!repo) return (c.err(t.t("error.unknownRepo", { id: row.repo })), 2);
    const target = await connect(repo, c.version);
    if ("error" in target) return (c.err(noTokenText(c, repo)), 2);
    try {
      const o = await publishAttend(d, target, id);
      c.out(attendText(c, row.repo, row.number, o));
      return o.kind === "done" ? 0 : 1;
    } catch (e) {
      if (e instanceof HostError) return (c.err(t.t("error.host", { message: e.message })), 1);
      throw e;
    }
  }
  c.err(t.t("error.usage", { usage: "crewreview inbox [list | show <id> | approve <id> | discard <id>]" }));
  return 2;
}
