import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, unreachable, type Repo } from "../api.ts";
import { useT } from "../i18n.ts";
import { Card, Empty, ExternalLink, Pill, SectionHead } from "../ui.tsx";

type SignIn =
  | { state: "idle" }
  | { state: "waiting"; login: string; code: string; url: string }
  | { state: "done"; login: string; restoredTo?: string }
  | { state: "failed"; login: string; error: string; who?: string; detail?: string; restoredTo?: string };

type Reach = "admin" | "write" | "read" | "none" | "error";
type Saved = { user: string; account: string; reach: { id: string; permission: Reach; message?: string }[]; accepted: string[]; applied: string[] };

export const accountLabel = (account: string) => account.replace(/^keychain:[^/]+\//, "");

const hostKey = (r: Repo) => `${r.kind}:${r.host.toLowerCase()}`;
const pathOf = (r: Repo) => new URL(r.webUrl).pathname.replace(/^\/+|\/+$/g, "");

export function tokenPages(r: Repo): { place?: string; personal: string } {
  const base = `https://${r.host}`;
  if (r.kind === "github") return { personal: `${base}/settings/tokens/new?scopes=repo&description=Crewreview` };
  const path = pathOf(r);
  return {
    place: r.scope === "org" ? `${base}/groups/${path}/-/settings/access_tokens` : `${base}/${path}/-/settings/access_tokens`,
    personal: `${base}/-/user_settings/personal_access_tokens?name=Crewreview&scopes=api`,
  };
}

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

function LinkForm({ onLinked, compact }: { onLinked: (id: string) => void; compact?: boolean }) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const link = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.post<{ id: string }>("/api/repos", { url: url.trim(), mode: "inbox" });
      setUrl("");
      onLinked(r.id);
    } catch (err) {
      const code = err instanceof ApiError ? err.body?.error : "";
      setError(
        unreachable(err)
          ? t.t("web.setup.unreachable")
          : code === "exists"
            ? t.t("web.repos.exists")
            : code === "no-token"
              ? t.t("web.log.noToken")
              : t.t("web.repos.addFailed", { error: err instanceof ApiError ? (err.body?.message ?? code) : String(err) }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <form className="add" onSubmit={link}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} type="url" placeholder="https://github.com/owner/repo · https://gitlab.com/group" aria-label={t.t("repo.col.url")} spellCheck={false} autoCapitalize="off" />
        <button className={`btn ${compact ? "ghost" : "primary"}`} disabled={busy || !url.trim()}>
          {compact ? t.t("web.account.linkAnother") : t.t("web.account.link")}
        </button>
      </form>
      {error && <p className="notice bad">{error}</p>}
    </>
  );
}

function TokenForm({ ids, reviewOwnLabel, onSaved }: { ids: string[]; reviewOwnLabel: string; onSaved: (s: Saved) => void }) {
  const t = useT();
  const [token, setToken] = useState("");
  const [reviewOwn, setReviewOwn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.post<Saved>("/api/account/token", { repos: ids, token: token.trim(), reviewOwn });
      setToken("");
      onSaved(r);
    } catch (err) {
      const b = err instanceof ApiError ? err.body : undefined;
      setError(
        unreachable(err)
          ? t.t("web.setup.unreachable")
          : b?.error === "same-account"
            ? t.t("account.error.same-account", { name: b.name ?? "" })
            : b?.error === "host"
              ? t.t("web.account.err.tokenRefused", { message: b.message ?? "" })
              : b?.error === "keychain"
                ? t.t("web.account.err.keychain", { message: b.message ?? "" })
                : b?.error === "none"
                  ? t.t("web.account.err.pickOne")
                  : String(err),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="token-form" onSubmit={save}>
      <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t.t("web.account.tokenLabel")} aria-label={t.t("web.account.tokenLabel")} autoComplete="off" spellCheck={false} />
      <label className="pick">
        <input type="checkbox" checked={reviewOwn} onChange={(e) => setReviewOwn(e.target.checked)} />
        {reviewOwnLabel}
      </label>
      <div className="row">
        <button className="btn primary" disabled={busy || !token.trim() || ids.length === 0}>
          {busy ? t.t("web.account.checking") : t.t("web.account.use")}
        </button>
      </div>
      {ids.length === 0 && <p className="muted small">{t.t("web.account.err.pickOne")}</p>}
      {error && <p className="notice bad">{error}</p>}
    </form>
  );
}

