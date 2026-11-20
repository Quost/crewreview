import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Preview, type Repo } from "../api.ts";
import { useT } from "../i18n.ts";
import { Card, Empty, ExternalLink, Segmented, Toggle, Pill } from "../ui.tsx";

type Mode = Repo["review"]["mode"];

export function ReposPage({ version }: { version: number }) {
  const t = useT();
  const [repos, setRepos] = useState<Repo[] | undefined>();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [previews, setPreviews] = useState<Record<string, Preview | "loading" | { failed: string }>>({});
  const preview = async (id: string) => {
    setPreviews((p) => ({ ...p, [id]: "loading" }));
    try {
      const pv = await api.get<Preview>(`/api/repos/${id}/preview`);
      setPreviews((p) => ({ ...p, [id]: pv }));
    } catch (err) {
      setPreviews((p) => ({ ...p, [id]: { failed: err instanceof ApiError ? (err.body?.message ?? err.message) : String(err) } }));
    }
  };
  const load = () => api.get<Repo[]>("/api/repos").then(setRepos, () => setRepos([]));
  useEffect(() => {
    load();
  }, [version]);

  const modes = (label: (m: Mode) => string) => (["off", "inbox", "auto"] as Mode[]).map((m) => ({ value: m, label: label(m) }));
  const patch = async (id: string, body: unknown) => {
    setRepos((rs) => rs?.map((r) => (r.id === id ? deepMerge(r, body) : r)));
    try {
      await api.patch(`/api/repos/${id}`, body);
    } catch {
      load();
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.post("/api/repos", { url: url.trim() });
      setUrl("");
      load();
    } catch (err) {
      const code = err instanceof ApiError ? err.body?.error : "";
      setError(code === "exists" ? t.t("web.repos.exists") : code === "no-token" ? t.t("web.log.noToken") : t.t("web.repos.addFailed", { error: err instanceof ApiError ? (err.body?.message ?? code) : String(err) }));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    if (!confirm(t.t("web.repos.confirmRemove", { id }))) return;
    await api.del(`/api/repos/${id}`).catch(() => {});
    load();
  };

  return (
    <>
      <header className="page-head">
        <h1>{t.t("web.nav.repos")}</h1>
        <a className="btn ghost" href="#/setup">
          {t.t("web.repos.setup")}
        </a>
      </header>
      <Card title={t.t("web.repos.add")}>
        <form className="add" onSubmit={add}>
          <input type="url" required placeholder="https://github.com/owner/repo · https://github.com/org" value={url} onChange={(e) => setUrl(e.target.value)} aria-label={t.t("repo.col.url")} />
          <button className="btn primary" disabled={busy}>
            {t.t("web.repos.addButton")}
          </button>
        </form>
        <p className="muted small">{t.t("web.repos.addHint")}</p>
        {error && <p className="notice bad">{error}</p>}
      </Card>
      {repos && repos.length === 0 && (
        <Card>
          <Empty>{t.t("repo.none")}</Empty>
        </Card>
      )}
      {(repos ?? []).map((r) => (
        <Card
          key={r.id}
          title={
            <>
              {r.id} {r.scope === "org" && <Pill tone="accent">{t.t("repo.org")}</Pill>} <span className="muted small">{r.kind}</span>
            </>
          }
          actions={
            <>
              <button className="btn ghost" onClick={() => preview(r.id)} disabled={previews[r.id] === "loading"}>
                {t.t("web.repos.preview")}
              </button>
              <ExternalLink href={r.webUrl}>{t.t("web.openOnHost")}</ExternalLink>
              <button className="btn ghost danger" onClick={() => remove(r.id)}>
                {t.t("web.remove")}
              </button>
            </>
          }
        >
          {previews[r.id] && <PreviewBox value={previews[r.id]!} />}
          {r.scope === "org" && (
            <p className="muted small">
              {t.t("web.repos.orgHint")}
              {r.include?.length ? ` ${t.t("web.repos.orgOnly", { list: r.include.join(", ") })}` : ""}
              {r.exclude?.length ? ` ${t.t("web.repos.orgExcept", { list: r.exclude.join(", ") })}` : ""}
            </p>
          )}
          <div className="settings">
            <div className="setting">
              <div>
                <strong>{t.t("web.repos.review")}</strong>
                <p className="muted small">{t.t("web.repos.reviewHint")}</p>
              </div>
              <Segmented label={t.t("web.repos.review")} value={r.review.mode} options={modes((m) => t.t(`web.mode.${m}`))} onChange={(mode) => patch(r.id, { review: { mode } })} />
            </div>
            <div className="setting">
              <div>
                <strong>{t.t("web.repos.authors")}</strong>
              </div>
              <Segmented
                label={t.t("web.repos.authors")}
                value={r.review.authors}
                options={(["others", "all", "mine"] as const).map((a) => ({ value: a, label: t.t(`web.authors.${a}`) }))}
                onChange={(authors) => patch(r.id, { review: { authors } })}
              />
            </div>
            <div className="setting">
              <div>
                <strong>{t.t("web.repos.attend")}</strong>
                <p className="muted small">{t.t("web.repos.attendHint")}</p>
              </div>
              <Segmented label={t.t("web.repos.attend")} value={r.attend.mode} options={modes((m) => t.t(`web.mode.${m}`))} onChange={(mode) => patch(r.id, { attend: { mode } })} />
            </div>
            <div className="setting">
              <div>
                <strong>{t.t("web.repos.polish")}</strong>
                <p className="muted small">{t.t("web.repos.polishHint", { rounds: r.attend.maxPolishRounds })}</p>
              </div>
              <Toggle label={r.attend.fromCrew ? t.t("web.on") : t.t("web.off")} checked={r.attend.fromCrew} onChange={(fromCrew) => patch(r.id, { attend: { fromCrew } })} />
            </div>
            <div className="setting">
              <div>
                <strong>{t.t("web.repos.conflicts")}</strong>
                <p className="muted small">{t.t("web.repos.conflictsHint")}</p>
              </div>
              <Toggle label={r.attend.conflicts ? t.t("web.on") : t.t("web.off")} checked={r.attend.conflicts} onChange={(conflicts) => patch(r.id, { attend: { conflicts } })} />
            </div>
            <div className="setting">
              <div>
                <strong>{t.t("web.repos.ci")}</strong>
                <p className="muted small">{t.t("web.repos.ciHint")}</p>
              </div>
              <Toggle label={r.attend.ci ? t.t("web.on") : t.t("web.off")} checked={r.attend.ci} onChange={(ci) => patch(r.id, { attend: { ci } })} />
            </div>
          </div>
        </Card>
      ))}
    </>
  );
}

function deepMerge<T>(a: T, b: any): T {
  const out: any = Array.isArray(a) ? [...(a as any)] : { ...(a as any) };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(out[k] ?? {}, v) : v;
  return out;
}

export function PreviewBox({ value }: { value: Preview | "loading" | { failed: string } }) {
  const t = useT();
  if (value === "loading") return <p className="notice">{t.t("web.loading")}</p>;
  if ("failed" in value) return <p className="notice warn">{value.failed}</p>;
  const p = value;
  const skipped = Object.entries(p.skipped).map(([reason, n]) => `${t.t(`skip.${reason}` as never)} (${n})`);
  return (
    <div className="notice preview">
      <strong>{t.t("preview.title", { link: p.link, prs: p.pullRequests, repos: p.repos })}</strong>
      <p>{p.wouldReview.length ? t.t("preview.would", { count: p.wouldReview.length, perCycle: p.perCycle, runs: p.agentRuns }) : t.t("preview.none")}</p>
      {p.wouldReview.length > 0 && (
        <ul className="small">
          {p.wouldReview.slice(0, 10).map((w) => (
            <li key={w.url}>
              <a href={w.url} target="_blank" rel="noreferrer noopener" className="mono">
                {w.repo}#{w.number}
              </a>{" "}
              <span className="muted">{w.title}</span>
            </li>
          ))}
        </ul>
      )}
      {skipped.length > 0 && <p className="muted small">{t.t("preview.skipped", { list: skipped.join(", ") })}</p>}
      {p.ownOpen > 0 && <p className="muted small">{t.t("preview.own", { count: p.ownOpen })}</p>}
      {p.budget && <p className="muted small">{t.t("preview.budget", { used: p.budget.used, limit: p.budget.limit })}</p>}
      {p.errors.map((e) => (
        <p key={e.repo} className="bad-text small">
          {t.t("preview.error", { repo: e.repo, error: e.error === "no-token" ? t.t("web.log.noToken") : e.error })}
        </p>
      ))}
      <p className="muted small">{t.t("preview.note")}</p>
    </div>
  );
}
