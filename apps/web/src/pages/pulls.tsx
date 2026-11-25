import { useState } from "react";
import { api, type BlockedItem, type PullsRepo } from "../api.ts";
import { relative, useT } from "../i18n.ts";
import { Card, Empty, ExternalLink, Pill, SectionHead } from "../ui.tsx";

/** Your open pull requests the attendant works on: what's waiting on you, and a way to send the crew again. */
export function PullsPage({ data, reload }: { data: PullsRepo[] | undefined; reload: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();

  const act = async (id: string, path: string, body?: unknown) => {
    setBusy(id);
    setNote(undefined);
    try {
      await api.post(path, body);
    } catch (e: any) {
      setNote(t.t(`web.pulls.error.${e?.body?.error ?? "other"}` as never));
    } finally {
      setBusy(undefined);
      reload();
    }
  };

  const total = (data ?? []).reduce((n, r) => n + r.pulls.length, 0);
  return (
    <>
      <SectionHead title={t.t("web.nav.pulls")} actions={<button className="btn ghost" onClick={reload}>{t.t("web.pulls.refresh")}</button>} />
      <p className="muted lead">{t.t("web.pulls.intro")}</p>
      {note && <p className="bad-text">{note}</p>}
      {data === undefined && <Empty>{t.t("web.pulls.loading")}</Empty>}
      {data && total === 0 && !data.some((r) => r.error) && <Empty>{t.t("web.pulls.empty")}</Empty>}
      {(data ?? []).map((r) =>
        r.error ? (
          <Card key={r.repo} title={<span className="mono">{r.repo}</span>}>
            <p className="bad-text">{r.error === "no-token" ? t.t("web.pulls.noToken") : r.error}</p>
          </Card>
        ) : r.pulls.length === 0 ? null : (
          <Card key={r.repo} title={<ExternalLink href={r.repoUrl}><span className="mono">{r.repo}</span></ExternalLink>} actions={r.paused ? <Pill>{t.t("web.pulls.paused")}</Pill> : <Pill tone="accent">{t.t(`web.pulls.mode.${r.mode}` as never)}</Pill>}>
            {r.paused && <p className="muted small">{t.t("web.pulls.pausedHint")}</p>}
            <div className="pulls">
              {r.pulls.map((p) => {
                const id = `${r.repo}#${p.number}`;
                const waiting = p.blocked.filter((b) => b.status !== "trying");
                return (
                  <div key={p.number} className="pull">
                    <div className="pull-head">
                      <ExternalLink href={p.url}>
                        <span className="mono">#{p.number}</span> {p.title}
                      </ExternalLink>
                      <div className="pull-tags">
                        {p.draft && <Pill>{t.t("web.pulls.draft")}</Pill>}
                        {p.conflicts && <Pill tone="warn">{t.t("web.pulls.conflicts")}</Pill>}
                        {p.busy && <Pill tone="live">{t.t("web.pulls.busy")}</Pill>}
                        {waiting.length > 0 && <Pill tone="bad">{t.tp("web.pulls.waiting", waiting.length)}</Pill>}
                        {p.last && <span className="muted small">{t.t("web.pulls.last", { when: relative(t, p.last.at), status: t.t(`web.status.${p.last.status}` as never) })}</span>}
                      </div>
                      <div className="pull-actions">
                        {waiting.length > 1 && (
                          <button className="btn ghost" disabled={busy === id} onClick={() => act(id, `/api/repos/${r.repo}/attend/${p.number}/reset-items`)}>
                            {t.t("web.pulls.retryAll")}
                          </button>
                        )}
                        <button className="btn primary" disabled={busy === id || p.busy || p.draft || r.paused} title={r.paused ? t.t("web.pulls.pausedHint") : p.draft ? t.t("web.pulls.draftHint") : undefined} onClick={() => act(id, `/api/pulls/${r.repo}/${p.number}/attend`)}>
                          {t.t("web.pulls.attendNow")}
                        </button>
                      </div>
                    </div>
                    {p.draft && <p className="muted small">{t.t("web.pulls.draftHint")}</p>}
                    {waiting.length > 0 && (
                      <ul className="blocked">
                        {waiting.map((b) => (
                          <BlockedRow key={b.key} b={b} disabled={busy === `${id}:${b.key}`} onRetry={() => act(`${id}:${b.key}`, `/api/pulls/${r.repo}/${p.number}/retry`, { key: b.key })} onDismiss={() => act(`${id}:${b.key}`, `/api/pulls/${r.repo}/${p.number}/dismiss`, { key: b.key })} />
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        ),
      )}
    </>
  );
}

const STATUS_TONE: Record<string, "warn" | "bad" | "neutral"> = { "needs-human": "warn", "gave-up": "bad", ignored: "neutral" };

function BlockedRow({ b, disabled, onRetry, onDismiss }: { b: BlockedItem; disabled: boolean; onRetry: () => void; onDismiss: () => void }) {
  const t = useT();
  const where = b.path ? `${b.path}${b.line ? `:${b.line}` : ""}` : t.t(`attend.leftKind.${b.kind}` as never);
  return (
    <li className="blocked-item">
      <div className="blocked-main">
        <div>
          <Pill tone={STATUS_TONE[b.status] ?? "neutral"}>{b.status === "gave-up" ? t.tp("web.pulls.status.gave-up", b.attempts) : t.t(`web.pulls.status.${b.status}` as never)}</Pill> <span className={b.path ? "mono small" : "small"}>{where}</span>
          {b.author && <span className="muted small"> · @{b.author}</span>}
          <span className="muted small"> · {relative(t, b.at)}</span>
        </div>
        {b.text && <p className="small quote">{b.text.replace(/^[^:\n]{1,60}: /, "").slice(0, 280)}</p>}
        <p className="small muted">{b.reason ? t.t("web.pulls.reason", { reason: b.reason }) : t.t(`web.pulls.why.${b.status}` as never)}</p>
      </div>
      <div className="blocked-actions">
        <button className="btn ghost" disabled={disabled} onClick={onDismiss} title={t.t("web.pulls.dismissHint")}>
          {t.t("web.pulls.dismiss")}
        </button>
        <button className="btn" disabled={disabled} onClick={onRetry} title={t.t("web.pulls.retryHint")}>
          {t.t("web.pulls.retry")}
        </button>
      </div>
    </li>
  );
}
