import { useEffect, useState } from "react";
import { api, type TeamView } from "../api.ts";
import { useT } from "../i18n.ts";
import { Card, Empty, Pill, Avatar, SectionHead } from "../ui.tsx";

const EXAMPLE = `[seats]
planner = { harness = "claude", model = "claude-opus-5-5", effort = "high" }
sonnet = { harness = "claude", model = "claude-sonnet-5-5" }
fast = { harness = "codex", model = "gpt-6.1-sol", effort = "low", dailyRuns = 40 }

[roles]
review = { seats = ["fast", "sonnet"], balance = "spread" }
verify = ["planner"]
attend = ["sonnet", "fast"]`;

export function TeamPage({ agentsVersion }: { agentsVersion: number }) {
  const t = useT();
  const [team, setTeam] = useState<TeamView | undefined>();
  useEffect(() => {
    api.get<TeamView>("/api/team").then(setTeam, () => {});
  }, [agentsVersion]);
  const when = (at: number) => new Date(at).toLocaleString(t.locale, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const routed = team?.roles.some((r) => r.configured);
  const avatarTone = (s: { working: unknown[]; pausedUntil?: number }) => (s.working.length ? "accent" : s.pausedUntil ? "warn" : "accent");
  return (
    <>
      <SectionHead title={t.t("web.nav.team")} />
      <p className="muted lead">{t.t("web.team.intro")}</p>
      {!team ? (
        <Empty>{t.t("web.loading")}</Empty>
      ) : (
        <>
          <div className="team">
            {team.seats.map((s) => (
              <Card key={s.id} className="member" title={
                <>
                  <Avatar label={s.id} size={32} tone={avatarTone(s)} />
                  {s.id}
                </>
              }>
                <p className="mono small">
                  {s.harness}
                  {s.model ? ` · ${s.model}` : ""}
                  {s.effort ? ` · ${s.effort}` : ""}
                </p>
                <div className="row">
                  {s.roles.map((r) => (
                    <Pill key={r} tone="accent">
                      {t.t(`web.team.role.${r}` as never)}
                    </Pill>
                  ))}
                </div>
                <p className="small">
                  {s.working.length ? (
                    <Pill tone="live">{t.t("web.team.working", { what: s.working.map((w) => `${w.role} · ${w.repo}#${w.number}`).join(", ") })}</Pill>
                  ) : s.pausedUntil ? (
                    <Pill tone="warn">{t.t("web.limits.pausedUntil", { when: when(s.pausedUntil) })}</Pill>
                  ) : (
                    <span className="muted">{t.t("web.team.idle")}</span>
                  )}
                </p>
                <p className="muted small">{s.dailyRuns ? t.t("web.team.runsOf", { runs: s.runsToday, limit: s.dailyRuns }) : t.tp("web.team.runs", s.runsToday)}</p>
              </Card>
            ))}
          </div>
          <Card title={t.t("web.team.jobs")}>
            <ul className="checklist">
              {team.roles.map((r) => (
                <li key={r.role}>
                  <span>
                    <strong>{t.t(`web.team.role.${r.role}` as never)}</strong> <span className="muted small">{t.t(`web.team.roleHint.${r.role}` as never)}</span>
                  </span>
                  <span className="check-state small mono">
                    {r.seats.join(" → ")} {r.configured && r.seats.length > 1 && <Pill>{t.t(`web.team.balance.${r.balance}` as never)}</Pill>}
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted small">{routed ? t.t("web.team.howRouted") : t.t("web.team.howLegacy")}</p>
          </Card>
          <Card title={t.t("web.team.configure")}>
            <p className="muted small">{t.t("web.team.configureHint", { path: team.configPath ?? "config.toml" })}</p>
            <pre className="code small">{EXAMPLE}</pre>
            <p className="muted small">{t.t("web.team.balanceHint")}</p>
          </Card>
        </>
      )}
    </>
  );
}
