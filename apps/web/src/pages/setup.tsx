import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, unreachable, type HarnessInfo, type HostAccess, type Limits, type Preview } from "../api.ts";
import { useT } from "../i18n.ts";
import { Card, Empty, Pill, ProveButton, Badge, SectionHead } from "../ui.tsx";
import { PreviewBox } from "./repos.tsx";

type Readiness = "ready" | "signin" | "missing" | "unknown";

function readiness(h: HarnessInfo): Readiness {
  if (!h.installed) return "missing";
  if (h.signIn?.state === "no") return "signin";
  return h.signIn?.state === "yes" ? "ready" : "unknown";
}

const usable = (h?: HarnessInfo) => !!h && (readiness(h) === "ready" || readiness(h) === "unknown") && (h.review === undefined || h.review === "ok");

function hostLogin(h: HostAccess): string {
  const cli = h.kind === "github" ? "gh" : "glab";
  const usual = h.host === "github.com" || h.host === "gitlab.com";
  return `${cli} auth login${usual ? "" : ` --hostname ${h.host}`}`;
}

function Step({ n, title, done, children, actions }: { n: number; title: string; done?: boolean; children: ReactNode; actions?: ReactNode }) {
  const t = useT();
  return (
    <Card
      className="step"
      title={
        <>
          <span className={`step-n ${done ? "done" : ""}`} aria-hidden="true">
            {done ? "✓" : n}
          </span>
          {title}
          {done !== undefined && <Badge tone={done ? "ok" : "warn"}>{done ? t.t("web.setup.done") : t.t("web.setup.todo")}</Badge>}
        </>
      }
      actions={actions}
    >
      {children}
    </Card>
  );
}

