import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, unreachable, type Repo } from "../api.ts";
import { useT } from "../i18n.ts";
import { Card, Empty, ExternalLink, Pill } from "../ui.tsx";

type SignIn =
  | { state: "idle" }
  | { state: "waiting"; login: string; code: string; url: string }
  | { state: "done"; login: string; restoredTo?: string }
  | { state: "failed"; login: string; error: string; who?: string; detail?: string; restoredTo?: string };

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <Card
      className="step"
      title={
        <>
          <span className={`step-n ${done ? "done" : ""}`} aria-hidden="true">
            {done ? "✓" : n}
          </span>
          {title}
        </>
      }
    >
      {children}
    </Card>
  );
}

/**
 * A second account to post reviews as, step by step: GitHub won't let you approve your own pull requests. You create
 * the account and type one code; the crew checks it, invites it, signs it in to gh, accepts the invitations and
 * points the repositories at it.
 */
export function AccountPage() {
  const t = useT();
  const [repos, setRepos] = useState<Repo[] | undefined>();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [login, setLogin] = useState("");
  const [found, setFound] = useState<{ ok?: string; bad?: string }>({});
  const [invites, setInvites] = useState<{ id: string; result?: string; error?: string }[] | undefined>();
  const [signIn, setSignIn] = useState<SignIn>({ state: "idle" });
  const [copied, setCopied] = useState(false);
  const [finished, setFinished] = useState<{ ok?: string[]; bad?: string[] }>({});
  const [reviewOwn, setReviewOwn] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Repo[]>("/api/repos").then(
      (rs) => {
        const gh = rs.filter((r) => r.kind === "github" && r.scope !== "org");
        setRepos(gh);
        setChosen(new Set(gh.map((r) => r.id)));
      },
      () => setRepos([]),
    );
    api.get<SignIn>("/api/account/signin").then(setSignIn, () => {});
  }, []);

  // While the code waits to be typed, follow the sign-in.
  useEffect(() => {
    if (signIn.state !== "waiting") return;
    const id = setInterval(() => api.get<SignIn>("/api/account/signin").then(setSignIn, () => {}), 2000);
    return () => clearInterval(id);
  }, [signIn.state]);

  const name = login.trim().replace(/^@/, "");
  const host = repos?.find((r) => chosen.has(r.id))?.host ?? "github.com";
  const selected = (repos ?? []).filter((r) => chosen.has(r.id)).map((r) => r.id);
  const problem = (err: unknown) => (unreachable(err) ? t.t("web.setup.unreachable") : err instanceof ApiError ? (err.body?.message ?? err.body?.error ?? err.message) : String(err));

  const check = async (e: FormEvent) => {
    e.preventDefault();
    if (!name) return;
    setFound({});
    try {
      const u = await api.get<{ login: string }>(`/api/account/user?login=${encodeURIComponent(name)}&host=${encodeURIComponent(host)}`);
      setLogin(u.login);
      setFound({ ok: t.t("web.account.found", { login: u.login }) });
    } catch (err) {
      const code = err instanceof ApiError ? err.body?.error : "";
      const same = code === "same-account" ? t.t("account.error.same-account", { name: err instanceof ApiError ? (err.body?.name ?? name) : name }) : undefined;
      setFound({ bad: same ?? (code === "not-found" ? t.t("web.account.notFound", { login: name }) : code === "bad-name" ? t.t("web.account.badName") : code === "no-token" ? t.t("web.log.noToken") : problem(err)) });
    }
  };
  const invite = async () => {
    setBusy(true);
    try {
      setInvites(await api.post("/api/account/invite", { login: name, repos: selected }));
    } catch (err) {
      setInvites([{ id: "", error: problem(err) }]);
    } finally {
      setBusy(false);
    }
  };
  const startSignIn = async () => {
    setBusy(true);
    setCopied(false);
    try {
      setSignIn(await api.post<SignIn>("/api/account/signin", { login: name, host }));
    } catch (err) {
      setSignIn({ state: "failed", login: name, error: "failed", detail: problem(err) });
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => api.del("/api/account/signin").then(() => setSignIn({ state: "idle" }), () => {});
  const finish = async () => {
    setBusy(true);
    const ok: string[] = [];
    const bad: string[] = [];
    try {
      const r = await api.post<{ accepted: string[] }>("/api/account/accept", { login: name, repos: selected });
      ok.push(t.t("web.account.accepted", { count: r.accepted.length }));
    } catch (err) {
      const b = err instanceof ApiError ? err.body : undefined;
      // Already accepted, or nothing to accept: say why, and go on to use the account.
      bad.push(b?.error && b.error !== "host" && b.error !== "none" ? t.t(`account.error.${b.error}` as never, { name: b.name ?? name, message: b.message ?? "" }) : problem(err));
    }
    let using = 0;
    for (const id of selected) {
      const r = repos!.find((x) => x.id === id)!;
      try {
        const authors = reviewOwn && r.review.authors === "others" ? { authors: "all" } : {};
        await api.patch(`/api/repos/${id}`, { review: { account: name, ...authors } });
        using++;
      } catch (err) {
        const b = err instanceof ApiError ? err.body : undefined;
        bad.push(`${id}: ${b?.problem ? t.t(`account.error.${b.problem}` as never, { name: b.name ?? name, message: b.message ?? "" }) : problem(err)}`);
      }
    }
    if (using) ok.push(t.t("web.account.done", { login: name, count: using }));
    setFinished({ ok, bad });
    setBusy(false);
  };

  const signInError = (s: Extract<SignIn, { state: "failed" }>) =>
    t.t(`web.account.err.${s.error}` as never, { detail: s.detail ?? "", who: s.who ? `@${s.who}` : "?", login: s.login });

  return (
    <>
      <header className="page-head">
        <h1>{t.t("web.account.title")}</h1>
      </header>
      <p className="muted lead">{t.t("web.account.intro")}</p>

      <Step n={1} title={t.t("web.account.s1")} done={!!found.ok}>
        <p className="muted small">{t.t("web.account.s1Hint")}</p>
        <div className="row">
          <a className="btn ghost" href="https://github.com/signup" target="_blank" rel="noreferrer noopener">
            {t.t("web.account.openSignup")}
          </a>
          <code>github.com/signup</code>
        </div>
        <form className="add" onSubmit={check}>
          <input value={login} onChange={(e) => (setLogin(e.target.value), setFound({}))} placeholder="acme-crew" aria-label={t.t("web.account.username")} spellCheck={false} autoCapitalize="off" />
          <button className="btn primary" disabled={!name}>
            {t.t("web.account.check")}
          </button>
        </form>
        {found.ok && <p className="notice ok">{found.ok}</p>}
        {found.bad && <p className="notice warn">{found.bad}</p>}
      </Step>

      <Step n={2} title={t.t("web.account.s2")} done={!!invites?.length && invites.every((i) => i.result)}>
        <p className="muted small">{t.t("web.account.s2Hint")}</p>
        {!repos ? (
          <Empty>{t.t("web.loading")}</Empty>
        ) : repos.length === 0 ? (
          <p className="notice warn">
            {t.t("web.account.noRepos")} <a href="#/repos">{t.t("web.nav.repos")}</a>
          </p>
        ) : (
          <ul className="checklist">
            {repos.map((r) => {
              const res = invites?.find((i) => i.id === r.id);
              return (
                <li key={r.id}>
                  <label className="pick">
                    <input type="checkbox" checked={chosen.has(r.id)} onChange={(e) => setChosen((s) => (e.target.checked ? new Set([...s, r.id]) : new Set([...s].filter((x) => x !== r.id))))} />
                    <ExternalLink href={r.webUrl}>{r.webUrl.replace(/^https:\/\//, "")}</ExternalLink>
                  </label>
                  <span className="check-state">
                    {r.review.account && <Pill tone="accent">@{r.review.account}</Pill>}
                    {res?.result === "invited" && <Pill tone="ok">{t.t("web.account.invited")}</Pill>}
                    {res?.result === "already" && <Pill tone="ok">{t.t("web.account.already")}</Pill>}
                    {res?.error && <span className="bad-text small">{res.error}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {invites?.some((i) => !i.id && i.error) && <p className="notice bad">{invites.find((i) => !i.id)!.error}</p>}
        <div className="row">
          <button className="btn primary" onClick={invite} disabled={busy || !found.ok || selected.length === 0}>
            {t.t("web.account.invite")}
          </button>
        </div>
      </Step>

      <Step n={3} title={t.t("web.account.s3")} done={signIn.state === "done"}>
        <p className="muted small">{t.t("web.account.s3Hint")}</p>
        {signIn.state === "waiting" ? (
          <div className="device">
            <span className="muted small">{t.t("web.account.code")}</span>
            <code className="device-code">{signIn.code}</code>
            <div className="row">
              <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(signIn.code).then(() => setCopied(true), () => {})}>
                {copied ? t.t("web.account.copied") : t.t("web.account.copy")}
              </button>
              <ExternalLink href={signIn.url}>{signIn.url.replace(/^https:\/\//, "")}</ExternalLink>
            </div>
            <p className="muted small">{t.t("web.account.waiting")}</p>
            <div className="row">
              <button className="btn ghost danger" onClick={cancel}>
                {t.t("web.account.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button className="btn primary" onClick={startSignIn} disabled={busy || !found.ok}>
              {t.t("web.account.start")}
            </button>
          </div>
        )}
        {signIn.state === "done" && (
          <p className="notice ok">
            {t.t("web.account.signedIn", { login: signIn.login })}
            {signIn.restoredTo ? ` ${t.t("web.account.restored", { user: signIn.restoredTo })}` : ""}
          </p>
        )}
        {signIn.state === "failed" && (
          <p className="notice bad">
            {signInError(signIn)}
            {signIn.restoredTo ? ` ${t.t("web.account.restored", { user: signIn.restoredTo })}` : ""}
          </p>
        )}
      </Step>

      <Step n={4} title={t.t("web.account.s4")} done={!!finished.ok?.length && !finished.bad?.length}>
        <p className="muted small">{t.t("web.account.s4Hint")}</p>
        <label className="pick">
          <input type="checkbox" checked={reviewOwn} onChange={(e) => setReviewOwn(e.target.checked)} />
          {t.t("web.account.reviewOwn")}
        </label>
        <div className="row">
          <button className="btn primary" onClick={finish} disabled={busy || signIn.state !== "done" || selected.length === 0}>
            {t.t("web.account.finish", { login: name || "…" })}
          </button>
        </div>
        {finished.ok?.map((m) => (
          <p key={m} className="notice ok">
            {m}
          </p>
        ))}
        {finished.bad?.map((m) => (
          <p key={m} className="notice warn">
            {m}
          </p>
        ))}
      </Step>
    </>
  );
}
