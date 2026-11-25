import { z } from "zod";
import { parseMarker } from "./markers.ts";

/** A comment thread, in the shape the attendant needs (mirrors the hosts' model without depending on it). */
export interface AttendThread {
  id: string;
  path?: string;
  line?: number;
  resolvable: boolean;
  resolved: boolean;
  outdated: boolean;
  comments: { id: string; author: string; authorIsBot: boolean; body: string; createdAt: string }[];
}

export interface AttendReview {
  id: string;
  author: string;
  state: string;
  body: string;
  submittedAt?: string;
}

/** `conflict` and `ci` aren't anyone's comment: the pull request itself needs work (opt-in per repository). */
export type ItemKind = "thread" | "review" | "comment" | "conflict" | "ci";

/** Something on your pull request that asks for an answer or a change. */
export interface AttendItem {
  /** Changes when someone adds to the thread, so a new comment is a new item. */
  key: string;
  kind: ItemKind;
  /** Where to reply. */
  threadId?: string;
  path?: string;
  line?: number;
  author: string;
  /** The text to act on: the whole thread for threads. */
  text: string;
  createdAt: string;
  /** Raised by Crewreview's own reviewer (the polish loop). */
  fromCrew: boolean;
}

export interface AttendRules {
  me: string;
  /** Bot logins (substring match) whose comments count, e.g. "copilot". */
  trustedBots: string[];
  /** Also act on findings Crewreview's reviewer posted on your pull request. */
  fromCrew: boolean;
}

export interface PendingInput {
  threads: readonly AttendThread[];
  reviews: readonly AttendReview[];
  rules: AttendRules;
  /** Keys already handled or given up on. */
  done: ReadonlySet<string>;
}

const isMine = (author: string, me: string) => author.toLowerCase() === me.toLowerCase();

function trusted(c: { author: string; authorIsBot: boolean }, r: AttendRules): boolean {
  if (isMine(c.author, r.me)) return false;
  if (c.authorIsBot) return r.trustedBots.some((b) => c.author.toLowerCase().includes(b.toLowerCase()));
  return true;
}

/**
 * What still needs an answer on your pull request. Pure: whether the authors may steer the agent (write access)
 * is checked separately, with the host.
 * - An unresolved thread whose last word isn't yours or Crewreview's answer.
 * - A review or a conversation comment with text, from someone else, not answered yet.
 */
export function pendingItems(i: PendingInput): AttendItem[] {
  const out: AttendItem[] = [];
  for (const th of i.threads) {
    const last = th.comments.at(-1);
    if (!last) continue;
    const lastMarker = parseMarker(last.body);
    if (lastMarker?.kind === "reply") continue; // we answered last
    if (isMine(last.author, i.rules.me) && lastMarker?.kind !== "finding") continue; // you answered last
    const first = th.comments[0]!;
    const crew = parseMarker(first.body)?.kind === "finding";
    if (th.resolvable) {
      if (th.resolved) continue;
      // Who started it decides whether it's an item: someone else, or (opt-in) our own reviewer.
      if (crew ? !i.rules.fromCrew : !trusted(first, i.rules) && !th.comments.some((c) => trusted(c, i.rules))) continue;
    } else {
      // A conversation comment: one comment, from someone else, that isn't ours.
      if (parseMarker(first.body)) continue;
      if (!trusted(first, i.rules) || first.body.trim() === "") continue;
    }
    const key = `${th.resolvable ? "thread" : "comment"}:${th.id}:${last.id}`;
    if (i.done.has(key)) continue;
    out.push({
      key,
      kind: th.resolvable ? "thread" : "comment",
      threadId: th.id,
      path: th.path,
      line: th.line,
      author: last.author,
      text: th.comments.map((c) => `${c.author}: ${c.body}`).join("\n\n"),
      createdAt: last.createdAt,
      fromCrew: crew,
    });
  }
  for (const r of i.reviews) {
    if (!r.body.trim() || isMine(r.author, i.rules.me) || parseMarker(r.body)) continue;
    if (r.state !== "changes_requested" && r.state !== "commented") continue;
    const key = `review:${r.id}`;
    if (i.done.has(key)) continue;
    out.push({ key, kind: "review", author: r.author, text: r.body, createdAt: r.submittedAt ?? "", fromCrew: false });
  }
  return out;
}

/** The state of your pull request that can ask for work too: a conflict with its base, a red CI. */
export interface Situation {
  headSha: string;
  baseRef: string;
  conflicts?: boolean;
  /** Only when CI is red: the failing jobs, with what their logs say about the failure when the host keeps them. */
  failing?: { name: string; log?: string }[];
}

/**
 * Items for a conflict with the base and a red CI, when the repository asks for them. Their keys name the head
 * commit, so each push gets one try and a handled one never comes back.
 */
