#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  ANSI_STYLE,
  appDirs,
  BUILTIN_LENS_IDS,
  ConfigError,
  configFile,
  loadConfig,
  loadLenses,
  localTarget,
  LocalTargetError,
  PLAIN_STYLE,
  renderMarkdown,
  renderTerminal,
  ReviewError,
  runReview,
  type Config,
  type ReviewEvent,
} from "@crewreview/engine";
import { buildRegistry, resolveHarness, runConformance, runProcess, which, type Harness } from "@crewreview/harness";
import { createTranslator, detectLocale, languageName, type Translator } from "@crewreview/i18n";
import pkg from "../../../package.json";
import { ConformanceStore } from "./conformance-store.ts";

const VERSION: string = pkg.version;

// `crewreview doctor | head` closes the pipe early; that's not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });
}
const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const style = color ? ANSI_STYLE : PLAIN_STYLE;
const errStyle = process.stderr.isTTY && !process.env.NO_COLOR ? ANSI_STYLE : PLAIN_STYLE;

function help(t: Translator): string {
  const cmd = (name: string, text: string) => `  ${name.padEnd(28)} ${text}`;
  return [
    `crewreview ${VERSION}`,
    "",
    t.t("cli.usage"),
    "",
    `${t.t("cli.commands")}:`,
    cmd("local", t.t("cli.cmd.local")),
    cmd("doctor", t.t("cli.cmd.doctor")),
    cmd("version", t.t("cli.cmd.version")),
    cmd("help", t.t("cli.cmd.help")),
    "",
    `${t.t("cli.options")} (local):`,
    cmd("--base <ref>", t.t("cli.opt.base")),
    cmd("--uncommitted", t.t("cli.opt.uncommitted")),
    cmd("--harness <id>", t.t("cli.opt.harness")),
    cmd("--verifier-harness <id>", t.t("cli.opt.verifierHarness")),
    cmd("--lens <a,b>", t.t("cli.opt.lens")),
    cmd("--no-verify", t.t("cli.opt.noVerify")),
    cmd("--lang <code>", t.t("cli.opt.lang")),
    cmd("--json", t.t("cli.opt.json")),
    "",
    `${t.t("cli.options")} (doctor):`,
    cmd("--conformance", t.t("cli.opt.conformance")),
  ].join("\n");
}

function registryFor(config: Config) {
  const h = config.harness;
  return buildRegistry({ claude: h.claude, codex: h.codex, kiro: h.kiro, acp: h.acp, custom: h.custom });
}

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

/** A harness may review only when its read-only lock holds. ACP and custom harnesses must prove it first. */
async function reviewable(h: Harness, store: ConformanceStore): Promise<"ok" | "not-read-only" | "needs-conformance" | "failed-conformance"> {
  if (h.capabilities.readOnly !== "enforced") return "not-read-only";
  const det = await h.detect();
  const c = await store.get(h.id, det.version);
  if (c?.readOnly === "fail") return "failed-conformance";
  if (h.kind !== "native" || !["claude", "codex", "kiro"].includes(h.id)) {
    if (c?.readOnly !== "pass") return "needs-conformance";
  }
  return "ok";
}

