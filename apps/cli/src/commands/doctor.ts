import { arch, platform } from "node:os";
import { registryFor, reviewable } from "@crewreview/engine";
import { runConformance, runProcess, which } from "@crewreview/harness";
import { conformanceStore, table, type Ctx } from "../ctx.ts";

async function gitVersion(): Promise<string | undefined> {
  const r = await runProcess({ argv: ["git", "--version"], cwd: process.cwd(), env: process.env as Record<string, string>, timeoutMs: 10_000 });
  return r.exitCode === 0 ? r.stdout.trim().replace(/^git version /, "") : undefined;
}

async function signedIn(cli: string): Promise<boolean | undefined> {
  const path = which(cli);
  if (!path) return undefined;
  const r = await runProcess({ argv: [path, "auth", "status"], cwd: process.cwd(), env: process.env as Record<string, string>, timeoutMs: 15_000 });
  return r.exitCode === 0;
}

export async function doctor(c: Ctx, conformance: boolean): Promise<number> {
  const { t, style: st } = c;
  const store = conformanceStore(c);
  const registry = registryFor(c.config);
  c.out(st.bold(`${t.t("doctor.title")}  ${st.dim(c.version)}`));
  c.out();
  c.out(st.bold(t.t("doctor.system")));
  c.out(`  ${platform()} ${arch()} · git ${(await gitVersion()) ?? st.red(t.t("doctor.missing"))}`);
  c.out(`  ${t.t("doctor.config").padEnd(8)} ${c.configPath}${c.configExists ? "" : st.dim(" (—)")}`);
  c.out(`  ${t.t("doctor.data").padEnd(8)} ${c.dirs.data}`);
  c.out();

  if (conformance) {
    for (const h of registry.values()) {
      if (!(await h.detect()).installed || h.capabilities.readOnly !== "enforced") continue;
      c.err(c.errStyle.dim(t.t("doctor.conformanceRunning", { name: h.id })));
      const r = await runConformance(h);
      await store.put(r);
      const detail = r.error ? c.errStyle.dim(` — ${r.failure ?? ""} ${r.error.split("\n")[0]}`) : "";
      c.err(t.t("doctor.conformanceResult", { name: h.id, structured: t.t(`check.${r.structured}`), readOnly: t.t(`check.${r.readOnly}`), seconds: Math.round(r.durationMs / 1000) }) + detail);
    }
    c.err();
  }

  c.out(st.bold(t.t("doctor.harnesses")));
  const rows: string[][] = [];
  let ready: string | undefined;
  for (const h of registry.values()) {
    const det = await h.detect();
    const conf = det.installed ? await store.get(h.id, det.version) : undefined;
    const ro =
      h.capabilities.readOnly !== "enforced" ? t.t("doctor.no") : conf?.readOnly === "pass" ? t.t("doctor.verified") : conf?.readOnly === "fail" ? t.t("doctor.failedCheck") : t.t("doctor.byFlags");
    rows.push([
      h.id,
      det.installed ? t.t("doctor.installed") : t.t("doctor.notInstalled"),
      det.installed ? (det.version ?? "?").replace(/\s*\(.*\)$/, "").replace(/^[a-z-]+ /i, "") : "—",
      det.installed ? ro : "—",
      h.capabilities.write ? t.t("doctor.yes") : t.t("doctor.no"),
      h.capabilities.costReport ? t.t("doctor.yes") : t.t("doctor.no"),
    ]);
    if (!ready && det.installed && (await reviewable(h, store)) === "ok") ready = h.id;
  }
  table(c, [t.t("doctor.col.harness"), t.t("doctor.col.status"), t.t("doctor.col.version"), t.t("doctor.col.readOnly"), t.t("doctor.col.write"), t.t("doctor.col.cost")], rows);
  c.out();
  c.out(st.bold(t.t("doctor.hosts")));
  for (const cli of ["gh", "glab"]) {
    const s = await signedIn(cli);
    c.out(`  ${cli.padEnd(6)} ${s === undefined ? st.dim(t.t("doctor.notInstalled")) : s ? st.green(t.t("doctor.signedIn")) : st.yellow(t.t("doctor.notSignedIn"))}`);
  }
  c.out();
  if (!conformance) c.out(st.dim(t.t("doctor.conformanceHint")));
  if (ready) {
    c.out(st.green(t.t("doctor.ready", { name: ready })));
    return 0;
  }
  c.out(st.red(t.t("doctor.notReady")));
  return 1;
}
