import { ANSI_STYLE, appDirs, ConformanceStore, isPickError, PLAIN_STYLE, pickReviewer, registryFor, Store, type AppDirs, type Config, type PickError, type ReviewEvent, type Style } from "@crewreview/engine";
import type { Harness } from "@crewreview/harness";
import type { Translator } from "@crewreview/i18n";
import { join } from "node:path";

export interface Ctx {
  t: Translator;
  config: Config;
  configPath: string;
  configExists: boolean;
  dirs: AppDirs;
  version: string;
  style: Style;
  errStyle: Style;
  out(s?: string): void;
  err(s?: string): void;
}

export function makeCtx(t: Translator, config: Config, configPath: string, configExists: boolean, version: string): Ctx {
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const errColor = process.stderr.isTTY && !process.env.NO_COLOR;
  return {
    t,
    config,
    configPath,
    configExists,
    dirs: appDirs(),
    version,
    style: color ? ANSI_STYLE : PLAIN_STYLE,
    errStyle: errColor ? ANSI_STYLE : PLAIN_STYLE,
    out: (s = "") => process.stdout.write(`${s}\n`),
    err: (s = "") => process.stderr.write(`${s}\n`),
  };
}

export function openStore(c: Ctx): Store {
  return new Store(join(c.dirs.state, "crewreview.db"));
}

export function conformanceStore(c: Ctx): ConformanceStore {
  return ConformanceStore.in(c.dirs.state);
}

export function pickErrorText(c: Ctx, e: PickError): string {
  if (e.error === "unknown-harness") return c.t.t("error.unknownHarness", { name: e.name });
  if (e.error === "no-harness") return c.t.t("error.noHarness");
  if (e.error === "needs-conformance") return c.t.t("error.needsConformance", { name: e.name });
  if (e.error === "cannot-write") return c.t.t("error.cannotWrite", { name: e.name });
  if (e.error === "needs-write-check") return c.t.t("error.needsWriteCheck", { name: e.name });
  if (e.error === "write-escapes") return c.t.t("error.writeEscapes", { name: e.name });
  if (e.error === "signed-out") return c.t.t("error.signedOut", { name: e.name, command: e.command ?? "" });
  if (e.error === "paused") return c.t.t("error.paused", { name: e.name, when: new Date(e.until).toLocaleString(c.t.locale, { weekday: "short", hour: "2-digit", minute: "2-digit" }) });
  if (e.error === "budget") return c.t.t("error.budget", { limit: e.limit });
  return c.t.t("error.harnessNotReadOnly", { name: e.name });
}

export async function pickHarness(c: Ctx, id: string): Promise<Harness | string> {
  const h = await pickReviewer(registryFor(c.config), id, conformanceStore(c));
  return isPickError(h) ? pickErrorText(c, h) : h;
}

/** Progress lines on stderr while agents work. CREWREVIEW_DEBUG=1 also shows each tool call. */
export function progress(c: Ctx) {
  return (e: ReviewEvent) => {
    if (e.type === "lens-start") c.err(c.errStyle.dim(`▸ ${c.t.t("local.lensStarted", { lens: e.lens, harness: e.harness })}`));
    else if (e.type === "verifier-start") c.err(c.errStyle.dim(`▸ ${c.t.t("local.lensStarted", { lens: c.t.t("local.verifier"), harness: e.harness })}`));
    else if (e.type === "agent" && e.event.type === "tool" && process.env.CREWREVIEW_DEBUG) c.err(c.errStyle.dim(`    ${e.role}: ${e.event.text}`));
  };
}

export function table(c: Ctx, header: string[], rows: string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  c.out(c.style.dim(`  ${header.map((h, i) => h.padEnd(widths[i]!)).join("  ")}`));
  for (const r of rows) c.out(`  ${r.map((x, i) => x.padEnd(widths[i]!)).join("  ")}`.trimEnd());
}

export function ago(ms: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return rtf.format(-s, "second");
  if (s < 5400) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 129600) return rtf.format(-Math.round(s / 3600), "hour");
  return rtf.format(-Math.round(s / 86400), "day");
}