async function doctor(t: Translator, config: Config, cfgPath: string, cfgExists: boolean, conformance: boolean): Promise<number> {
  const dirs = appDirs();
  const store = ConformanceStore.in(dirs.state);
  const registry = registryFor(config);
  out(style.bold(`${t.t("doctor.title")}  ${style.dim(VERSION)}`));
  out();
  out(style.bold(t.t("doctor.system")));
  out(`  ${platform()} ${arch()} · git ${(await gitVersion()) ?? style.red(t.t("doctor.missing"))}`);
  out(`  ${t.t("doctor.config").padEnd(8)} ${cfgPath}${cfgExists ? "" : style.dim(" (—)")}`);
  out(`  ${t.t("doctor.data").padEnd(8)} ${dirs.data}`);
  out();

  if (conformance) {
    for (const h of registry.values()) {
      if (!(await h.detect()).installed || h.capabilities.readOnly !== "enforced") continue;
      err(errStyle.dim(t.t("doctor.conformanceRunning", { name: h.id })));
      const r = await runConformance(h);
      await store.put(r);
      err(
        t.t("doctor.conformanceResult", {
          name: h.id,
          structured: t.t(`check.${r.structured}`),
          readOnly: t.t(`check.${r.readOnly}`),
          seconds: Math.round(r.durationMs / 1000),
        }) + (r.error ? errStyle.dim(` — ${r.failure ?? ""} ${r.error.split("\n")[0]}`) : ""),
      );
    }
    err();
  }

  out(style.bold(t.t("doctor.harnesses")));
  const cols = [t.t("doctor.col.harness"), t.t("doctor.col.status"), t.t("doctor.col.version"), t.t("doctor.col.readOnly"), t.t("doctor.col.write"), t.t("doctor.col.cost")];
  const rows: string[][] = [];
  let ready: string | undefined;
  for (const h of registry.values()) {
    const det = await h.detect();
    const c = det.installed ? await store.get(h.id, det.version) : undefined;
    const ro =
      h.capabilities.readOnly !== "enforced"
        ? t.t("doctor.no")
        : c?.readOnly === "pass"
          ? t.t("doctor.verified")
          : c?.readOnly === "fail"
            ? t.t("doctor.failedCheck")
            : t.t("doctor.byFlags");
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
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i]!.length)));
  out(style.dim(`  ${cols.map((c, i) => c.padEnd(widths[i]!)).join("  ")}`));
  for (const r of rows) out(`  ${r.map((c, i) => c.padEnd(widths[i]!)).join("  ")}`);
  out();

  out(style.bold(t.t("doctor.hosts")));
  for (const cli of ["gh", "glab"]) {
    const s = await signedIn(cli);
    out(`  ${cli.padEnd(6)} ${s === undefined ? style.dim(t.t("doctor.notInstalled")) : s ? style.green(t.t("doctor.signedIn")) : style.yellow(t.t("doctor.notSignedIn"))}`);
  }
  out();
  if (!conformance) out(style.dim(t.t("doctor.conformanceHint")));
  if (ready) {
    out(style.green(t.t("doctor.ready", { name: ready })));
    return 0;
  }
  out(style.red(t.t("doctor.notReady")));
  return 1;
}

interface LocalArgs {
  base?: string;
  uncommitted: boolean;
  harness?: string;
  verifierHarness?: string;
  lens?: string;
  verify: boolean;
  lang?: string;
  json: boolean;
}

async function pickHarness(t: Translator, config: Config, id: string, store: ConformanceStore): Promise<Harness | string> {
  const registry = registryFor(config);
  if (id !== "auto" && !registry.has(id)) return t.t("error.unknownHarness", { name: id });
  const h = await resolveHarness(registry, id);
  if (!h || !(await h.detect()).installed) return t.t("error.noHarness");
  const r = await reviewable(h, store);
  if (r === "needs-conformance") return t.t("error.needsConformance", { name: h.id });
  if (r !== "ok") return t.t("error.harnessNotReadOnly", { name: h.id });
  return h;
}

function progress(t: Translator) {
  const started = new Map<string, number>();
  return (e: ReviewEvent) => {
    if (e.type === "lens-start") {
      started.set(e.lens, Date.now());
      err(errStyle.dim(`▸ ${t.t("local.lensStarted", { lens: e.lens, harness: e.harness })}`));
    } else if (e.type === "verifier-start") {
      err(errStyle.dim(`▸ ${t.t("local.lensStarted", { lens: t.t("local.verifier"), harness: e.harness })}`));
    } else if (e.type === "agent" && e.event.type === "tool" && process.env.CREWREVIEW_DEBUG) {
      err(errStyle.dim(`    ${e.role}: ${e.event.text}`));
    }
  };
}

