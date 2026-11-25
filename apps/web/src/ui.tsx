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

/** Texto de achado/resposta: `code` spans como código, tudo o resto como texto simples (nunca HTML). */
export function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`\n]+`)/g).map((part, i) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part,
      )}
    </>
  );
}

/** Badge leve: rótulo pequeno com tom opcional. */
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "bad" | "accent" | "live" }) {
  return <span className={`badge-soft ${tone === "neutral" ? "" : tone}`}>{children}</span>;
}

/** Avatar com iniciais (ou letra) e cor por tom. */
export function Avatar({ label, size = 30, tone = "accent" }: { label: string; size?: number; tone?: "ok" | "warn" | "bad" | "accent" | "live" }) {
  const initials = label
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span
      className={`avatar-simple ${tone}`}
      aria-label={label}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {initials}
    </span>
  );
}

/** Card de estatística: número grande + rótulo. */
export function StatCard({ value, label, tone }: { value: ReactNode; label: ReactNode; tone?: "ok" | "warn" | "bad" | "accent" | "live" }) {
  return (
    <div className="stat-card">
      <span className={`badge-soft ${tone ?? ''}`}>{label}</span>
      <div className="value">{value}</div>
    </div>
  );
}

/** Título de seção de página com ação à direita. */
export function SectionHead({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <h1>{title}</h1>
      {actions && <div className="card-actions">{actions}</div>}
    </header>
  );
}

/**
 * Um agente que deve provar seu lock de leitura antes de revisar (ACP e customizados): o botão roda a prova,
 * "provando…" enquanto roda (a lista atualiza ao acabar), ou o resultado falhado.
 */
/** Provar os locks de um agente com uma execução real. Onde reviews precisam da prova ela é oferecida até passar; com `any`, qualquer
 * agente ainda não provado pode sê-lo (a tabela de harnesses), já que um built-in é confiável mas ainda não mostrado como detentor. */
export function ProveButton({ h, any, write }: { h: { id: string; review?: string; proving?: boolean; capabilities?: { write: boolean }; conformance?: { readOnly?: string; writeScope?: string; at?: string } }; any?: boolean; write?: boolean }) {
  const t = useT();
  const [asked, setAsked] = useState(false);
  // O clique mostra "proving" de imediato; a lista assume daí, e diz quando acabou.
  useEffect(() => {
    if (h.proving) setAsked(false);
  }, [h.proving]);
  useEffect(() => setAsked(false), [h.conformance?.at]);
  if (write) {
    // O teste de escrita, depois que o de leitura está registrado: um harness que falhou (ou nunca fez) pode tentar de novo.
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
