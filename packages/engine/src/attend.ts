import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  extractJson,
  makeMarker,
  parseAttendOutput,
  pendingItems,
  redactSecrets,
  sensitivePaths,
  settled,
  situationItems,
  type AttendDecision,
  type AttendItem,
} from "@crewreview/core";
import { lastLines, runProcess, scrubEnv, type Harness } from "@crewreview/harness";
import { gitAuthEnv, type Permission } from "@crewreview/hosts";
import { createTranslator, languageName, matchLocale, type Translator } from "@crewreview/i18n";
import { diffText, git, gitOk, mergeBase } from "./git.ts";
import { isPickError, pickReviewer, pickWriter, type PickError } from "./harnesses.ts";
import { pickLimits, watchQuota } from "./quota.ts";
import { fetchPull } from "./mirror.ts";
import type { HostAdapter } from "@crewreview/hosts";
import type { PrDeps, PrTarget } from "./pr.ts";
import { attendPrompt } from "./prompts.ts";
import type { LinkedRepo } from "./repos.ts";
import { addWorktree, ATTEND_DIR, changedPaths, commitAll, pushHead, removeWorktree } from "./worktree.ts";

export type AttendMode = "inbox" | "auto" | "dry-run";

export interface ValidationRun {
  command: string;
  ok: boolean;
  output: string;
}

/** Everything one attendant run decided and did, kept until it's published. */
export interface AttendPayload {
  items: AttendItem[];
  decisions: AttendDecision[];
  summary: string;
  changed: string[];
  sensitive: string[];
  validation: ValidationRun[];
  harness: string;
  /** Why an automatic run waits for you anyway. */
  forcedInbox?: "sensitive" | "validation-failed";
}

export type AttendOutcome =
  | { kind: "nothing" }
  | { kind: "waiting"; reason: "settling" | "fork" | "not-yours" | "busy" }
  | { kind: "pending"; attendId: number; fixed: number; replies: number; forced?: AttendPayload["forcedInbox"] }
  | { kind: "done"; attendId: number; commit?: string; replies: number; resolved: number; reReview: boolean; needsHuman: number }
  | { kind: "stale"; attendId: number; error?: string }
  | { kind: "failed"; attendId?: number; error: string }
  | { kind: "harness"; error: PickError }
  | { kind: "dry-run"; payload: AttendPayload; diff: string };

export interface AttendDeps extends PrDeps {
  /** "off" never signs commits (tests). Default: your git config decides. */
  signing?: "inherit" | "off";
  /** Commit identity; default: your git config. */
  identity?: { name: string; email: string };
  now?: () => number;
}

function languageFor(repo: LinkedRepo, d: PrDeps): { t: Translator; language: string } {
  const code = repo.attend.commentLanguage ?? repo.review.commentLanguage ?? d.config.review.commentLanguage ?? d.ui.locale;
  return { t: createTranslator(matchLocale(code) ?? "en"), language: languageName(code) };
}

async function runChecks(commands: readonly string[], cwd: string, timeoutMs: number): Promise<ValidationRun[]> {
  const out: ValidationRun[] = [];
  for (const command of commands) {
    const argv = process.platform === "win32" ? ["cmd", "/d", "/s", "/c", command] : ["sh", "-c", command];
    const r = await runProcess({ argv, cwd, env: scrubEnv(process.env), timeoutMs });
    const ok = r.exitCode === 0 && !r.timedOut;
    out.push({ command, ok, output: redactSecrets(lastLines(`${r.stdout}\n${r.stderr}`, 60)) });
    if (!ok) break;
  }
  return out;
}

/** Cut at a word boundary, with an ellipsis, to keep commit lines readable. */
export function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:—-]+$/, "")}…`;
}

/** "- src/users.ts:15 SQL injection in findUserByEmail" from the item's first line, without markdown. */
export function commitLine(item: AttendItem | undefined, reply: string): string {
  const where = item?.path ? `${item.path}${item.line ? `:${item.line}` : ""}` : (item?.author ?? "");
  const first = (item?.text ?? reply).split("\n").find((l) => l.trim()) ?? "";
  const plain = first
    .replace(/^[^:]{1,40}:\s*/, "") // "author: "
    .replace(/<!--.*?-->/g, "")
    .replace(/[*_`]/g, "")
    .replace(/^\p{Extended_Pictographic}\S*\s*/u, "")
    .replace(/^\S+\s+·\s+[^—]*—\s*/, ""); // "blocker · security — "
  return shorten(`- ${where} ${plain || reply}`, 100);
}