async function local(t: Translator, config: Config, a: LocalArgs): Promise<number> {
  const dirs = appDirs();
  const store = ConformanceStore.in(dirs.state);
  let target;
  try {
    target = await localTarget({ cwd: process.cwd(), base: a.base, uncommitted: a.uncommitted });
  } catch (e) {
    if (e instanceof LocalTargetError) {
      err(e.code === "not-git-repo" ? t.t("error.notGitRepo", { path: process.cwd() }) : e.code === "no-base" ? t.t("error.noBase") : t.t("error.badRef", { ref: e.details.ref ?? "?" }));
      return 2;
    }
    throw e;
  }

  const harness = await pickHarness(t, config, a.harness ?? config.harness.default, store);
  if (typeof harness === "string") {
    err(harness);
    return 2;
  }
  const verifierId = a.verifierHarness ?? config.harness.verifier;
  const verifier = verifierId ? await pickHarness(t, config, verifierId, store) : harness;
  if (typeof verifier === "string") {
    err(verifier);
    return 2;
  }

  const all = await loadLenses(target.root, target.rulesRef);
  const known = all.map((l) => l.id);
  const wanted = a.lens ? a.lens.split(",").map((s) => s.trim()).filter(Boolean) : config.review.lenses;
  for (const id of wanted) {
    if (!known.includes(id)) {
      err(t.t("error.unknownLens", { name: id, list: known.join(", ") }));
      return 2;
    }
  }
  // Lenses the repository added run too, unless the user picked a subset.
  const extra = a.lens ? [] : all.filter((l) => l.source === "repo" && !BUILTIN_LENS_IDS.includes(l.id)).map((l) => l.id);
  const lenses = all.filter((l) => wanted.includes(l.id) || extra.includes(l.id));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jobDir = join(dirs.state, "runs", `${stamp}-${target.headSha.slice(0, 8)}`);
  const language = languageName(a.lang ?? config.review.commentLanguage ?? t.locale);

  try {
    const report = await runReview(
      {
        target,
        jobDir,
        lenses,
        partial: a.lens !== undefined,
        harness,
        verifier,
        config: { ...config, review: { ...config.review, verifier: a.verify && config.review.verifier } },
        language,
        policy: config.review.policy,
        onEvent: a.json ? undefined : progress(t),
      },
      VERSION,
    );
    const mdPath = join(jobDir, "report.md");
    await writeFile(mdPath, renderMarkdown(report, t));
    if (a.json) out(JSON.stringify(report, null, 2));
    else {
      err();
      out(renderTerminal(report, t, style));
      out(style.dim(`${t.t("local.report")}: ${mdPath}`));
    }
    return 0;
  } catch (e) {
    if (e instanceof ReviewError) {
      if (e.code === "no-changes") err(t.t("error.noChanges", { base: target.base, head: target.branch }));
      else if (e.code === "diff-too-large") err(t.t("error.diffTooLarge", { lines: e.details.lines ?? "?", limit: e.details.limit ?? "?" }));
      else err(t.t("error.allLensesFailed"));
      return 2;
    }
    throw e;
  }
}

async function main(argv: string[]): Promise<number> {
  const [command = "help", ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    allowPositionals: false,
    strict: true,
    options: {
      base: { type: "string" },
      uncommitted: { type: "boolean", default: false },
      harness: { type: "string" },
      "verifier-harness": { type: "string" },
      lens: { type: "string" },
      "no-verify": { type: "boolean", default: false },
      lang: { type: "string" },
      json: { type: "boolean", default: false },
      conformance: { type: "boolean", default: false },
    },
  });

  let loaded;
  try {
    loaded = await loadConfig(configFile());
  } catch (e) {
    const t = createTranslator(detectLocale());
    if (e instanceof ConfigError) {
      err(t.t("error.config", { path: e.path, message: e.message }));
      return 2;
    }
    throw e;
  }
  const t = createTranslator(detectLocale(loaded.config.language));

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      out(help(t));
      return 0;
    case "version":
    case "--version":
    case "-v":
      out(VERSION);
      return 0;
    case "doctor":
      return doctor(t, loaded.config, loaded.path, loaded.exists, values.conformance);
    case "local":
      return local(t, loaded.config, {
        base: values.base,
        uncommitted: values.uncommitted,
        harness: values.harness,
        verifierHarness: values["verifier-harness"],
        lens: values.lens,
        verify: !values["no-verify"],
        lang: values.lang,
        json: values.json,
      });
    default:
      err(t.t("cli.unknownCommand", { name: command }));
      err();
      err(help(t));
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  err(e instanceof Error ? e.message : String(e));
  process.exitCode = 2;
}

