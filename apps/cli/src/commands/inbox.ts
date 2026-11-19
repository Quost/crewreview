import { connect, loadRepos, postReview, registryFor, renderTerminal, reposFile } from "@crewreview/engine";
import { HostError } from "@crewreview/hosts";
import { ago, conformanceStore, openStore, table, type Ctx } from "../ctx.ts";
import { noTokenText } from "./repo.ts";
import { outcomeText } from "./review.ts";

export async function inbox(c: Ctx, sub: string | undefined, rest: string[]): Promise<number> {
  const { t } = c;
  const store = openStore(c);
  try {
    if (sub === undefined || sub === "list") {
      const items = store.inbox();
      if (items.length === 0) return (c.out(t.t("inbox.empty")), 0);
      table(
        c,
        [t.t("inbox.col.id"), t.t("inbox.col.pr"), t.t("inbox.col.verdict"), t.t("inbox.col.findings"), t.t("inbox.col.age")],
        items.map((r) => [String(r.id), `${r.repo}#${r.number} ${r.title.slice(0, 50)}`, r.event ? t.t(`verdict.${r.event}` as never) : "—", String(r.findings), ago(r.createdAt, t.locale)]),
      );
      return 0;
    }
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
