import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  extractJson,
  ciLogExcerpt,
  leftForOwner,
  linkSpent,
  makeMarker,
  parseMarker,
  parseAttendOutput,
  pendingItems,
  pickFailingJobs,
  redactSecrets,
  heldPaths,
  parseRawDiff,
  protectedFilesToEdit,
  sensitivePaths,
  specialModePaths,
  settled,
  situationItems,
  syncItem,
  syncPlan,
  type AttendDecision,
  type AttendItem,
  type LeftItem,
  type SyncPlan,
} from "@crewreview/core";
import { lastLines, runProcess, scrubEnv, type Harness } from "@crewreview/harness";
import { gitAuthEnv, type Permission } from "@crewreview/hosts";
import { createTranslator, languageName, matchLocale, type Translator } from "@crewreview/i18n";
import { crewreviewLink } from "@crewreview/core";
import { diffText, git, gitOk, mergeBase } from "./git.ts";
import { isPickError, pickReviewer, pickWriter, type PickError } from "./harnesses.ts";
import { pickLimits, watchQuota } from "./quota.ts";
import { fixedSeatChoice, type SeatChoice } from "./seats.ts";
import { fetchPull, isAncestor, type FetchedPull } from "./mirror.ts";
import type { HostAdapter } from "@crewreview/hosts";
import type { PrDeps, PrTarget } from "./pr.ts";
import { attendPrompt } from "./prompts.ts";
import type { LinkedRepo } from "./repos.ts";
import { addWorktree, ATTEND_DIR, changedPaths, commitAll, pushHead, removeWorktree, stagedModes } from "./worktree.ts";

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
  /** Items whose reply was posted; a retry may still need to resolve their thread. */
  replied?: string[];
  summary: string;
  changed: string[];
  sensitive: string[];
  validation: ValidationRun[];
  harness: string;
  /** Why an automatic run waits for you anyway. */
  forcedInbox?: "sensitive" | "links" | "validation-failed";
  /** Symlinks and submodules among the changes: they always wait for you. */
  links?: string[];
  /** The base was merged in to keep a stack in line, not because someone asked. */
  sync?: AttendSync;
}

/** Why a stacked branch took its base in: the pull request below moved (`stacked`) or was merged (`restack`). */
export interface AttendSync {
  why: "stacked" | "restack";
  parent: number;
  base: string;
}

export type AttendOutcome =
  | { kind: "nothing" }
  | { kind: "waiting"; reason: "settling" | "fork" | "not-yours" | "busy" }
  | { kind: "pending"; attendId: number; fixed: number; replies: number; forced?: AttendPayload["forcedInbox"]; links?: string[]; left?: LeftItem[] }
  | { kind: "done"; attendId: number; commit?: string; replies: number; resolved: number; unresolved: number; resolveError?: string; reReview: boolean; needsHuman: number; synced?: AttendSync; left?: LeftItem[] }
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

