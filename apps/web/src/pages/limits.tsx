import { useEffect, useState } from "react";
import { api, type HarnessInfo, type Limits } from "../api.ts";
import { duration, useT } from "../i18n.ts";
import { Card, Empty, Pill, ProveButton } from "../ui.tsx";
import { SettingsCard } from "./settings.tsx";

function Check({ value }: { value?: string }) {
  const t = useT();
  if (value === "pass") return <Pill tone="ok">{t.t("doctor.verified")}</Pill>;
  if (value === "fail") return <Pill tone="bad">{t.t("doctor.failedCheck")}</Pill>;
  return <Pill>{t.t("doctor.untested")}</Pill>;
}

export function LimitsPage({ version, agentsVersion }: { version: number; agentsVersion?: number }) {
  const t = useT();
  const [harnesses, setHarnesses] = useState<HarnessInfo[] | undefined>();
  const [limits, setLimits] = useState<Limits | undefined>();
  useEffect(() => {
    api.get<HarnessInfo[]>("/api/harnesses").then(setHarnesses, () => setHarnesses([]));
    api.get<Limits>("/api/limits").then(setLimits, () => {});
  }, [agentsVersion]);
  const u = limits?.usageToday;
  return (
    <>
      <header className="page-head">
        <h1>{t.t("web.nav.limits")}</h1>
      </header>
      {u && (
        <div className="stats">
          <div className="stat">
            <span className="muted small">{t.t("web.limits.reviewsToday")}</span>
            <strong>{u.reviews}</strong>
          </div>
          <div className="stat">
            <span className="muted small">{t.t("web.limits.tokensToday")}</span>
            <strong>{(u.inputTokens + u.outputTokens).toLocaleString(t.locale)}</strong>
          </div>
          <div className="stat">
            <span className="muted small">{t.t("web.limits.costToday")}</span>
            <strong>US$ {u.costUsd.toFixed(2)}</strong>
          </div>
          {limits?.quota && (
            <div className="stat">
              <span className="muted small">{t.t("web.limits.runsToday")}</span>
              <strong>
                {limits.quota.runsToday}
                {limits.limits.dailyRuns ? <span className="muted small"> / {limits.limits.dailyRuns}</span> : null}
              </strong>
            </div>
          )}
        </div>
      )}
      <Card title={t.t("doctor.harnesses")}>
        {!harnesses ? (
          <Empty>{t.t("web.loading")}</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t.t("doctor.col.harness")}</th>
                  <th>{t.t("doctor.col.version")}</th>
                  <th>{t.t("doctor.col.readOnly")}</th>
                  <th>{t.t("doctor.col.write")}</th>
                  <th>{t.t("doctor.col.cost")}</th>
                  <th>{t.t("doctor.col.login")}</th>
                </tr>
              </thead>
              <tbody>
                {harnesses.map((h) => (
                  <tr key={h.id}>
                    <td>
                      <strong>{h.name}</strong> <span className="muted small mono">{h.id}</span>
                    </td>
                    <td className="mono small">{h.installed ? (h.version ?? "?").replace(/\s*\(.*\)$/, "") : t.t("doctor.notInstalled")}</td>
                    <td>
                      {h.installed && (h.capabilities.readOnly === "enforced" ? <Check value={h.conformance?.readOnly} /> : <Pill tone="bad">{t.t("doctor.no")}</Pill>)} {h.installed && <ProveButton h={h} />}
                    </td>
                    <td>{h.installed && (h.capabilities.write ? <Check value={h.conformance?.writeScope} /> : <Pill>{t.t("doctor.no")}</Pill>)}</td>
                    <td>{h.capabilities.costReport ? t.t("doctor.yes") : t.t("doctor.no")}</td>
                    <td>
                      {h.pausedUntil && (
                        <Pill tone="warn">{t.t("web.limits.pausedUntil", { when: new Date(h.pausedUntil).toLocaleString(t.locale, { weekday: "short", hour: "2-digit", minute: "2-digit" }) })}</Pill>
                      )}{" "}
                      {h.installed && h.signIn?.state === "yes" && (
                        <Pill tone="ok">{h.signIn.expiresAt ? t.t("doctor.until", { date: new Date(h.signIn.expiresAt).toLocaleDateString(t.locale, { month: "short", day: "numeric" }) }) : t.t("doctor.yes")}</Pill>
                      )}
                      {h.installed && h.signIn?.state === "no" && (
                        <span title={h.loginCommand}>
                          <Pill tone="bad">{t.t("doctor.no")}</Pill> {h.loginCommand && <code className="small">{h.loginCommand}</code>}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">{t.t("doctor.conformanceHint")}</p>
      </Card>
      <SettingsCard version={version} />
    </>
  );
}
