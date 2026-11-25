import { useEffect, useState } from "react";
import { api, type HistoryRow } from "../api.ts";
import { relative, useT } from "../i18n.ts";
import { Card, Empty, ExternalLink, Pill, SectionHead } from "../ui.tsx";

const TONE: Record<string, "ok" | "warn" | "bad" | "neutral" | "live"> = { posted: "ok", done: "ok", pending: "warn", running: "live", failed: "bad", stale: "neutral", discarded: "neutral", skipped: "neutral" };

export function HistoryPage({ version }: { version: number }) {
  const t = useT();
  const [rows, setRows] = useState<HistoryRow[] | undefined>();
  useEffect(() => {
    api.get<HistoryRow[]>("/api/history?limit=100").then(setRows, () => setRows([]));
  }, [version]);
  return (
    <>
      <SectionHead title={t.t("web.nav.history")} />
      <Card>
        {rows && rows.length === 0 ? (
          <Empty>{t.t("web.history.empty")}</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t.t("inbox.col.age")}</th>
                  <th>{t.t("inbox.col.kind")}</th>
                  <th>{t.t("inbox.col.pr")}</th>
                  <th>{t.t("web.history.status")}</th>
                  <th>{t.t("web.history.result")}</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => (
                  <tr key={r.id}>
                    <td className="muted nowrap">{relative(t, r.at)}</td>
                    <td>{r.kind === "review" ? t.t("inbox.kind.review") : t.t("inbox.kind.fix")}</td>
                    <td>
                      <ExternalLink href={r.url}>
                        <span className="mono">{r.repo}#{r.number}</span>{" "}
                        {r.title}
                      </ExternalLink>
                    </td>
                    <td>
                      <Pill tone={TONE[r.status] ?? "neutral"}>{t.t(`web.status.${r.status}` as never)}</Pill>
                    </td>
                    <td className="muted small">
                      {r.kind === "review"
                        ? [r.event ? t.t(`verdict.${r.event}` as never) : "", r.status !== "skipped" ? t.tp("local.findingsCount", r.findings ?? 0) : r.note === "merge-only" ? t.t("web.history.mergeOnly") : t.t("web.history.alreadyOnHost")].filter(Boolean).join(" · ")
                        : r.commit
                          ? r.commit.slice(0, 7)
                          : (r.note ?? "")}
                      {r.error && <span className="bad-text" title={r.error}> · {r.error.slice(0, 80)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
