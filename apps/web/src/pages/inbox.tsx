import { useEffect, useState } from "react";
import { api, type InboxDetail, type InboxItem } from "../api.ts";
import { lensName, relative, useT } from "../i18n.ts";
import { Card, Empty, ExternalLink, Inline, Pill, SeverityPill } from "../ui.tsx";

/** The first line of a comment, without the author prefix, markdown or hidden markers. */
function plain(text: string): string {
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  return first
    .replace(/^[^:\s]{1,40}:\s*/, "")
    .replace(/<!--.*?-->/g, "")
    .replace(/[*_`]/g, "")
    .slice(0, 220);
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="diff">
      {diff.split("\n").map((l, i) => (
        <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : ""}>
          {l}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function ReviewDetail({ d }: { d: Extract<InboxDetail, { kind: "review" }> }) {
  const t = useT();
  const r = d.report;
  return (
    <>
      <p>
        <Pill tone={r.verdict.event === "request_changes" ? "bad" : r.verdict.event === "approve" ? "ok" : "warn"}>{t.t(`verdict.${r.verdict.event}` as never)}</Pill>{" "}
        <span className="muted">{r.verdict.reasons.map((x) => t.t(`reason.${x}` as never)).join("; ")}</span>
      </p>
      {r.findings.length === 0 && <Empty>{t.t("local.noFindings")}</Empty>}
      <ul className="findings">
        {r.findings.map((f) => (
          <li key={f.id} className={`finding sev-${f.severity}`}>
            <div className="finding-head">
              <SeverityPill severity={f.severity} label={t.t(`severity.${f.severity}`)} />
              <span className="mono">
                {f.path}:{f.line}
              </span>
              <span className="muted small">{f.lenses.map((l) => lensName(t, l)).join(", ")}</span>
            </div>
            <strong>{f.title}</strong>
            <p className="body"><Inline text={f.body} /></p>
          </li>
        ))}
      </ul>
      {r.repeated && r.repeated.length > 0 && <p className="muted small">{t.tp("post.alreadyDiscussed", r.repeated.length)}</p>}
    </>
  );
}

function FixDetail({ d }: { d: Extract<InboxDetail, { kind: "fix" }> }) {
  const t = useT();
  const p = d.payload;
  return (
    <>
      {d.row.error && <p className="notice warn">{t.t("web.inbox.retryHelp", { error: String(d.row.error) })}</p>}
      {p.forcedInbox && <p className="notice warn">{t.t(`attend.forced.${p.forcedInbox}` as never)}</p>}
      <ul className="decisions">
        {p.decisions.map((dec) => {
          const it = p.items.find((i) => i.key === dec.key);
          const where = it?.path ? `${it.path}${it.line ? `:${it.line}` : ""}` : it?.author;
          return (
            <li key={dec.key}>
              <div className="finding-head">
                <Pill tone={dec.action === "fixed" ? "ok" : dec.action === "needs-human" ? "warn" : "accent"}>{t.t(`decision.${dec.action}`)}</Pill>
                <span className="mono">{where}</span>
                <span className="muted small">{it?.author}</span>
              </div>
              <p className="muted small quote">{plain(it?.text ?? "")}</p>
              {dec.reply && <p className="body reply"><Inline text={dec.reply} /></p>}
            </li>
          );
        })}
      </ul>
      {p.changed.length > 0 && (
        <p>
          <strong>{t.t("inbox.changed", { files: "" })}</strong> <span className="mono">{p.changed.join(", ")}</span>
        </p>
      )}
      {p.validation.map((v) => (
        <p key={v.command} className={v.ok ? "ok-text" : "bad-text"}>
          {v.ok ? "✓" : "✗"} <span className="mono">{v.command}</span>
        </p>
      ))}
      {d.diff && <DiffView diff={d.diff} />}
    </>
  );
}

export function InboxPage({ version }: { version: number }) {
  const t = useT();
  const [items, setItems] = useState<InboxItem[] | undefined>();
  // `#/inbox?item=r12` (the menu bar's Open) selects that item.
  const fromHash = () => /[?&]item=([rf]\d+)/.exec(location.hash)?.[1];
  const [selected, setSelected] = useState<string | undefined>(fromHash);
  useEffect(() => {
    const on = () => {
      const id = fromHash();
      if (id) setSelected(id);
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const [detail, setDetail] = useState<InboxDetail | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | undefined>();

  useEffect(() => {
    api.get<InboxItem[]>("/api/inbox").then((list) => {
      setItems(list);
      if (selected && !list.some((i) => i.id === selected)) setSelected(undefined);
      if (!selected && list[0]) setSelected(list[0].id);
    }, () => setItems([]));
  }, [version]);

  useEffect(() => {
    setDetail(undefined);
    if (selected) api.get<InboxDetail>(`/api/inbox/${selected}`).then(setDetail, () => {});
  }, [selected]);

  const act = async (action: "approve" | "discard") => {
    if (!selected) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const r = await api.post<any>(`/api/inbox/${selected}/${action}`);
      if (action === "approve" && typeof r.error === "string") {
        setDetail((current) => current?.kind === "fix" ? { ...current, row: { ...current.row, error: r.error } } : current);
      }
      const ok = action === "discard" ? r.ok : r.kind === "posted" || r.kind === "done";
      const text =
        action === "discard"
          ? t.t("inbox.discarded", { id: selected })
          : r.kind === "posted" || r.kind === "done"
            ? t.t("web.inbox.published")
            : r.kind === "stale"
              ? t.t("web.inbox.stale")
              : t.t("web.inbox.failed", { error: String(r.error ?? r.kind) });
      setMessage({ tone: ok ? "ok" : "bad", text });
      const list = await api.get<InboxItem[]>("/api/inbox");
      setItems(list);
      setSelected(list[0]?.id);
    } catch (e) {
      setMessage({ tone: "bad", text: t.t("web.inbox.failed", { error: (e as Error).message }) });
    } finally {
      setBusy(false);
    }
  };

  const current = items?.find((i) => i.id === selected);
  return (
    <>
      <header className="page-head">
        <h1>{t.t("web.nav.inbox")}</h1>
      </header>
      {message && <p className={`notice ${message.tone}`}>{message.text}</p>}
      {items && items.length === 0 ? (
        <Card>
          <Empty>{t.t("web.inbox.empty")}</Empty>
        </Card>
      ) : (
        <div className="split">
          <Card className="list">
            <ul className="items">
              {(items ?? []).map((i) => (
                <li key={i.id}>
                  <button className={i.id === selected ? "item on" : "item"} onClick={() => setSelected(i.id)}>
                    <span className="item-top">
                      <Pill tone={i.kind === "review" ? "accent" : "live"}>{i.kind === "review" ? t.t("inbox.kind.review") : t.t("inbox.kind.fix")}</Pill>
                      <span className="mono small">
                        {i.repo}#{i.number}
                      </span>
                    </span>
                    <span className="item-title">{i.title}</span>
                    <span className="muted small">
                      {i.kind === "review" ? `${i.event ? t.t(`verdict.${i.event}` as never) : ""} · ${t.tp("local.findingsCount", i.findings ?? 0)}` : t.t("inbox.fixSummary", { fixed: i.fixed ?? 0, replies: i.replies ?? 0 })} ·{" "}
                      {relative(t, i.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <Card
            className="detail"
            title={current ? `${current.repo}#${current.number} · ${current.title}` : undefined}
            actions={
              current && (
                <>
                  <ExternalLink href={current.url}>{t.t("web.openOnHost")}</ExternalLink>
                  <button className="btn ghost" disabled={busy} onClick={() => act("discard")}>
                    {t.t("web.discard")}
                  </button>
                  <button className="btn primary" disabled={busy} onClick={() => act("approve")}>
                    {current.kind === "review" ? t.t("web.approveReview") : detail?.kind === "fix" && detail.row.error ? t.t("web.inbox.retryFix") : t.t("web.approveFix")}
                  </button>
                </>
              )
            }
          >
            {!detail ? <Empty>{t.t("web.loading")}</Empty> : detail.kind === "review" ? <ReviewDetail d={detail} /> : <FixDetail d={detail} />}
          </Card>
        </div>
      )}
    </>
  );
}
