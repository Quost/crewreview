import type { LiveAgent } from "../api.ts";
import type { Live } from "../app.tsx";
import { describeEntry, foldQuiet } from "../describe.ts";
import { clock, duration, lensName, useT } from "../i18n.ts";
import { Card, Empty, Pill, SectionHead } from "../ui.tsx";

function roleLabel(t: ReturnType<typeof useT>, role: string): string {
  if (role === "verifier") return t.t("local.verifier");
  if (role === "attendant") return t.t("web.role.attendant");
  if (role === "plan") return t.t("web.role.planner");
  if (role.startsWith("build")) return `${t.t("web.role.builder")}${role.includes(":") ? ` · ${role.slice(6)}` : ""}`;
  return lensName(t, role);
}

export function NowPage({ live, onCheckNow }: { live: Live; onCheckNow: () => void }) {
  const t = useT();
  const jobs = new Map<string, LiveAgent[]>();
  for (const a of live.agents) {
    const k = a.job.task ? `${a.job.repo} · ${a.job.task}` : `${a.job.repo}#${a.job.number}`;
    jobs.set(k, [...(jobs.get(k) ?? []), a]);
  }
  const log = foldQuiet(live.log).reverse().slice(0, 60);
  return (
    <>
      <SectionHead title={t.t("web.nav.now")} actions={<button className="btn primary" onClick={onCheckNow} disabled={!live.connected || live.status?.cycleRunning}>{t.t("web.checkNow")}</button>} />
      <Card title={t.t("web.now.agents")}>
        {jobs.size === 0 ? (
          <Empty>{t.t("web.now.noAgents")}</Empty>
        ) : (
          <div className="jobs">
            {[...jobs.entries()].map(([k, agents]) => {
              const job = agents[0]!.job;
              return (
                <article key={k} className="job">
                  <header>
                    <strong>{k}</strong>
                    <span className="muted">{job.title}</span>
                    <Pill tone={job.kind === "review" ? "accent" : "live"}>{job.kind === "review" ? t.t("inbox.kind.review") : job.kind === "task" ? t.t("web.tasks.kind") : t.t("inbox.kind.fix")}</Pill>
                  </header>
                  <ul className="agents">
                    {agents.map((a) => (
                      <li key={a.id} className={`agent ${a.status}`}>
                        <span className="state" aria-label={a.status}>
                          {a.status === "running" ? <span className="spinner" /> : a.status === "ok" ? "✓" : "✗"}
                        </span>
                        <span className="role">{roleLabel(t, a.role)}</span>
                        <span className="muted">{a.seat && a.seat !== a.harness ? `${a.seat} (${a.harness})` : a.harness}</span>
                        <span className="mono time">{duration((a.endedAt ?? Date.now()) - a.startedAt)}</span>
                        <span className="mono tool" title={a.lastTool}>
                          {a.status === "running" ? (a.lastTool ?? t.t("web.now.thinking")) : a.detail && a.role !== "attendant" && /^\d+$/.test(a.detail) ? t.tp("local.findingsCount", Number(a.detail)) : (a.detail ?? "")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })}
          </div>
        )}
      </Card>
      <Card title={t.t("web.now.activity")}>
        {log.length === 0 ? (
          <Empty>{t.t("web.now.noActivity")}</Empty>
        ) : (
          <ol className="log">
            {log.map((e, i) => {
              const d = describeEntry(t, e);
              return (
                <li key={`${e.at}-${i}`} className={`tone-${d.tone}`}>
                  <time className="mono muted">{clock(t, e.at)}</time>
                  <span>{d.text}</span>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </>
  );
}
