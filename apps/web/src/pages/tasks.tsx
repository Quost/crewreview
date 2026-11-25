import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, unreachable, type Repo, type TaskInfo } from "../api.ts";
import { relative, useT } from "../i18n.ts";
import { Card, Empty, ExternalLink, Pill, SectionHead } from "../ui.tsx";

type Tone = "ok" | "warn" | "bad" | "live" | "accent" | undefined;

export function stageTone(stage: TaskInfo["stage"]): Tone {
  if (stage === "approval" || stage === "ready") return "warn";
  if (stage === "done") return "ok";
  if (stage === "failed") return "bad";
  if (stage === "cancelled") return undefined;
  return "live";
}

const MARK = { todo: "○", doing: "◐", done: "●", blocked: "!" } as const;

export function TasksPage({ version }: { version: number }) {
  const t = useT();
  const [tasks, setTasks] = useState<TaskInfo[] | undefined>();
  const [selected, setSelected] = useState<string>();
  const [current, setCurrent] = useState<TaskInfo>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string }>();

  useEffect(() => {
    api.get<TaskInfo[]>("/api/tasks").then(
      (list) => {
        setTasks(list);
        setSelected((s) => s ?? list[0]?.id);
      },
      () => setTasks([]),
    );
  }, [version]);
  useEffect(() => {
    if (!selected) return setCurrent(undefined);
    api.get<TaskInfo>(`/api/tasks/${selected}`).then(setCurrent, () => setCurrent(undefined));
  }, [selected, version]);

  const act = async (action: "approve" | "cancel" | "run") => {
    if (!current) return;
    if (action === "cancel" && !confirm(t.t("web.tasks.confirmCancel"))) return;
    setBusy(true);
    setMessage(undefined);
    try {
      setCurrent(await api.post<TaskInfo>(`/api/tasks/${current.id}/${action}`));
    } catch (err) {
      setMessage({ tone: "bad", text: unreachable(err) ? t.t("web.setup.unreachable") : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const needsYou = (s: TaskInfo["stage"]) => s === "approval" || s === "ready";
  return (
    <>
      <SectionHead title={t.t("web.nav.tasks")} />
      <p className="muted lead">{t.t("web.tasks.intro")}</p>
      <NewTask onCreated={(id) => (setSelected(id), setMessage({ tone: "ok", text: t.t("web.tasks.started") }))} />
      {message && <p className={`notice ${message.tone}`}>{message.text}</p>}
      {tasks && tasks.length > 0 && (
        <div className="split">
          <Card className="list">
            <ul className="items">
              {tasks.map((k) => {
                const steps = k.plan?.steps ?? [];
                return (
                  <li key={k.id}>
                    <button className={k.id === selected ? "item on" : "item"} onClick={() => setSelected(k.id)}>
                      <span className="item-top">
                        <Pill tone={stageTone(k.stage)}>{t.t(`task.stage.${k.stage}` as never)}</Pill>
                        <span className="mono small">{k.repo}</span>
                      </span>
                      <span className="item-title">{k.plan?.title ?? k.text.split("\n")[0]}</span>
                      <span className="muted small">
                        {steps.length ? `${t.t("web.tasks.steps", { done: steps.filter((s) => s.status === "done").length, total: steps.length })} · ` : ""}
                        {relative(t, k.updatedAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
          <Card
            className="detail"
            title={current ? (current.plan?.title ?? current.text.split("\n")[0]) : undefined}
            actions={
              current && (
                <>
                  {current.pr && <ExternalLink href={current.pr.url}>{t.t("web.tasks.openPr")}</ExternalLink>}
                  {!["done", "cancelled"].includes(current.stage) && (
                    <button className="btn ghost danger" disabled={busy} onClick={() => act("cancel")}>
                      {t.t("web.tasks.cancel")}
                    </button>
                  )}
                  {["planning", "building", "reviewing", "opening"].includes(current.stage) && (
                    <button className="btn ghost" disabled={busy} onClick={() => act("run")}>
                      {t.t("web.tasks.run")}
                    </button>
                  )}
                  {needsYou(current.stage) && (
                    <button className="btn primary" disabled={busy} onClick={() => act("approve")}>
                      {current.stage === "approval" ? t.t("web.tasks.approvePlan") : t.t("web.tasks.approveOpen")}
                    </button>
                  )}
                </>
              )
            }
          >
            {!current ? <Empty>{t.t("web.loading")}</Empty> : <TaskDetail k={current} />}
          </Card>
        </div>
      )}
    </>
  );
}

function TaskDetail({ k }: { k: TaskInfo }) {
  const t = useT();
  return (
    <div className="task">
      <p>{k.text}</p>
      <p className="muted small mono">
        {k.repo} · {k.branch} → {k.base} · {t.t(`web.tasks.as.${k.as ?? "you"}` as never)} · {t.t(`web.tasks.mode.${k.mode}` as never)}
      </p>
      <p>
        <Pill tone={stageTone(k.stage)}>{t.t(`task.stage.${k.stage}` as never)}</Pill>
        {k.waitingUntil && k.waitingUntil > Date.now() && <span className="muted small"> {t.t("web.tasks.waiting", { when: new Date(k.waitingUntil).toLocaleTimeString(t.locale, { hour: "2-digit", minute: "2-digit" }) })}</span>}
      </p>
      {k.error && <p className="notice bad">{k.error}</p>}
      {k.stage === "approval" && <p className="notice warn">{t.t("web.tasks.approvalHint")}</p>}
      {k.stage === "ready" && <p className="notice warn">{t.t("web.tasks.readyHint", { branch: k.branch })}</p>}
      {k.plan && (
        <>
          <h3>{t.t("web.tasks.plan")}</h3>
          <p>{k.plan.summary}</p>
          <ul className="steps">
            {k.plan.steps.map((s) => (
              <li key={s.id} className={`step-${s.status}`}>
                <span className="mark" aria-label={s.status}>{MARK[s.status]}</span>
                <div>
                  <strong>{s.title}</strong>
                  {s.detail && <p className="small">{s.detail}</p>}
                  {s.files.length > 0 && <p className="muted small mono">{s.files.join(", ")}</p>}
                </div>
              </li>
            ))}
          </ul>
          {k.plan.risks.length > 0 && (
            <>
              <h3>{t.t("web.tasks.risks")}</h3>
              <ul className="small">
                {k.plan.risks.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {k.lastReview && (
        <>
          <h3>{t.t("web.tasks.selfReview")}</h3>
          <p className="small">{t.t("web.tasks.reviewSummary", { findings: k.lastReview.findings, blocking: k.lastReview.blocking, rounds: k.reviewRounds })}</p>
          {k.lastReview.items && k.lastReview.items.length > 0 && (
            <ul className="small">
              {k.lastReview.items.map((f) => (
                <li key={`${f.path}:${f.line}:${f.title}`}>
                  <Pill>{t.t(`severity.${f.severity}` as never)}</Pill> <span className="mono">{`${f.path}:${f.line}`}</span> {f.title}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {k.handoffs.length > 0 && (
        <>
          <h3>{t.t("web.tasks.handoffs")}</h3>
          <ol className="handoffs">
            {[...k.handoffs].reverse().map((h) => (
              <li key={h.n}>
                <span className="muted small mono">#{h.n} · {t.t(`task.role.${h.role}` as never)} · {h.seat} · {relative(t, h.at)}</span>
                {h.cut && <p className="notice warn small">{t.t("web.tasks.cut", { reason: h.cut })}</p>}
                {h.done.length > 0 && <p className="small">{t.t("web.tasks.handoffDone", { steps: h.done.join(", ") })}</p>}
                {h.next && <p className="small">{t.t("web.tasks.handoffNext", { next: h.next })}</p>}
                {h.blockers.length > 0 && <p className="small bad-text">{t.t("web.tasks.handoffBlocked", { blockers: h.blockers.join("; ") })}</p>}
              </li>
            ))}
          </ol>
        </>
      )}
      <p className="muted small">{t.t("web.tasks.ledger", { id: k.id })}</p>
    </div>
  );
}

function NewTask({ onCreated }: { onCreated: (id: string) => void }) {
  const t = useT();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repo, setRepo] = useState("");
  const [text, setText] = useState("");
  const [as, setAs] = useState<"you" | "crew">("you");
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    api.get<Repo[]>("/api/repos").then((rs) => {
      const own = rs.filter((r) => r.scope !== "org");
      setRepos(own);
      setRepo((r) => r || own[0]?.id || "");
    }, () => {});
  }, []);
  const chosen = repos.find((r) => r.id === repo);
  useEffect(() => setAs(chosen?.review.account ? "crew" : "you"), [chosen?.review.account]);
  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (!repo || !text.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.post<{ id: string }>("/api/tasks", { repo, text: text.trim(), mode: auto ? "auto" : "inbox", as });
      setText("");
      onCreated(r.id);
    } catch (err) {
      const code = err instanceof ApiError ? err.body?.error : "";
      setError(unreachable(err) ? t.t("web.setup.unreachable") : code === "no-token" ? t.t("web.log.noToken") : t.t(`web.tasks.err.${code || "failed"}` as never));
    } finally {
      setBusy(false);
    }
  };
  if (repos.length === 0)
    return (
      <Card title={t.t("web.tasks.new")}>
        <p className="muted small">
          {t.t("web.tasks.noRepos")} <a href="#/repos">{t.t("web.nav.repos")}</a>
        </p>
      </Card>
    );
  return (
    <Card title={t.t("web.tasks.new")}>
      <form className="new-task" onSubmit={start}>
        <label>
          <span className="small muted">{t.t("web.tasks.repo")}</span>
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>{r.id}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="small muted">{t.t("web.tasks.what")}</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={t.t("web.tasks.placeholder")} />
        </label>
        <fieldset>
          <legend className="small muted">{t.t("web.tasks.who")}</legend>
          <label className="pick">
            <input type="radio" name="as" checked={as === "you"} onChange={() => setAs("you")} />
            {t.t("web.tasks.asYou")}
          </label>
          <label className="pick">
            <input type="radio" name="as" checked={as === "crew"} disabled={!chosen?.review.account} onChange={() => setAs("crew")} />
            {chosen?.review.account ? t.t("web.tasks.asCrew", { account: chosen.review.account.replace(/^keychain:[^/]+\//, "") }) : t.t("web.tasks.asCrewNone")}
          </label>
          {!chosen?.review.account && (
            <p className="muted small">
              {t.t("web.tasks.asCrewHint")} <a href="#/account">{t.t("web.account.setupLink")}</a>
            </p>
          )}
        </fieldset>
        <label className="pick">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          {t.t("web.tasks.auto")}
        </label>
        <div className="row">
          <button className="btn primary" disabled={busy || !text.trim()}>{t.t("web.tasks.start")}</button>
        </div>
        {error && <p className="notice bad">{error}</p>}
      </form>
    </Card>
  );
}
