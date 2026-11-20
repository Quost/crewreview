import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, unreachable } from "../api.ts";
import { useT } from "../i18n.ts";
import { Card, Empty, Toggle } from "../ui.tsx";

type Values = Record<string, string | number | boolean | null>;
interface Settings {
  values: Values;
  harnesses: string[];
  configPath?: string;
  /** Only inside the desktop app. */
  desktop: { autostart: boolean | null } | null;
}

type Kind = "duration" | "count" | "count?" | "hours" | "flag" | "harness" | "harness?";
interface Field {
  key: string;
  kind: Kind;
  label: string;
  hint?: string;
}

/** config.toml's settings, edited here and used by the crew at once; open at login when it's the desktop app. */
export function SettingsCard({ version }: { version: number }) {
  const t = useT();
  const [s, setS] = useState<Settings | undefined>();
  const [draft, setDraft] = useState<Values>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok?: string; bad?: string; key?: string }>({});

  const load = () =>
    api.get<Settings>("/api/settings").then(
      (x) => {
        setS(x);
        setDraft(x.values);
      },
      () => {},
    );
  useEffect(() => {
    load();
  }, [version]);

  if (!s) {
    return (
      <Card title={t.t("web.settings.title")}>
        <Empty>{t.t("web.loading")}</Empty>
      </Card>
    );
  }

  const duration = t.t("web.settings.durationHint");
  const sections: { title: string; fields: Field[] }[] = [
    {
      title: t.t("web.settings.schedule"),
      fields: [
        { key: "schedule.interval", kind: "duration", label: t.t("web.settings.interval"), hint: duration },
        { key: "schedule.offHoursInterval", kind: "duration", label: t.t("web.settings.offHours"), hint: duration },
        { key: "schedule.peakHours", kind: "hours", label: t.t("web.limits.peak"), hint: t.t("web.settings.peakHint") },
        { key: "schedule.maxReviewsPerCycle", kind: "count", label: t.t("web.settings.reviewsPerCycle") },
        { key: "attend.maxPerCycle", kind: "count", label: t.t("web.settings.answersPerCycle") },
        { key: "schedule.keepAwake", kind: "flag", label: t.t("web.settings.keepAwake") },
      ],
    },
    {
      title: t.t("web.settings.limits"),
      fields: [
        { key: "limits.maxConcurrentAgents", kind: "count?", label: t.t("web.limits.agents"), hint: t.t("web.settings.emptyAuto") },
        { key: "limits.dailyRuns", kind: "count?", label: t.t("web.settings.dailyRuns"), hint: t.t("web.settings.emptyNone") },
        { key: "limits.agentTimeout", kind: "duration", label: t.t("web.limits.agentTimeout"), hint: duration },
        { key: "limits.stallTimeout", kind: "duration", label: t.t("web.limits.stall"), hint: duration },
        { key: "limits.maxDiffLines", kind: "count", label: t.t("web.limits.maxDiff") },
      ],
    },
    {
      title: t.t("web.settings.reviews"),
      fields: [
        { key: "harness.default", kind: "harness", label: t.t("web.settings.reviewer") },
        { key: "harness.verifier", kind: "harness?", label: t.t("web.settings.verifier") },
        { key: "review.settle", kind: "duration", label: t.t("web.settings.settle"), hint: duration },
        { key: "attend.quiet", kind: "duration", label: t.t("web.settings.quiet"), hint: duration },
        { key: "review.ciMaxWait", kind: "duration", label: t.t("web.limits.ciWait"), hint: duration },
        { key: "review.policy.allowApprove", kind: "flag", label: t.t("web.limits.approve") },
      ],
    },
  ];

  const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => v !== s.values[k]));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setResult({});
    try {
      // Empty text means "back to the default" for the optional ones.
      await api.patch("/api/settings", { values: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v === "" ? null : v])) });
      setResult({ ok: t.t("web.settings.saved", { path: s.configPath ?? "config.toml" }) });
      await load();
    } catch (err) {
      const b = err instanceof ApiError ? err.body : undefined;
      setResult({ bad: unreachable(err) ? t.t("web.setup.unreachable") : t.t("web.settings.failed", { error: b?.error ?? String(err) }), key: b?.key });
    } finally {
      setBusy(false);
    }
  };
  const setApp = async (body: Record<string, unknown>) => {
    try {
      await api.patch("/api/settings", body);
      // The app answers with its new state a moment later.
      setTimeout(load, 600);
    } catch (err) {
      setResult({ bad: unreachable(err) ? t.t("web.setup.unreachable") : t.t("web.settings.failed", { error: String(err) }) });
    }
  };
  const set = (key: string, v: string | number | boolean | null) => setDraft((d) => ({ ...d, [key]: v }));

  const input = (f: Field): ReactNode => {
    const v = draft[f.key];
    if (f.kind === "flag") return <Toggle label={v ? t.t("web.on") : t.t("web.off")} checked={!!v} onChange={(x) => set(f.key, x)} />;
    if (f.kind === "harness" || f.kind === "harness?")
      return (
        <select value={(v as string) ?? ""} onChange={(e) => set(f.key, e.target.value === "" ? null : e.target.value)} aria-label={f.label}>
          {f.kind === "harness?" && <option value="">{t.t("web.settings.sameAsReviewer")}</option>}
          {s.harnesses.map((h) => (
            <option key={h} value={h}>
              {h === "auto" ? t.t("web.limits.auto") : h}
            </option>
          ))}
        </select>
      );
    return (
      <input
        className={`mono ${result.key === f.key ? "invalid" : ""}`}
        inputMode={f.kind.startsWith("count") ? "numeric" : undefined}
        value={v === null || v === undefined ? "" : String(v)}
        placeholder={f.kind === "count?" ? (f.key === "limits.dailyRuns" ? t.t("web.settings.none") : t.t("web.limits.auto")) : undefined}
        onChange={(e) => set(f.key, f.kind.startsWith("count") && e.target.value.trim() !== "" && /^\d+$/.test(e.target.value.trim()) ? Number(e.target.value.trim()) : e.target.value)}
        aria-label={f.label}
        spellCheck={false}
      />
    );
  };

  return (
    <>
      <Card title={t.t("web.settings.title")}>
        <form className="settings-form" onSubmit={save}>
          {sections.map((sec) => (
            <fieldset key={sec.title}>
              <legend>{sec.title}</legend>
              {sec.fields.map((f) => (
                <label key={f.key} className="field">
                  <span>
                    {f.label}
                    {f.hint && <small className="muted"> {f.hint}</small>}
                  </span>
                  {input(f)}
                </label>
              ))}
            </fieldset>
          ))}
          <div className="row">
            <button className="btn primary" disabled={busy || Object.keys(changed).length === 0}>
              {t.t("web.settings.save")}
            </button>
            {Object.keys(changed).length > 0 && (
              <button type="button" className="btn ghost" onClick={() => (setDraft(s.values), setResult({}))}>
                {t.t("web.settings.undo")}
              </button>
            )}
          </div>
          {result.ok && <p className="notice ok">{result.ok}</p>}
          {result.bad && <p className="notice bad">{result.bad}</p>}
        </form>
      </Card>
      <Card title={t.t("web.settings.app")}>
        <div className="settings">
          <div className="setting">
            <div>
              <strong>{t.t("web.settings.autostart")}</strong>
              <p className="muted small">{s.desktop ? t.t("web.settings.autostartHint") : t.t("web.settings.autostartOnlyApp")}</p>
            </div>
            {s.desktop && <Toggle label={s.desktop.autostart ? t.t("web.on") : t.t("web.off")} checked={!!s.desktop.autostart} onChange={(on) => setApp({ autostart: on })} />}
          </div>
          <div className="setting">
            <div>
              <strong>{t.t("web.settings.updates")}</strong>
              <p className="muted small">{t.t("web.settings.updatesHint")}</p>
            </div>
            <Toggle label={s.values["updates.check"] ? t.t("web.on") : t.t("web.off")} checked={!!s.values["updates.check"]} onChange={(on) => setApp({ values: { "updates.check": on } })} />
          </div>
        </div>
      </Card>
    </>
  );
}