async function discardChanges(dir: string): Promise<void> {
  await git(["checkout", "--", "."], dir);
  await git(["clean", "-fdq", "-e", ATTEND_DIR], dir);
}

async function runAgent(h: Harness, d: AttendDeps, cwd: string, access: "read" | "write", prompt: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const s = (d.config.harness as Record<string, { model?: string; effort?: string } | undefined>)[h.id] ?? {};
  d.onEvent?.({ type: "attendant-start", harness: h.id });
  const r = await h.run({
    prompt,
    cwd,
    access,
    timeoutMs: d.config.limits.agentTimeout,
    stallMs: d.config.limits.stallTimeout,
    model: s.model,
    effort: s.effort,
    signal: d.signal,
    onEvent: (event) => d.onEvent?.({ type: "agent", role: "attendant", event }),
  });
  d.onEvent?.({ type: "attendant-done", ok: r.ok, error: r.ok ? undefined : r.error });
  return r.ok ? { ok: true, text: r.text } : { ok: false, error: `${r.failure}: ${r.error ?? ""}` };
}

/**
 * Answer the reviews on one of your pull requests: find what's pending, let the agent fix or reply in a worktree,
 * check its work, then publish (auto) or park it in the inbox. The agent never pushes or posts.
 */
export async function attendPullRequest(d: AttendDeps, x: PrTarget, number: number, mode: AttendMode): Promise<AttendOutcome> {
  d = { ...d, onEvent: watchQuota(d.quota, d.onEvent) };
  const { repo, host } = x;
  const s = repo.attend;
  const now = d.now?.() ?? Date.now();
  const pr = await host.getPullRequest(number);
  const me = await host.whoami();
  if (pr.author.toLowerCase() !== me.toLowerCase()) return { kind: "waiting", reason: "not-yours" };
  if (pr.fromFork) return { kind: "waiting", reason: "fork" };
  // The daemon and a manual run must not answer the same pull request twice.
  if (mode !== "dry-run" && d.store.attending(repo.id, number)) return { kind: "waiting", reason: "busy" };

  const [threads, reviews] = await Promise.all([host.listThreads(number), host.listReviews(number)]);
  // The polish loop stops after a few rounds: a reviewer can always find one more nit.
  const polish = s.fromCrew && d.store.polishRounds(repo.id, number) < s.maxPolishRounds;
  const rules = { me, trustedBots: s.trustedBots, fromCrew: polish };
  const done = d.store.attendDone(repo.id, number);
  const candidates = pendingItems({ threads, reviews, rules, done });
  // The pull request's own state, when the repository asks for it: a conflict with its base, a red CI.
  if (s.fix && (s.conflicts || s.ci)) {
    const failing = s.ci ? await failingJobs(host, pr) : undefined;
    candidates.push(...situationItems({ headSha: pr.headSha, baseRef: pr.baseRef, conflicts: pr.conflicts, failing }, { conflicts: s.conflicts, ci: s.ci }, done));
  }

  // Only people who can push to the repository may steer the agent; listed bots and our own reviewer aside.
  const perms = new Map<string, Permission>();
  let items: AttendItem[] = [];
  const ignored: string[] = [];
  for (const it of candidates) {
    if (it.kind === "conflict" || it.kind === "ci") {
      items.push(it);
      continue;
    }
    const bot = s.trustedBots.some((b) => it.author.toLowerCase().includes(b.toLowerCase()));
    if (it.fromCrew || bot) {
      items.push(it);
      continue;
    }
    if (!perms.has(it.author)) perms.set(it.author, await host.permission(it.author));
    const p = perms.get(it.author);
    if (p === "write" || p === "admin") items.push(it);
    else ignored.push(it.key);
  }
  if (ignored.length && mode !== "dry-run") d.store.markItems(repo.id, number, ignored, "ignored");
  if (items.length === 0) return { kind: "nothing" };
  if (mode !== "dry-run" && !settled(items, now, d.config.attend.quiet)) return { kind: "waiting", reason: "settling" };

  const limits = pickLimits(d.config, d.quota);
  const pick = s.fix ? await pickWriter(d.registry, s.harness ?? d.config.harness.default, d.conformance, limits) : await pickReviewer(d.registry, s.harness ?? d.config.harness.default, d.conformance, limits);
  if (isPickError(pick)) return { kind: "harness", error: pick };
  const harness = pick;

  const attendId = mode === "dry-run" ? undefined : d.store.startAttend({ repo: repo.id, number, title: pr.title, url: pr.url, headSha: pr.headSha });
  let worktree: string | undefined;
  let mirror: string | undefined;
  try {
    if (attendId !== undefined) {
      for (const old of d.store.staleAttends(repo.id, number, attendId)) if (old.worktree) await removeStale(old.worktree);
    }
    const fetched = await fetchPull({
      dataDir: d.dirs.data,
      repo: repo.ref,
      authEnv: gitAuthEnv(repo.ref, x.token),
      reference: repo.clone,
      number,
      baseRef: pr.baseRef,
      headRefspec: (local) => host.headRefspec(number, local),
    });
    mirror = fetched.mirror;
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const jobDir = join(d.dirs.state, "runs", `attend-${repo.id}-${number}-${stamp}`);
    worktree = await addWorktree(fetched.mirror, fetched.headSha, join(d.dirs.state, "work", `${repo.id}-${number}-${stamp}`));
    await mkdir(jobDir, { recursive: true });

    // A conflict: merge the base here (never a rebase: the push stays a fast-forward) and let the agent resolve it.
    let merging: { conflicted: string[] } | undefined;
    if (items.some((i) => i.kind === "conflict")) {
      await git(["merge", "--no-ff", "--no-commit", fetched.baseSha], worktree);
      if ((await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree)).code === 0) {
        const conflicted = (await git(["diff", "--name-only", "--diff-filter=U"], worktree)).stdout.split("\n").filter(Boolean);
        merging = { conflicted };
        const list = conflicted.length ? conflicted.map((f) => `- ${f}`).join("\n") : "(none: the merge went through on its own)";
        items = items.map((i) => (i.kind === "conflict" ? { ...i, text: `${i.text}\n\nFiles with conflicts:\n${list}` } : i));
      }
    }

    const ctx = join(worktree, ATTEND_DIR);
    await mkdir(ctx, { recursive: true });
    const mb = await mergeBase(fetched.mirror, fetched.baseSha, fetched.headSha);
    await writeFile(join(ctx, "items.json"), JSON.stringify(items.map((it) => ({ ...it, text: redactSecrets(it.text) })), null, 2));
    await writeFile(join(ctx, "pr.md"), `# ${redactSecrets(pr.title)}\n\n${pr.headRef} → ${pr.baseRef}\n\n${redactSecrets(pr.body || "(no description)")}\n`);
    await writeFile(join(ctx, "diff.patch"), await diffText(fetched.mirror, mb, fetched.headSha));

    const { language } = languageFor(repo, d);
    const access = s.fix ? "write" : "read";
    const base = { language, owner: me, fix: s.fix, dir: ATTEND_DIR };
    const first = await runAgent(harness, d, worktree, access, attendPrompt(base));
    if (!first.ok) throw new Error(first.error);
    let parsed = parseAttendOutput(extractJson(first.text), items);
    if (!parsed) throw new Error("parse: the answer wasn't valid JSON");

    let changed = s.fix ? await changedPaths(worktree) : [];
    let validation: ValidationRun[] = [];
    let forcedInbox: AttendPayload["forcedInbox"];
    if (changed.length && s.validate.length) {
      validation = await runChecks(s.validate, worktree, d.config.attend.validateTimeout);
      const failed = validation.find((v) => !v.ok);
      if (failed) {
        // One more try with the failure in hand; then it's yours to look at.
        const second = await runAgent(harness, d, worktree, access, attendPrompt({ ...base, failedCheck: `$ ${failed.command}\n${failed.output}` }));
        if (second.ok) parsed = parseAttendOutput(extractJson(second.text), items) ?? parsed;
        changed = await changedPaths(worktree);
        validation = await runChecks(s.validate, worktree, d.config.attend.validateTimeout);
        if (validation.some((v) => !v.ok)) forcedInbox = "validation-failed";
      }
    }

    let decisions = parsed.decisions;
    if (items.some((i) => i.kind === "conflict")) {
      const conflictKey = items.find((i) => i.kind === "conflict")!.key;
      const unresolved: string[] = [];
      for (const f of merging?.conflicted ?? []) {
        const text = await readFile(join(worktree, f), "utf8").catch(() => "");
        if (/^(<{7}|={7}|>{7})( |$)/m.test(text)) unresolved.push(f);
      }
      if (!merging || unresolved.length) {
        // Half a merge is worse than none: undo all of it, and leave the conflict to you.
        if (merging) await git(["merge", "--abort"], worktree);
        merging = undefined;
        decisions = decisions.map((x) => (x.action === "fixed" || x.key === conflictKey ? { ...x, action: "needs-human" as const, reply: "" } : x));
        changed = [];
      } else {
        decisions = decisions.map((x) => (x.key === conflictKey ? { ...x, action: "fixed" as const } : x));
      }
    }
    // During a merge, what the agent changed: not what came from the base.
    const touched = merging ? await agentTouched(worktree) : undefined;
    if (merging?.conflicted.length) await gitOk(["add", "--", ...merging.conflicted], worktree);
    const claimsFix = decisions.some((x) => x.action === "fixed");
    if (merging) {
      // The merge itself is the fix for the conflict, whatever else changed.
    } else if (claimsFix && changed.length === 0) {
      // "Fixed" with nothing changed isn't fixed.
      decisions = decisions.map((x) => (x.action === "fixed" ? { ...x, action: "needs-human" as const } : x));
    } else if (!claimsFix && changed.length > 0) {
      await discardChanges(worktree);
      changed = [];
    }
    const sensitive = sensitivePaths(touched ?? changed);
    if (sensitive.length) forcedInbox ??= "sensitive";

    let commitSha: string | undefined;
    if (changed.length || merging) {
      const fixed = decisions.filter((x) => x.action === "fixed");
      const lines = [...new Set(fixed.map((f) => commitLine(items.find((i) => i.key === f.key), f.reply)))];
      const title = merging ? `Merge ${pr.baseRef} into ${pr.headRef}` : shorten(parsed.summary || "Address review feedback", 100);
      const message = [title, "", ...lines, "", `Assisted-by: Crewreview ${d.version} (${harness.id})`].join("\n");
      commitSha = await commitAll(worktree, message, { signing: d.signing, identity: d.identity });
    }

    const payload: AttendPayload = { items, decisions, summary: parsed.summary, changed: touched ?? changed, sensitive, validation, harness: harness.id, forcedInbox };
    await writeFile(join(jobDir, "attend.json"), JSON.stringify(payload, null, 2));
    const diff = commitSha ? (await git(["show", "--no-color", "--stat", "--patch", commitSha], worktree)).stdout : "";
    await writeFile(join(jobDir, "diff.patch"), diff);

    if (mode === "dry-run") {
      await removeWorktree(fetched.mirror, worktree);
      return { kind: "dry-run", payload, diff };
    }
    d.store.updateAttend(attendId!, { jobDir, worktree, commitSha: commitSha ?? null, payload: JSON.stringify(payload), note: forcedInbox ?? null });
    if (mode === "inbox" || forcedInbox) {
      d.store.updateAttend(attendId!, { status: "pending" });
      const replies = decisions.filter((x) => x.action !== "needs-human" && x.reply).length;
      return { kind: "pending", attendId: attendId!, fixed: decisions.filter((x) => x.action === "fixed").length, replies, forced: forcedInbox };
    }
    return await publishAttend(d, x, attendId!);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (attendId !== undefined) {
      // A login or quota problem isn't the comment's fault: it doesn't use up the item's attempts.
      if (!/^(auth|quota):/.test(error)) d.store.failItems(repo.id, number, items.map((i) => i.key), s.maxAttempts);
      d.store.updateAttend(attendId, { status: "failed", error: error.slice(0, 2000) });
    }
    if (worktree && mirror) await removeWorktree(mirror, worktree).catch(() => {});
    return { kind: "failed", attendId, error };
  }
}