export function situationItems(s: Situation, rules: { conflicts: boolean; ci: boolean }, done: ReadonlySet<string>): AttendItem[] {
  const out: AttendItem[] = [];
  const conflict = `conflict:${s.headSha}`;
  if (rules.conflicts && s.conflicts === true && !done.has(conflict)) {
    out.push({
      key: conflict,
      kind: "conflict",
      author: "",
      text: `This branch conflicts with ${s.baseRef}. ${s.baseRef} has been merged into the working copy: resolve every conflict marker in the listed files, keeping what both sides meant.`,
      createdAt: "",
      fromCrew: false,
    });
  }
  const ci = `ci:${s.headSha}`;
  if (rules.ci && s.failing?.length && !done.has(ci)) {
    const jobs = s.failing.map((f) => (f.log ? `Job "${f.name}" failed. From its log:\n${f.log}` : `Job "${f.name}" failed (no log available).`));
    out.push({ key: ci, kind: "ci", author: "", text: `CI failed on this commit.\n\n${jobs.join("\n\n")}`, createdAt: "", fromCrew: false });
  }
  return out;
}

/** Wait until the newest item is this old, so a whole review lands before the agent starts. */
export function settled(items: readonly AttendItem[], now: number, quietMs: number): boolean {
  const newest = Math.max(0, ...items.map((x) => Date.parse(x.createdAt) || 0));
  return now - newest >= quietMs;
}

/** Paths an automatic fix may never change without a person looking: CI, secrets, deployment, the crew's rules. */
const SENSITIVE = [
  /^\.github\/workflows\//,
  /^\.github\/actions\//,
  /(^|\/)\.gitlab-ci\.yml$/,
  /^\.gitlab\//,
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)(id_rsa|id_ed25519)/,
  /\.(pem|key|p12|pfx)$/,
  /(^|\/)Dockerfile$/,
  /^(deploy|infra|terraform|k8s|helm)\//,
  /^\.crewreview\//,
  /(^|\/)(AGENTS|CLAUDE)\.md$/,
  /(^|\/)CODEOWNERS$/,
  // What git does with files (attributes, submodules) and agents' own configuration (MCP servers, Claude's settings).
  /(^|\/)\.gitattributes$/,
  /(^|\/)\.gitmodules$/,
  /(^|\/)\.mcp\.json$/,
  /(^|\/)\.claude\//,
];

export function sensitivePaths(paths: readonly string[]): string[] {
  return paths.filter((p) => SENSITIVE.some((re) => re.test(p)));
}

/** Secrets and the crew's own folder: never changed by the attendant, whatever a comment asks. */
const NEVER = [/(^|\/)\.env(\..*)?$/, /(^|\/)(id_rsa|id_ed25519)/, /\.(pem|key|p12|pfx)$/, /^\.crewreview\//];

/**
 * Protected files (CI, deployment, the agents' rules) a reviewer commented on, or a merge with the base left in
 * conflict. The attendant may change those to do what that comment asks, or to resolve that conflict: a point raised
 * in review deserves an answer in code, and a merge isn't done until every file in it is. Secrets never.
 */
export function protectedFilesToEdit(items: readonly AttendItem[], conflicted: readonly string[] = []): string[] {
  const paths = [...items.filter((i) => i.kind === "thread" && i.path).map((i) => i.path!), ...(items.some((i) => i.kind === "conflict") ? conflicted : [])];
  return [...new Set(sensitivePaths(paths).filter((p) => !NEVER.some((re) => re.test(p))))];
}

/**
 * The protected files among those changed that make an automatic answer wait for you. With `auto`, the ones a
 * reviewer commented on go out like any other fix; anything else protected still waits.
 */
export function heldPaths(changed: readonly string[], commented: readonly string[], mode: "approve" | "auto", special: readonly string[] = []): string[] {
  const sensitive = sensitivePaths(changed);
  const byPath = mode === "auto" ? sensitive.filter((p) => !commented.includes(p)) : sensitive;
  // Symlinks and submodules always wait: no setting and no comment lets them go out on their own.
  return [...new Set([...special, ...byPath])];
}

/** One entry of `git diff --raw`: a path with its mode before and after ("000000" when it didn't exist). */
export interface ModeChange {
  path: string;
  oldMode: string;
  newMode: string;
}

/**
 * Parse `git diff --raw -z` output. Each entry is `:old new oldSha newSha status` then the path (two paths for a
 * rename or a copy; the new one counts). Anything that doesn't look like an entry is skipped.
 */
export function parseRawDiff(text: string): ModeChange[] {
  const parts = text.split("\0");
  const out: ModeChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const head = /^:(\d{6}) (\d{6}) \S+ \S+ ([A-Z])\d*$/.exec(parts[i]!.trim());
    if (!head) continue;
    const two = head[3] === "R" || head[3] === "C";
    const path = parts[two ? i + 2 : i + 1];
    i += two ? 2 : 1;
    if (path) out.push({ path, oldMode: head[1]!, newMode: head[2]! });
  }
  return out;
}

const SYMLINK = "120000";
const SUBMODULE = "160000";

