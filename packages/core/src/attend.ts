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

export type ItemKind = "thread" | "review" | "comment";

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
];

export function sensitivePaths(paths: readonly string[]): string[] {
  return paths.filter((p) => SENSITIVE.some((re) => re.test(p)));
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