/** First run: the agents, access to the host, one link, and what happens next. */
export function SetupPage({ onCheckNow, repos, agentsVersion }: { onCheckNow: () => void; repos?: number; agentsVersion?: number }) {
  const t = useT();
  const [harnesses, setHarnesses] = useState<HarnessInfo[] | undefined>();
  const [hosts, setHosts] = useState<HostAccess[] | undefined>();
  const [limits, setLimits] = useState<Limits | undefined>();
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<Preview | "loading" | { failed: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [linked, setLinked] = useState<string | undefined>();

  const loadAgents = () => {
    setHarnesses(undefined);
    api.get<HarnessInfo[]>("/api/harnesses").then(setHarnesses, () => setHarnesses([]));
  };
  const loadHosts = () => {
    api.get<HostAccess[]>("/api/hosts").then(setHosts, () => setHosts((h) => h ?? []));
  };
  useEffect(() => {
    loadAgents();
    loadHosts();
    api.get<Limits>("/api/limits").then(setLimits, () => {});
  }, []);
  useEffect(() => {
    if (agentsVersion) api.get<HarnessInfo[]>("/api/harnesses").then(setHarnesses, () => {});
  }, [agentsVersion]);

  const failure = (err: unknown, what: "preview" | "link") => {
    if (unreachable(err)) return t.t("web.setup.unreachable");
    const code = err instanceof ApiError ? err.body?.error : "";
    if (code === "exists") return t.t("web.repos.exists");
    if (code === "no-token") return t.t("web.log.noToken");
    const error = err instanceof ApiError ? (err.body?.message ?? code) : String(err);
    return what === "preview" ? t.t("web.setup.previewFailed", { error }) : t.t("web.repos.addFailed", { error });
  };
  const showPreview = async () => {
    if (!url.trim()) return;
    setError(undefined);
    setPreview("loading");
    try {
      setPreview(await api.post<Preview>("/api/preview", { url: url.trim() }));
    } catch (err) {
      setPreview({ failed: failure(err, "preview") });
    }
  };
  const link = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(undefined);
    if (preview && preview !== "loading" && "failed" in preview) setPreview(undefined);
    try {
      const r = await api.post<{ id: string }>("/api/repos", { url: url.trim(), mode: "inbox" });
      setLinked(r.id);
      setUrl("");
      setPreview(undefined);
      loadHosts();
    } catch (err) {
      setError(failure(err, "link"));
    } finally {
      setBusy(false);
    }
  };

  const chosenInfo = harnesses?.find((h) => h.chosen);
  const choose = async (id: string) => {
    setBusy(true);
    try {
      await api.patch("/api/settings", { values: { "harness.default": id } });
      loadAgents();
    } catch (err) {
      setError(failure(err, "link"));
    } finally {
      setBusy(false);
    }
  };
  const agentsDone = harnesses ? usable(chosenInfo) : undefined;
  const hostsDone = hosts ? hosts.some((h) => h.user) : undefined;
  const recheck = (onClick: () => void) => (
    <button className="btn ghost sm" onClick={onClick}>
      {t.t("web.setup.recheck")}
    </button>
  );

  const harnessStatus = (h: HarnessInfo) => {
    const r = readiness(h);
    if (r === "ready") return <Badge tone="ok">{t.t("web.setup.ready")}</Badge>;
    if (r === "unknown") return <Badge>{t.t("web.setup.installed")}</Badge>;
    if (r === "signin") return <Badge tone="warn">{t.t("web.setup.signIn")}</Badge>;
    return <span className="muted small">{t.t("web.setup.missing")}</span>;
  };

  return (
    <>
      <SectionHead title={t.t("web.nav.setup")} />
      <p className="muted lead">{t.t("web.setup.intro")}</p>

      <Step n={1} title={t.t("web.setup.agents")} done={agentsDone} actions={recheck(loadAgents)}>
        <p className="muted small">{t.t("web.setup.agentsHint")}</p>
        {!harnesses ? (
          <Empty>{t.t("web.loading")}</Empty>
        ) : (
          <ul className="checklist">
            {harnesses.map((h) => {
              const r = readiness(h);
              return (
                <li key={h.id}>
                  <span>
                    <strong>{h.name}</strong> <code>{h.id}</code> {h.chosen && <Badge tone="accent">{t.t("web.setup.default")}</Badge>}
                  </span>
                  <span className="check-state">
                    {usable(h) && !h.chosen && (
                      <button className="btn ghost sm" onClick={() => choose(h.id)} disabled={busy}>
                        {t.t("web.setup.useForReviews")}
                      </button>
                    )}
                    <ProveButton h={h} />
                    {harnessStatus(h)}
                    {r === "ready" && h.signIn?.expiresAt && <span className="muted small">{t.t("doctor.until", { date: new Date(h.signIn.expiresAt).toLocaleDateString(t.locale, { month: "short", day: "numeric" }) })}</span>}
                    {r === "signin" && <code className="small mono">{h.loginCommand}</code>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {harnesses &&
          (agentsDone ? (
            <p className="notice ok">{t.t("web.setup.agentsOk", { name: chosenInfo!.name })}</p>
          ) : chosenInfo || (limits && limits.harness.default !== "auto") ? (
            <p className="notice warn">{t.t("web.setup.agentsDefaultMissing", { name: chosenInfo?.name ?? limits?.harness.default ?? "?", path: limits?.configPath ?? "config.toml" })}</p>
          ) : (
            <p className="notice warn">{t.t("web.setup.agentsNone")}</p>
          ))}
      </Step>

      <Step n={2} title={t.t("web.setup.hosts")} done={hostsDone} actions={recheck(loadHosts)}>
        <p className="muted small">{t.t("web.setup.hostsHint")}</p>
        {!hosts ? (
          <Empty>{t.t("web.loading")}</Empty>
        ) : (
          <ul className="checklist">
            {hosts.map((h) => (
              <li key={`${h.kind}:${h.host}`}>
                <span>
                  <strong>{h.host}</strong> <span className="muted small">{h.kind}</span>
                </span>
                <span className="check-state">
                  {h.user ? (
                    <Badge tone="ok">{t.t("web.setup.hostAs", { user: h.user })}</Badge>
                  ) : h.source ? (
                    <Badge tone="bad">{t.t("web.setup.hostError", { error: h.error ?? "" })}</Badge>
                  ) : (
                    <>
                      <span className="muted small">{t.t("web.setup.hostNone")}</span>
                      <code className="small mono">{hostLogin(h)}</code>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">{t.t("web.setup.hostsOk")}</p>
      </Step>

      <Step n={3} title={t.t("web.repos.add")} done={linked ? true : undefined}>
        <p className="muted small">{t.t("web.setup.linkHint")}</p>
        <form className="add" onSubmit={link}>
          <input
            type="url"
            required
            placeholder="https://github.com/owner/repo · https://github.com/org"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setPreview(undefined);
            }}
            aria-label={t.t("repo.col.url")}
          />
          <button type="button" className="btn ghost" onClick={showPreview} disabled={!url.trim() || preview === "loading"}>
            {t.t("web.setup.previewButton")}
          </button>
          <button className="btn primary" disabled={busy}>
            {t.t("web.setup.linkButton")}
          </button>
        </form>
        {preview && <PreviewBox value={preview} />}
        {error && <p className="notice bad">{error}</p>}
        {linked && <p className="notice ok">{t.t("web.setup.linked", { id: linked })}</p>}
      </Step>

      <Step n={4} title={t.t("web.setup.next")}>
        <ul className="next">
          <li>{t.t("web.setup.next1")}</li>
          <li>{t.t("web.setup.next2")}</li>
          <li>{t.t("web.setup.next3")}</li>
          <li>
            {t.t("web.setup.next4")} <a href="#/account">{t.t("web.account.setupLink")}</a>
          </li>
        </ul>
        <div className="row">
          <button
            className="btn primary"
            onClick={() => {
              onCheckNow();
              location.hash = "#/now";
            }}
            disabled={!linked && !repos}
          >
            {t.t("web.checkNow")}
          </button>
          <a className="btn ghost" href="#/repos">
            {t.t("web.setup.openRepos")}
          </a>
        </div>
      </Step>
    </>
  );
}