/** The jobs that turned CI red, with the end of their logs (secrets taken out), at most three. */
async function failingJobs(host: HostAdapter, pr: { headSha: string } & Parameters<HostAdapter["getChecks"]>[0]): Promise<{ name: string; log?: string }[] | undefined> {
  const checks = await host.getChecks(pr);
  if (checks.state !== "red") return undefined;
  const out: { name: string; log?: string }[] = [];
  for (const f of checks.failing.filter((x) => !x.allowedToFail).slice(0, 3)) {
    const raw = f.job && host.ciLog ? await host.ciLog(f.job).catch(() => undefined) : undefined;
    out.push({ name: f.name, log: raw ? redactSecrets(lastLines(raw, 120)).slice(-6000) : undefined });
  }
  return out;
}

/** Files the agent changed during a merge: against the merged index, plus new ones. */
async function agentTouched(dir: string): Promise<string[]> {
  const edited = (await git(["diff", "--name-only"], dir)).stdout.split("\n").filter(Boolean);
  const added = (await git(["ls-files", "--others", "--exclude-standard"], dir)).stdout.split("\n").filter(Boolean);
  return [...new Set([...edited, ...added])];
}

async function removeStale(worktree: string): Promise<void> {
  // The mirror is the worktree's common dir; git finds it from inside.
  const common = (await git(["rev-parse", "--git-common-dir"], worktree)).stdout.trim();
  if (common) await removeWorktree(common, worktree).catch(() => {});
}