function SavedNotice({ saved, repos }: { saved: Saved; repos: Repo[] }) {
  const t = useT();
  return (
    <>
      {saved.applied.length > 0 ? (
        <p className="notice ok">{t.tp("web.account.usedAs", saved.applied.length, { user: saved.user })}</p>
      ) : (
        <p className="notice bad">{t.t("web.account.usedNowhere", { user: saved.user })}</p>
      )}
      {saved.accepted.length > 0 && <p className="muted small">{t.t("web.account.accepted", { count: saved.accepted.length })}</p>}
      <ul className="checklist">
        {saved.reach.map((w) => {
          const r = repos.find((x) => x.id === w.id);
          const tone = w.permission === "write" || w.permission === "admin" ? "ok" : w.permission === "read" ? "warn" : "bad";
          return (
            <li key={w.id}>
              <span>{r ? pathOf(r) : w.id}</span>
              <Pill tone={tone}>{t.t(`web.account.reach.${w.permission}` as never, { message: w.message ?? "" })}</Pill>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function AccountPage() {
  const t = useT();
  const [repos, setRepos] = useState<Repo[] | undefined>();
  const [host, setHost] = useState<string>();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Saved>();

  const load = (pick?: string) =>
    api.get<Repo[]>("/api/repos").then(
      (rs) => {
        setRepos(rs);
        const just = pick ? rs.find((r) => r.id === pick) : undefined;
        const h = just ? hostKey(just) : (host ?? (rs[0] ? hostKey(rs[0]) : undefined));
        setHost(h);
        setChosen((prev) => {
          if (just) return new Set([...[...prev].filter((id) => rs.find((r) => r.id === id && hostKey(r) === h)), just.id]);
          return prev.size ? prev : new Set(rs.filter((r) => hostKey(r) === h).map((r) => r.id));
        });
      },
      () => setRepos([]),
    );
  useEffect(() => void load(), []);

  const hosts = [...new Set((repos ?? []).map(hostKey))];
  const here = (repos ?? []).filter((r) => hostKey(r) === host);
  const selected = here.filter((r) => chosen.has(r.id));
  const kind = here[0]?.kind;
  const pickHost = (h: string) => {
    setHost(h);
    setChosen(new Set((repos ?? []).filter((r) => hostKey(r) === h).map((r) => r.id)));
    setSaved(undefined);
  };

  return (
    <>
      <SectionHead title={t.t("web.account.title")} />
      <p className="muted lead">{t.t("web.account.intro")}</p>

      <Step n={1} title={t.t("web.account.where")} done={selected.length > 0}>
        {!repos ? (
          <Empty>{t.t("web.loading")}</Empty>
        ) : repos.length === 0 ? (
          <>
            <p className="muted small">{t.t("web.account.nothingLinked")}</p>
            <LinkForm onLinked={(id) => load(id)} />
          </>
        ) : (
          <>
            <p className="muted small">{t.t("web.account.whereHint")}</p>
            {hosts.length > 1 && (
              <div className="segmented" role="tablist">
                {hosts.map((h) => (
                  <button key={h} role="tab" aria-selected={h === host} className={h === host ? "on" : ""} onClick={() => pickHost(h)}>
                    {h.split(":")[1]}
                  </button>
                ))}
              </div>
            )}
            <ul className="checklist">
              {here.map((r) => (
                <li key={r.id}>
                  <label className="pick">
                    <input type="checkbox" checked={chosen.has(r.id)} onChange={(e) => (setChosen((s) => (e.target.checked ? new Set([...s, r.id]) : new Set([...s].filter((x) => x !== r.id)))), setSaved(undefined))} />
                    <ExternalLink href={r.webUrl}>{r.webUrl.replace(/^https:\/\//, "")}</ExternalLink>
                  </label>
                  <span className="check-state">
                    {r.scope === "org" && <Pill tone="accent">{t.t(r.kind === "gitlab" ? "repo.group" : "repo.org")}</Pill>}
                    {r.review.account && <Pill tone="accent">@{accountLabel(r.review.account)}</Pill>}
                  </span>
                </li>
              ))}
            </ul>
            <LinkForm compact onLinked={(id) => load(id)} />
          </>
        )}
      </Step>

      {repos && repos.length > 0 && (kind === "gitlab" ? <GitLabSteps selected={selected} repos={repos} saved={saved} onSaved={(s) => (setSaved(s), load())} /> : <GitHubSteps selected={selected} repos={repos} saved={saved} onSaved={(s) => (setSaved(s), load())} onChanged={() => load()} />)}
    </>
  );
}

function GitLabSteps({ selected, repos, saved, onSaved }: { selected: Repo[]; repos: Repo[]; saved?: Saved; onSaved: (s: Saved) => void }) {
  const t = useT();
  const first = selected[0];
  const groups = selected.filter((r) => r.scope === "org").map((r) => `${pathOf(r)}/`);
  const pages = selected.filter((r) => !groups.some((g) => `${pathOf(r)}/`.startsWith(g) && `${pathOf(r)}/` !== g));
  return (
    <>
      <Step n={2} title={t.t("web.account.gl.s2")}>
        <p className="muted small">{t.t("web.account.gl.s2Hint")}</p>
        {selected.length === 0 ? (
          <p className="muted small">{t.t("web.account.err.pickOne")}</p>
        ) : (
          <div className="row wrap">
            {pages.map((r) => (
              <a key={r.id} className="btn ghost" href={tokenPages(r).place} target="_blank" rel="noreferrer noopener">
                {t.t("web.account.gl.open", { path: pathOf(r) })}
              </a>
            ))}
          </div>
        )}
        <dl className="fields">
          <dt>{t.t("web.account.gl.fName")}</dt>
          <dd><code>Crewreview</code></dd>
          <dt>{t.t("web.account.gl.fRole")}</dt>
          <dd><code>Developer</code></dd>
          <dt>{t.t("web.account.gl.fScope")}</dt>
          <dd><code>api</code></dd>
          <dt>{t.t("web.account.gl.fExpiry")}</dt>
          <dd>{t.t("web.account.gl.fExpiryHint")}</dd>
        </dl>
        <p className="muted small">
          {t.t("web.account.gl.who")} {first && <ExternalLink href={tokenPages(first).personal}>{t.t("web.account.gl.personal")}</ExternalLink>}
        </p>
      </Step>
      <Step n={3} title={t.t("web.account.paste")} done={!!saved?.applied.length}>
        <p className="muted small">{t.t("web.account.pasteHint")}</p>
        <TokenForm ids={selected.map((r) => r.id)} reviewOwnLabel={t.t("web.account.reviewOwnMr")} onSaved={onSaved} />
        {saved && <SavedNotice saved={saved} repos={repos} />}
      </Step>
    </>
  );
}

function GitHubSteps({ selected, repos, saved, onSaved, onChanged }: { selected: Repo[]; repos: Repo[]; saved?: Saved; onSaved: (s: Saved) => void; onChanged: () => void }) {
  const t = useT();
  const host = selected[0]?.host ?? "github.com";
  const repoLinks = selected.filter((r) => r.scope !== "org");
  const orgLinks = selected.filter((r) => r.scope === "org");
  const [login, setLogin] = useState("");
  const [found, setFound] = useState<{ ok?: string; bad?: string }>({});
  const [checking, setChecking] = useState(false);
  const [invites, setInvites] = useState<{ id: string; result?: string; error?: string }[] | undefined>();
  const [how, setHow] = useState<"token" | "gh">("token");
  const [signIn, setSignIn] = useState<SignIn>({ state: "idle" });
  const [copied, setCopied] = useState(false);
  const [finished, setFinished] = useState<{ ok?: string[]; bad?: string[] }>({});
  const [reviewOwn, setReviewOwn] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<SignIn>("/api/account/signin").then((s) => (setSignIn(s), s.state !== "idle" && setHow("gh")), () => {});
  }, []);
  useEffect(() => {
    if (signIn.state !== "waiting") return;
    const id = setInterval(() => api.get<SignIn>("/api/account/signin").then(setSignIn, () => {}), 2000);
    return () => clearInterval(id);
  }, [signIn.state]);

  const name = login.trim().replace(/^@/, "");
  const ids = selected.map((r) => r.id);
  const problem = (err: unknown) => (unreachable(err) ? t.t("web.setup.unreachable") : err instanceof ApiError ? (err.body?.message ?? err.body?.error ?? err.message) : String(err));

  const check = async (e: FormEvent) => {
    e.preventDefault();
    if (!name) return;
    setFound({});
    setChecking(true);
    try {
      const u = await api.get<{ login: string }>(`/api/account/user?login=${encodeURIComponent(name)}&host=${encodeURIComponent(host)}`);
      setLogin(u.login);
      setFound({ ok: t.t("web.account.found", { login: u.login }) });
    } catch (err) {
      const code = err instanceof ApiError ? err.body?.error : "";
      const same = code === "same-account" ? t.t("account.error.same-account", { name: err instanceof ApiError ? (err.body?.name ?? name) : name }) : undefined;
      setFound({ bad: same ?? (code === "not-found" ? t.t("web.account.notFound", { login: name }) : code === "bad-name" ? t.t("web.account.badName") : code === "no-token" ? t.t("web.log.noToken") : problem(err)) });
    } finally {
      setChecking(false);
    }
  };
  const invite = async () => {
    setBusy(true);
    try {
      setInvites(await api.post("/api/account/invite", { login: name, repos: repoLinks.map((r) => r.id) }));
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
    const who = signIn.state === "done" ? signIn.login : name;
    setBusy(true);
    const ok: string[] = [];
    const bad: string[] = [];
    if (repoLinks.length) {
      try {
        const r = await api.post<{ accepted: string[] }>("/api/account/accept", { login: who, repos: repoLinks.map((r) => r.id) });
        ok.push(t.t("web.account.accepted", { count: r.accepted.length }));
      } catch (err) {
        const b = err instanceof ApiError ? err.body : undefined;
        if (b?.error !== "none") bad.push(b?.error && b.error !== "host" ? t.t(`account.error.${b.error}` as never, { name: b.name ?? who, message: b.message ?? "" }) : problem(err));
      }
    }
    let using = 0;
    for (const r of selected) {
      try {
        const authors = reviewOwn && r.review.authors === "others" ? { authors: "all" } : {};
        await api.patch(`/api/repos/${r.id}`, { review: { account: who, ...authors } });
        using++;
      } catch (err) {
        const b = err instanceof ApiError ? err.body : undefined;
        bad.push(`${r.id}: ${b?.problem ? t.t(`account.error.${b.problem}` as never, { name: b.name ?? who, message: b.message ?? "" }) : problem(err)}`);
      }
    }
    if (using) ok.push(t.t("web.account.done", { login: who, count: using }));
    setFinished({ ok, bad });
    setBusy(false);
    onChanged();
  };

  const signInError = (s: Extract<SignIn, { state: "failed" }>) =>
    t.t(`web.account.err.${s.error}` as never, { detail: s.detail ?? "", who: s.who ? `@${s.who}` : "?", login: s.login });

  return (
    <>
      <Step n={2} title={t.t("web.account.s1")} done={!!found.ok}>
        <p className="muted small">{t.t("web.account.s1Hint")}</p>
        <div className="row">
          <a className="btn ghost" href={`https://${host}/signup`} target="_blank" rel="noreferrer noopener">
            {t.t("web.account.openSignup")}
          </a>
          <code>{host}/signup</code>
        </div>
        <form className="add" onSubmit={check}>
          <input value={login} onChange={(e) => (setLogin(e.target.value), setFound({}))} placeholder="acme-crew" aria-label={t.t("web.account.username")} spellCheck={false} autoCapitalize="off" />
          <button className="btn ghost" disabled={!name || checking}>
            {checking ? t.t("web.account.checking") : t.t("web.account.check")}
          </button>
        </form>
        {found.ok && <p className="notice ok">{found.ok}</p>}
        {found.bad && <p className="notice warn">{found.bad}</p>}
      </Step>

      <Step n={3} title={t.t("web.account.s2")} done={!!invites?.length && invites.every((i) => i.result)}>
        <p className="muted small">{t.t("web.account.s2Hint")}</p>
        {repoLinks.length > 0 && (
          <ul className="checklist">
            {repoLinks.map((r) => {
              const res = invites?.find((i) => i.id === r.id);
              return (
                <li key={r.id}>
                  <span>{pathOf(r)}</span>
                  <span className="check-state">
                    {res?.result === "invited" && <Pill tone="ok">{t.t("web.account.invited")}</Pill>}
                    {res?.result === "already" && <Pill tone="ok">{t.t("web.account.already")}</Pill>}
                    {res?.error && <span className="bad-text small">{res.error}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {orgLinks.length > 0 && <p className="notice warn">{t.t("web.account.gh.orgNote", { orgs: orgLinks.map(pathOf).join(", ") })}</p>}
        {invites?.some((i) => !i.id && i.error) && <p className="notice bad">{invites.find((i) => !i.id)!.error}</p>}
        {repoLinks.length > 0 && (
          <div className="row">
            <button className="btn primary" onClick={invite} disabled={busy || !name}>
              {name ? t.t("web.account.invite", { login: name }) : t.t("web.account.typeName")}
            </button>
          </div>
        )}
      </Step>

      <Step n={4} title={t.t("web.account.gh.s4")} done={!!saved?.applied.length || (!!finished.ok?.length && !finished.bad?.length)}>
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={how === "token"} className={how === "token" ? "on" : ""} onClick={() => setHow("token")}>
            {t.t("web.account.gh.byToken")}
          </button>
          <button role="tab" aria-selected={how === "gh"} className={how === "gh" ? "on" : ""} onClick={() => setHow("gh")}>
            {t.t("web.account.gh.byGh")}
          </button>
        </div>
        {how === "token" ? (
          <>
            <p className="muted small">{t.t("web.account.gh.tokenHint")}</p>
            <div className="row">
              <a className="btn ghost" href={tokenPages(selected[0] ?? repos[0]!).personal} target="_blank" rel="noreferrer noopener">
                {t.t("web.account.gh.openToken")}
              </a>
            </div>
            <TokenForm ids={ids} reviewOwnLabel={t.t("web.account.reviewOwn")} onSaved={onSaved} />
            {saved && <SavedNotice saved={saved} repos={repos} />}
          </>
        ) : (
          <>
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
            ) : signIn.state !== "done" ? (
              <div className="row">
                <button className="btn primary" onClick={startSignIn} disabled={busy || !name}>
                  {name ? t.t("web.account.start") : t.t("web.account.typeName")}
                </button>
              </div>
            ) : null}
            {signIn.state === "done" && (
              <>
                <p className="notice ok">
                  {t.t("web.account.signedIn", { login: signIn.login })}
                  {signIn.restoredTo ? ` ${t.t("web.account.restored", { user: signIn.restoredTo })}` : ""}
                </p>
                <label className="pick">
                  <input type="checkbox" checked={reviewOwn} onChange={(e) => setReviewOwn(e.target.checked)} />
                  {t.t("web.account.reviewOwn")}
                </label>
                <div className="row">
                  <button className="btn primary" onClick={finish} disabled={busy || selected.length === 0}>
                    {t.t("web.account.finish", { login: signIn.login })}
                  </button>
                </div>
              </>
            )}
            {signIn.state === "failed" && (
              <p className="notice bad">
                {signInError(signIn)}
                {signIn.restoredTo ? ` ${t.t("web.account.restored", { user: signIn.restoredTo })}` : ""}
              </p>
            )}
            {finished.ok?.map((m) => (
              <p key={m} className="notice ok">{m}</p>
            ))}
            {finished.bad?.map((m) => (
              <p key={m} className="notice warn">{m}</p>
            ))}
          </>
        )}
      </Step>
    </>
  );
}