/** The project's own checks (the repository's validate commands), in order, stopping at the first that fails. */
export async function runChecks(commands: readonly string[], cwd: string, timeoutMs: number): Promise<ValidationRun[]> {
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

async function runAgent(c: SeatChoice, routed: boolean, d: AttendDeps, cwd: string, access: "read" | "write", prompt: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const h = c.harness;
  d.onEvent?.({ type: "attendant-start", harness: h.id, ...(routed ? { seat: c.seat } : {}) });
  const r = await h.run({
    prompt,
    cwd,
    access,
    timeoutMs: d.config.limits.agentTimeout,
    stallMs: d.config.limits.stallTimeout,
    model: c.model,
    effort: c.effort,
    signal: d.signal,
    onEvent: (event) => d.onEvent?.({ type: "agent", role: "attendant", event }),
  });
  // A seat at its usage limit pauses (with the seats that share it); the next job takes another.
  if (!r.ok && r.failure === "quota") c.limit(r.error ?? "quota");
  d.onEvent?.({ type: "attendant-done", ok: r.ok, error: r.ok ? undefined : r.failure === "quota" ? `quota: ${r.error ?? ""}` : r.error });
  return r.ok ? { ok: true, text: r.text } : { ok: false, error: `${r.failure}: ${r.error ?? ""}` };
}

/**
 * Answer the reviews on one of your pull requests: find what's pending, let the agent fix or reply in a worktree,
 * check its work, then publish (auto) or park it in the inbox. The agent never pushes or posts.
 */
export interface AttendOptions {
  /** The open pull request this one sits on (its branch is this one's base), from the daemon's listing. */
  parent?: { number: number; headRef: string; headSha: string };
}

export async function attendPullRequest(d: AttendDeps, x: PrTarget, number: number, mode: AttendMode, opts: AttendOptions = {}): Promise<AttendOutcome> {
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
  let candidates = pendingItems({ threads, reviews, rules, done });
  // The pull request's own state, when the repository asks for it: a conflict with its base, a red CI.
  if (s.fix && (s.conflicts || s.ci)) {
    const failing = s.ci ? await failingJobs(host, pr) : undefined;
    candidates.push(...situationItems({ headSha: pr.headSha, baseRef: pr.baseRef, conflicts: pr.conflicts, failing }, { conflicts: s.conflicts, ci: s.ci }, done));
  }

  // A stack moves bottom up: each branch takes in the one below as soon as it moves, and the base once it's merged.
  const fetch = () =>
    fetchPull({
      dataDir: d.dirs.data,
      repo: repo.ref,
      authEnv: gitAuthEnv(repo.ref, x.token),
      reference: repo.clone,
      number,
      baseRef: pr.baseRef,
      headRefspec: (local) => host.headRefspec(number, local),
    });
  let early: FetchedPull | undefined;
  let plan: Extract<SyncPlan, { kind: "merge" }> | undefined;
  let sync: AttendSync | undefined;
  if (s.fix && s.conflicts) {
    const link = d.store.stackLink(repo.id, number);
    if (opts.parent || (link && link.parentRef !== pr.baseRef)) {
      early = await fetch();
      const behind = !(await isAncestor(early.mirror, early.baseSha, early.headSha));
      const linkInHead = link ? await isAncestor(early.mirror, link.parentSha, early.headSha) : false;
      const input = { baseRef: pr.baseRef, parent: opts.parent, link, behind, linkInHead };
      if (mode !== "dry-run" && linkSpent(input)) d.store.dropStackLink(repo.id, number);
      const p = syncPlan(input);
      if (p.kind === "merge") {
        plan = p;
        const item = syncItem(p, { headSha: early.headSha, baseSha: early.baseSha, baseRef: pr.baseRef }, done);
        // The sync merges the base anyway: a conflict the host reports is part of it.
        if (item) {
          candidates = [...candidates.filter((i) => i.kind !== "conflict"), item];
          sync = { why: p.why, parent: p.parent, base: pr.baseRef };
        }
      }
    }
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

  // Taking the base in with nothing to resolve is git's job: no agent, so no harness needed either.
  const mechanical = !!early && items.every((i) => i.kind === "conflict") && (await mergesClean(early.mirror, early.headSha, early.baseSha, plan?.mergeBase));
  let seat: SeatChoice | undefined;
  let routed = false;
  if (!mechanical) {
    const limits = pickLimits(d.config, d.quota);
    // [roles] routes the attendant through seats, unless this repository names its own harness.
    const seats = s.harness ? undefined : d.seats?.picker("attend", { write: s.fix });
    const taken = seats ? await seats([]) : undefined;
    if (taken && isPickError(taken)) return { kind: "harness", error: taken };
    const pick = taken ? taken.harness : s.fix ? await pickWriter(d.registry, s.harness ?? d.config.harness.default, d.conformance, limits) : await pickReviewer(d.registry, s.harness ?? d.config.harness.default, d.conformance, limits);
    if (isPickError(pick)) return { kind: "harness", error: pick };
    routed = !!taken;
    seat = taken ?? fixedSeatChoice(pick, d.config);
  }
  const harnessId = seat?.harness.id ?? "git";

  const attendId = mode === "dry-run" ? undefined : d.store.startAttend({ repo: repo.id, number, title: pr.title, url: pr.url, headSha: pr.headSha });
  let worktree: string | undefined;
  let mirror: string | undefined;
  try {
    if (attendId !== undefined) {
      for (const old of d.store.staleAttends(repo.id, number, attendId)) if (old.worktree) await removeStale(old.worktree);
    }
    const fetched = early ?? (await fetch());
    mirror = fetched.mirror;
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const jobDir = join(d.dirs.state, "runs", `attend-${repo.id}-${number}-${stamp}`);
    worktree = await addWorktree(fetched.mirror, fetched.headSha, join(d.dirs.state, "work", `${repo.id}-${number}-${stamp}`));
    await mkdir(jobDir, { recursive: true });

    // A conflict: merge the base here (never a rebase: the push stays a fast-forward) and let the agent resolve it.
    let merging: { conflicted: string[] } | undefined;
    if (items.some((i) => i.kind === "conflict")) {
      // Some git versions want an identity even for a merge that doesn't commit yet: the same one the commit gets.
      const who = d.identity ? ["-c", `user.name=${d.identity.name}`, "-c", `user.email=${d.identity.email}`] : [];
      const conflicted = await startMerge(worktree, fetched.baseSha, plan?.mergeBase, who);
      if (conflicted) {
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
    const commented = protectedFilesToEdit(items);
    const base = { language, owner: me, fix: s.fix, dir: ATTEND_DIR, protectedFiles: commented, protectedMode: s.protectedFiles };
    let parsed: { decisions: AttendDecision[]; summary: string } | undefined;
    if (seat) {
      const first = await runAgent(seat, routed, d, worktree, access, attendPrompt(base));
      if (!first.ok) throw new Error(first.error);
      parsed = parseAttendOutput(extractJson(first.text), items);
      if (!parsed) throw new Error("parse: the answer wasn't valid JSON");
    } else {
      // A clean merge of the base is the whole answer; the checks below still have to pass.
      parsed = { decisions: items.map((i) => ({ key: i.key, action: "fixed" as const, reply: "" })), summary: "" };
    }

    let changed = s.fix ? await changedPaths(worktree) : [];
    let validation: ValidationRun[] = [];
    let forcedInbox: AttendPayload["forcedInbox"];
    if (changed.length && s.validate.length) {
      validation = await runChecks(s.validate, worktree, d.config.attend.validateTimeout);
      const failed = validation.find((v) => !v.ok);
      if (failed && seat) {
        // One more try with the failure in hand; then it's yours to look at.
        const second = await runAgent(seat, routed, d, worktree, access, attendPrompt({ ...base, failedCheck: `$ ${failed.command}\n${failed.output}` }));
        if (second.ok) parsed = parseAttendOutput(extractJson(second.text), items) ?? parsed;
        changed = await changedPaths(worktree);
        validation = await runChecks(s.validate, worktree, d.config.attend.validateTimeout);
      }
      if (validation.some((v) => !v.ok)) forcedInbox = "validation-failed";
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
    const paths = touched ?? changed;
    // A path rule can't see a symlink or a submodule pointer: git's modes can. During a merge, only what the agent
    // touched counts (a nested repository shows up as "dir/" among the untracked).
    let links: string[] = [];
    if (paths.length) {
      const mine = new Set(paths.map((p) => p.replace(/\/$/, "")));
      links = specialModePaths(parseRawDiff(await stagedModes(worktree))).filter((p) => !touched || mine.has(p));
    }
    const sensitive = [...new Set([...links, ...sensitivePaths(paths)])];
    // Protected files wait for you, unless the repository lets the ones a reviewer commented on go out. Symlinks and
    // submodules always wait.
    if (links.length) forcedInbox ??= "links";
    if (heldPaths(paths, commented, s.protectedFiles, links).length) forcedInbox ??= "sensitive";

    let commitSha: string | undefined;
    if (changed.length || merging) {
      // A sync says what it is in the title; its item's text isn't a change worth a line.
      const fixed = decisions.filter((x) => x.action === "fixed" && !x.key.startsWith("sync:"));
      const lines = [...new Set(fixed.map((f) => commitLine(items.find((i) => i.key === f.key), f.reply)))];
      const title = merging ? `Merge ${pr.baseRef} into ${pr.headRef}` : shorten(parsed.summary || "Address review feedback", 100);
      const message = [title, "", ...(lines.length ? [...lines, ""] : []), `Assisted-by: Crewreview ${d.version}${seat ? ` (${harnessId})` : ""}`].join("\n");
      commitSha = await commitAll(worktree, message, { signing: d.signing, identity: d.identity });
    }

    const payload: AttendPayload = { items, decisions, summary: parsed.summary, changed: paths, sensitive, validation, harness: harnessId, forcedInbox, ...(links.length ? { links } : {}), ...(sync ? { sync } : {}) };
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
      const left = leftForOwner(items, decisions);
      return { kind: "pending", attendId: attendId!, fixed: decisions.filter((x) => x.action === "fixed").length, replies, forced: forcedInbox, ...(links.length ? { links } : {}), ...(left.length ? { left } : {}) };
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
  } finally {
    seat?.done();
  }
}

/** Whether merging `base` into `head` needs nobody: git finds no conflict. `from` replaces the usual merge base. */
async function mergesClean(mirror: string, head: string, base: string, from?: string): Promise<boolean> {
  const r = await git(["merge-tree", "--write-tree", ...(from ? [`--merge-base=${from}`] : []), head, base], mirror);
  return r.code === 0;
}

/**
 * Start merging `base` into the worktree's HEAD without committing: the next commit is the merge. `from` replaces the
 * usual merge base (git 2.40+). Returns the files left with conflict markers, or undefined when there was nothing to
 * merge.
 */
async function startMerge(dir: string, base: string, from: string | undefined, who: string[]): Promise<string[] | undefined> {
  if (from) {
    const r = await git([...who, "merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${from}`, "HEAD", base], dir);
    // 0: clean, 1: conflicts. Anything else (an old git without --merge-base) falls back to a plain merge.
    if (r.code === 0 || r.code === 1) {
      const [tree, ...files] = r.stdout.split("\n");
      // The merged tree, conflict markers included, becomes the index and the working copy; MERGE_HEAD makes the
      // next commit a merge with the base as its second parent, like `git merge --no-commit` would.
      await gitOk(["read-tree", "--reset", "-u", tree!.trim()], dir);
      const mergeHead = (await gitOk(["rev-parse", "--git-path", "MERGE_HEAD"], dir)).trim();
      await writeFile(resolve(dir, mergeHead), `${base}\n`);
      return r.code === 1 ? [...new Set(files.map((f) => f.trim()).filter(Boolean))] : [];
    }
  }
  await git([...who, "merge", "--no-ff", "--no-commit", base], dir);
  if ((await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], dir)).code !== 0) return undefined;
  return (await git(["diff", "--name-only", "--diff-filter=U"], dir)).stdout.split("\n").filter(Boolean);
}

/**
 * The jobs that turned CI red, at most three, with the part of their logs that says what failed (secrets taken
 * out). Jobs that only gather the others' results go last.
 */
async function failingJobs(host: HostAdapter, pr: { headSha: string } & Parameters<HostAdapter["getChecks"]>[0]): Promise<{ name: string; log?: string }[] | undefined> {
  const checks = await host.getChecks(pr);
  if (checks.state !== "red") return undefined;
  const read: { name: string; log?: string }[] = [];
  for (const f of checks.failing.filter((x) => !x.allowedToFail).slice(0, 6)) {
    const raw = f.job && host.ciLog ? await host.ciLog(f.job).catch(() => undefined) : undefined;
    read.push({ name: f.name, log: raw });
  }
  return pickFailingJobs(read, 3).map((j) => ({ name: j.name, log: j.log ? redactSecrets(ciLogExcerpt(j.log)) : undefined }));
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
  // A retry after a failure further down finds our own commit already on the branch: that isn't stale.
  const alreadyPushed = Boolean(row.commitSha) && pr.headSha === row.commitSha;
  if (pr.headSha !== row.headSha && !alreadyPushed) {
    d.store.updateAttend(attendId, { status: "stale" });
    await finish();
    return { kind: "stale", attendId };
  }
  try {
    if (row.commitSha && !alreadyPushed) {
      const pushed = await pushHead(row.worktree, pr.headRef, gitAuthEnv(repo.ref, x.token));
      if (!pushed.ok) {
        d.store.updateAttend(attendId, { status: "stale", error: pushed.error });
        await finish();
        return { kind: "stale", attendId, error: pushed.error };
      }
    }
    const { t } = languageFor(repo, d);
    // A retry must not post a reply twice. The saved list covers a failure after some replies went out;
    // the markers on the host cover a crash between posting a reply and saving that list.
    const posted = new Set(payload.replied ?? []);
    const alreadyResolved = new Set<string>();
    for (const thread of await host.listThreads(row.number)) {
      if (thread.resolved) alreadyResolved.add(thread.id);
      for (const comment of thread.comments) {
        const marker = parseMarker(comment.body);
        if (marker?.kind === "reply" && marker.ref) posted.add(marker.ref);
      }
    }
    let replies = 0;
    let resolved = 0;
    const unresolved: string[] = [];
    for (const dec of payload.decisions) {
      if (dec.action === "needs-human" || !dec.reply.trim()) continue;
      const item = payload.items.find((i) => i.key === dec.key);
      if (!item) continue;
if (!posted.has(dec.key)) {
        const fixedIn = dec.action === "fixed" && row.commitSha ? ` · ${t.t("attend.fixedIn", { sha: row.commitSha.slice(0, 7) })}` : "";
        const crewreview = crewreviewLink("comment");
        const body = `${dec.reply.trim()}\n\n<sub>🤖 ${t.t("attend.footer", { crewreview })}${fixedIn}</sub>\n${makeMarker({ kind: "reply", ref: dec.key, version: d.version })}`;
        if (item.threadId) await host.reply(pr, item.threadId, body);
        else if (host.comment) await host.comment(pr, body);
        else continue;
        replies++;
        posted.add(dec.key);
        payload.replied = [...(payload.replied ?? []), dec.key];
        d.store.updateAttend(attendId, { payload: JSON.stringify(payload) });
      }
      if (dec.action === "fixed" && item.kind === "thread" && item.threadId && s.resolve && !alreadyResolved.has(item.threadId)) {
        // Resolving is a courtesy: the fix and the reply are already out. A failure is reported, not fatal.
        await host.resolve(pr, item.threadId).then(
          () => resolved++,
          (e) => unresolved.push(e instanceof Error ? e.message : String(e)),
        );
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
    d.store.updateAttend(attendId, { status: "done", error: unresolved[0]?.slice(0, 2000) ?? null });
    // Once the base is in after a merge below, later merges compare from the usual place again.
    if (payload.sync?.why === "restack" && row.commitSha) d.store.dropStackLink(repo.id, row.number);
    await finish();
    const synced = payload.sync && row.commitSha ? { synced: payload.sync } : {};
    // Which items are yours now, so you don't have to work out which threads were skipped.
    const left = leftForOwner(payload.items, payload.decisions);
    return { kind: "done", attendId, commit: row.commitSha ?? undefined, replies, resolved, unresolved: unresolved.length, resolveError: unresolved[0], reReview, needsHuman: human.length, ...synced, ...(left.length ? { left } : {}) };
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