/** Push the commit (if any), post the replies, resolve fixed threads and ask reviewers to look again. */
export async function publishAttend(d: AttendDeps, x: PrTarget, attendId: number): Promise<AttendOutcome> {
  const row = d.store.getAttend(attendId);
  if (!row?.payload || !row.worktree) return { kind: "failed", attendId, error: "nothing to publish" };
  const payload = JSON.parse(row.payload) as AttendPayload;
  const { repo, host } = x;
  const s = repo.attend;
  const pr = await host.getPullRequest(row.number);
  const finish = async () => removeStale(row.worktree!);
  if (pr.headSha !== row.headSha) {
    d.store.updateAttend(attendId, { status: "stale" });
    await finish();
    return { kind: "stale", attendId };
  }
  try {
    if (row.commitSha) {
      const pushed = await pushHead(row.worktree, pr.headRef, gitAuthEnv(repo.ref, x.token));
      if (!pushed.ok) {
        d.store.updateAttend(attendId, { status: "stale", error: pushed.error });
        await finish();
        return { kind: "stale", attendId, error: pushed.error };
      }
    }
    const { t } = languageFor(repo, d);
    let replies = 0;
    let resolved = 0;
    for (const dec of payload.decisions) {
      if (dec.action === "needs-human" || !dec.reply.trim()) continue;
      const item = payload.items.find((i) => i.key === dec.key);
      if (!item) continue;
      const fixedIn = dec.action === "fixed" && row.commitSha ? ` · ${t.t("attend.fixedIn", { sha: row.commitSha.slice(0, 7) })}` : "";
      const body = `${dec.reply.trim()}\n\n<sub>🤖 ${t.t("attend.footer")}${fixedIn}</sub>\n${makeMarker({ kind: "reply", ref: dec.key, version: d.version })}`;
      if (item.threadId) await host.reply(pr, item.threadId, body);
      else if (host.comment) await host.comment(pr, body);
      else continue;
      replies++;
      if (dec.action === "fixed" && item.kind === "thread" && item.threadId && s.resolve) {
        await host.resolve(pr, item.threadId).then(() => resolved++, () => {});
      }
    }
    const handled = payload.decisions.filter((x) => x.action !== "needs-human").map((x) => x.key);
    const human = payload.decisions.filter((x) => x.action === "needs-human").map((x) => x.key);
    d.store.markItems(repo.id, row.number, handled, "handled");
    d.store.markItems(repo.id, row.number, human, "needs-human");

    let reReview = false;
    if (s.reReview && (row.commitSha || replies > 0)) {
      const reviewers = (await host.listReviews(row.number)).filter((r) => r.state === "changes_requested").map((r) => r.author);
      const askers = payload.items.filter((i) => !i.fromCrew && i.author).map((i) => i.author);
      reReview = await host.requestReReview(pr, [...reviewers, ...askers]).catch(() => false);
    }
    d.store.updateAttend(attendId, { status: "done" });
    await finish();
    return { kind: "done", attendId, commit: row.commitSha ?? undefined, replies, resolved, reReview, needsHuman: human.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    d.store.updateAttend(attendId, { error: error.slice(0, 2000), status: row.status === "pending" ? "pending" : "failed" });
    return { kind: "failed", attendId, error };
  }
}

/** Throw away a waiting fix: its items won't be picked up again. */
export async function discardAttend(d: PrDeps, attendId: number): Promise<boolean> {
  const row = d.store.getAttend(attendId);
  if (!row || row.status !== "pending") return false;
  const payload = row.payload ? (JSON.parse(row.payload) as AttendPayload) : undefined;
  if (payload) d.store.markItems(row.repo, row.number, payload.items.map((i) => i.key), "ignored");
  d.store.updateAttend(attendId, { status: "discarded" });
  if (row.worktree) await removeStale(row.worktree);
  return true;
}
