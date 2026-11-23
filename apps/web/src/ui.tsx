import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api.ts";
import { useT } from "./i18n.ts";

export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "bad" | "accent" | "live"; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

const SEV_TONE = { blocker: "bad", major: "warn", minor: "accent", nit: "neutral" } as const;
export function SeverityPill({ severity, label }: { severity: keyof typeof SEV_TONE; label: string }) {
  return <Pill tone={SEV_TONE[severity]}>{label}</Pill>;
}

/** Text from a finding or a reply: `code` spans as code, everything else as plain text (never as HTML). */
export function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`\n]+`)/g).map((part, i) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part,
      )}
    </>
  );
}

/**
 * An agent that must prove its read-only lock before it reviews (ACP and custom ones): the button runs the proof,
 * "proving…" while it runs (the list updates when it's done), or the failed result.
 */
/**
 * Prove an agent's locks with a real run. Where reviews need the proof it's offered until it passes; with `any`, any
 * agent not proven yet can be (the Harnesses table), since a built-in one is trusted but not yet shown to hold.
 */
export function ProveButton({ h, any, write }: { h: { id: string; review?: string; proving?: boolean; capabilities?: { write: boolean }; conformance?: { readOnly?: string; writeScope?: string; at?: string } }; any?: boolean; write?: boolean }) {
  const t = useT();
  const [asked, setAsked] = useState(false);
  // The click shows "proving" at once; the list takes over from there, and says when it's done.
  useEffect(() => {
    if (h.proving) setAsked(false);
  }, [h.proving]);
  useEffect(() => setAsked(false), [h.conformance?.at]);
  if (write) {
    // The write test, once the read-only one is on record: a harness that failed it (or never took it) can try again.
    if (!h.capabilities?.write || !h.conformance?.readOnly || h.conformance.writeScope === "pass") return null;
    if (h.proving || asked) return <Pill tone="live">{t.t("web.setup.proving")}</Pill>;
  } else {
    if (h.proving || asked) return <Pill tone="live">{t.t("web.setup.proving")}</Pill>;
    if (h.review === "failed-conformance") return <Pill tone="bad">{t.t("web.setup.proofFailed")}</Pill>;
    if (h.review !== "needs-conformance" && !(any && !h.conformance?.readOnly)) return null;
  }
  return (
    <button
      className="btn ghost sm"
      title={t.t("web.setup.proveHint")}
      onClick={() => {
        setAsked(true);
        api.post(`/api/harnesses/${h.id}/prove`).catch(() => setAsked(false));
      }}
    >
      {t.t(write ? "web.setup.proveWrite" : "web.setup.prove")}
    </button>
  );
}
