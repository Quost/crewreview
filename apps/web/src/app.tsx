import { useCallback, useEffect, useMemo, useState } from "react";
import { api, connectEvents, takeToken, type LiveAgent, type LogEntry, type Repo, type Status } from "./api.ts";
import { createTranslator, I18n, initialLocale, LANGUAGE_NAMES, LOCALES, relative, saveLocale, type Locale } from "./i18n.ts";
import { AccountPage } from "./pages/account.tsx";
import { HistoryPage } from "./pages/history.tsx";
import { InboxPage } from "./pages/inbox.tsx";
import { LimitsPage } from "./pages/limits.tsx";
import { NowPage } from "./pages/now.tsx";
import { ReposPage } from "./pages/repos.tsx";
import { SetupPage } from "./pages/setup.tsx";

const PAGES = ["setup", "now", "inbox", "history", "repos", "limits", "account"] as const;
type Page = (typeof PAGES)[number];

function pageFromHash(): Page {
  const p = location.hash.replace(/^#\/?/, "").split(/[?&]/)[0] as Page;
  return PAGES.includes(p) ? p : "now";
}

export interface Live {
  status?: Status;
  agents: LiveAgent[];
  log: LogEntry[];
  connected: boolean;
  /** Bumped when the daemon says a list changed. */
  version: { inbox: number; repos: number; history: number; settings: number; harnesses: number };
}

export function App() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const t = useMemo(() => createTranslator(locale), [locale]);
  const [token, setToken] = useState(() => takeToken());
  const [page, setPage] = useState<Page>(pageFromHash);
  const [live, setLive] = useState<Live>({ agents: [], log: [], connected: false, version: { inbox: 0, repos: 0, history: 0, settings: 0, harnesses: 0 } });
  const [, tick] = useState(0);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const on = () => {
      // A link with a fresh token can arrive in a tab that's already open.
      if (location.hash.includes("token=")) setToken(takeToken());
      setPage(pageFromHash());
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!token) return;
    return connectEvents(
      (m) =>
        setLive((s) => {
          if (m.type === "snapshot") return { ...s, status: m.status, agents: m.agents, log: m.log };
          if (m.type === "agents") return { ...s, agents: m.agents };
          if (m.type === "status") return { ...s, status: m.status };
          if (m.type === "log") return { ...s, log: [...s.log, m.entry].slice(-200) };
          if (m.type === "changed") return { ...s, version: { ...s.version, [m.what]: s.version[m.what as keyof Live["version"]] + 1 } };
          return s;
        }),
      (connected) => setLive((s) => ({ ...s, connected })),
    );
  }, [token]);

  // Nothing linked yet: the setup page leads, and opens by itself unless the address asked for another page.
  const [repoCount, setRepoCount] = useState<number | undefined>();
  useEffect(() => {
    if (!token) return;
    api.get<Repo[]>("/api/repos").then(
      (rs) => setRepoCount(rs.length),
      () => {},
    );
  }, [token, live.version.repos]);
  const [firstRun, setFirstRun] = useState(() => !location.hash.replace(/^#\/?/, ""));
  useEffect(() => {
    if (repoCount === undefined || !firstRun) return;
    setFirstRun(false);
    if (repoCount === 0) location.hash = "#/setup";
  }, [repoCount, firstRun]);

  const checkNow = useCallback(() => api.post("/api/cycle").catch(() => {}), []);

  if (!token) {
    return (
      <I18n.Provider value={t}>
        <main className="locked">
          <div className="card">
            <h1>Crewreview</h1>
            <p>{t.t("web.noToken")}</p>
            <pre>crewreview ui</pre>
          </div>
        </main>
      </I18n.Provider>
    );
  }

  const st = live.status;
  const statusText = !live.connected
    ? t.t("web.status.offline")
    : st?.cycleRunning
      ? t.t("web.status.checking")
      : st?.nextCycleAt
        ? t.t("web.status.next", { when: relative(t, st.nextCycleAt) })
        : t.t("web.status.idle");

  const nav: { id: Page; label: string; badge?: number }[] = [
    ...(repoCount === 0 || page === "setup" ? [{ id: "setup" as const, label: t.t("web.nav.setup") }] : []),
    { id: "now", label: t.t("web.nav.now"), badge: live.agents.filter((a) => a.status === "running").length || undefined },
    { id: "inbox", label: t.t("web.nav.inbox"), badge: st?.inbox || undefined },
    { id: "history", label: t.t("web.nav.history") },
    { id: "repos", label: t.t("web.nav.repos") },
    { id: "limits", label: t.t("web.nav.limits") },
    ...(page === "account" ? [{ id: "account" as const, label: t.t("web.account.title") }] : []),
  ];

  return (
    <I18n.Provider value={t}>
      <div className="shell">
        <aside className="side">
          <div className="brand">
            <span className="logo" aria-hidden="true">✓</span>
            <span>Crewreview</span>
          </div>
          <nav>
            {nav.map((n) => (
              <a key={n.id} href={`#/${n.id}`} className={page === n.id ? "active" : ""} aria-current={page === n.id ? "page" : undefined}>
                <span>{n.label}</span>
                {n.badge ? <span className="badge">{n.badge}</span> : null}
              </a>
            ))}
          </nav>
          <div className="side-foot">
            <div className={`daemon ${live.connected ? "up" : "down"}`}>
              <span className="dot" aria-hidden="true" />
              <span>{statusText}</span>
            </div>
            <label className="lang">
              <span className="sr">{t.t("web.language")}</span>
              <select
                value={locale}
                onChange={(e) => {
                  const l = e.target.value as Locale;
                  saveLocale(l);
                  setLocale(l);
                }}
              >
                {LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {LANGUAGE_NAMES[l]}
                  </option>
                ))}
              </select>
            </label>
            {st && <div className="version">v{st.version}</div>}
          </div>
        </aside>
        <main className="main">
          {page === "setup" && <SetupPage onCheckNow={checkNow} repos={repoCount} agentsVersion={live.version.harnesses} />}
          {page === "now" && <NowPage live={live} onCheckNow={checkNow} />}
          {page === "inbox" && <InboxPage version={live.version.inbox} />}
          {page === "history" && <HistoryPage version={live.version.history} />}
          {page === "repos" && <ReposPage version={live.version.repos} />}
          {page === "limits" && <LimitsPage version={live.version.settings} agentsVersion={live.version.harnesses} />}
          {page === "account" && <AccountPage />}
        </main>
      </div>
    </I18n.Provider>
  );
}