/**
 * Changes that add, change or remove a symlink or a submodule pointer, on either side. A path rule can't see
 * those: a link can point anywhere (outside the repository, at a secret), and a submodule pulls in someone
 * else's code. They wait for a person, like secrets never go out on their own.
 */
export function specialModePaths(changes: readonly ModeChange[]): string[] {
  const special = (m: string) => m === SYMLINK || m === SUBMODULE;
  return [...new Set(changes.filter((c) => special(c.oldMode) || special(c.newMode)).map((c) => c.path))];
}

export const ATTEND_ACTIONS = ["fixed", "replied", "declined", "needs-human"] as const;
export type AttendAction = (typeof ATTEND_ACTIONS)[number];

const AttendDecision = z.object({
  key: z.string().min(1),
  action: z.enum(ATTEND_ACTIONS),
  reply: z.string().default(""),
});
export type AttendDecision = z.infer<typeof AttendDecision>;

/** The attendant's answer: one decision per item. Unknown keys are ignored; missing ones mean "needs a human". */
export function parseAttendOutput(value: unknown, items: readonly AttendItem[]): { decisions: AttendDecision[]; summary: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = (value as Record<string, unknown>).items;
  if (!Array.isArray(raw)) return undefined;
  const byKey = new Map<string, AttendDecision>();
  for (const x of raw) {
    const r = AttendDecision.safeParse(x);
    if (r.success) byKey.set(r.data.key, r.data);
  }
  const decisions = items.map((it) => byKey.get(it.key) ?? { key: it.key, action: "needs-human" as const, reply: "" });
  const summary = typeof (value as Record<string, unknown>).summary === "string" ? String((value as Record<string, unknown>).summary).slice(0, 300) : "";
  return { decisions, summary };
}

/** Where an item left for you is, enough to find it on the pull request. */
export interface LeftItem {
  kind: ItemKind;
  path?: string;
  line?: number;
  author?: string;
}

/** The items the attendant left for you, in the order they came, so the activity can say which ones. */
export function leftForOwner(items: readonly AttendItem[], decisions: readonly AttendDecision[]): LeftItem[] {
  const human = new Set(decisions.filter((d) => d.action === "needs-human").map((d) => d.key));
  return items
    .filter((i) => human.has(i.key))
    .map((i) => ({ kind: i.kind, ...(i.path ? { path: i.path } : {}), ...(i.line ? { line: i.line } : {}), ...(i.author ? { author: i.author } : {}) }));
}

/** One line of a round's summary: what was done with an item, where it was, and for declined or left items, why. */
export interface RoundLine {
  action: AttendDecision["action"];
  kind: AttendItem["kind"];
  path?: string;
  line?: number;
  author?: string;
  reason?: string;
}

/** The first sentence of a reply, on one line and at most `max` characters: enough to say why. */
export function firstSentence(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  const one = end === -1 ? flat : flat.slice(0, end + 1);
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/**
 * What one round of the attendant did, for a single comment on the pull request. Only when it touched at least
 * `min` items: one answered thread already says it all. Fixed and answered items say where; declined and left
 * ones also say why.
 */
export function roundSummary(items: readonly AttendItem[], decisions: readonly AttendDecision[], min = 2): RoundLine[] | undefined {
  const lines: RoundLine[] = [];
  for (const d of decisions) {
    const i = items.find((x) => x.key === d.key);
    if (!i) continue;
    const why = (d.action === "declined" || d.action === "needs-human") && d.reply.trim() ? firstSentence(d.reply) : "";
    lines.push({ action: d.action, kind: i.kind, ...(i.path ? { path: i.path } : {}), ...(i.line ? { line: i.line } : {}), ...(i.author ? { author: i.author } : {}), ...(why ? { reason: why } : {}) });
  }
  return lines.length >= min ? lines : undefined;
}

/** A project's own generator for files a merge leaves in conflict, like translation catalogs or lockfiles. */
export interface RegenerateRule {
  /** Globs: `*` stays in one folder, `**` crosses folders, `?` is one character. */
  paths: readonly string[];
  /** The command that rebuilds them, run in the checkout by Crewreview (never by the agent). */
  run: string;
  /** The side written before the command runs: the pull request's (default) or the base's. */
  take?: "head" | "base";
}

/** A glob as a regular expression over a path with `/` separators. */
export function globRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * Which conflicted files each generator rebuilds (the first rule that matches a file takes it), and which are left
 * for the agent to resolve by hand.
 */
export function regenerationPlan(conflicted: readonly string[], rules: readonly RegenerateRule[]): { runs: { rule: RegenerateRule; files: string[] }[]; rest: string[] } {
  const res = rules.map((r) => r.paths.map(globRegExp));
  const runs = rules.map((rule) => ({ rule, files: [] as string[] }));
  const rest: string[] = [];
  for (const f of conflicted) {
    const i = res.findIndex((list) => list.some((re) => re.test(f)));
    if (i === -1) rest.push(f);
    else runs[i]!.files.push(f);
  }
  return { runs: runs.filter((r) => r.files.length), rest };
}
