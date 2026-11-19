import { atLeast, type Finding } from "./model.ts";

const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "are", "was", "but", "not", "can", "will", "when", "which",
  "into", "has", "have", "its", "than", "then", "there", "their", "should", "could", "would", "may", "might",
  "uma", "para", "com", "que", "não", "por", "como", "mais", "isso", "esse", "essa", "este", "esta", "pode",
]);

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}_]+/u)) {
    if (w.length > 2 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Share of `part`'s tokens that also appear in `whole`. */
export function containment(part: Set<string>, whole: Set<string>): number {
  if (part.size === 0) return 0;
  let n = 0;
  for (const t of part) if (whole.has(t)) n++;
  return n / part.size;
}

function text(f: Pick<Finding, "title" | "body">): Set<string> {
  return tokens(`${f.title} ${f.title} ${f.body.slice(0, 400)}`);
}

/** Code names a finding talks about: `backticked` spans, camelCase and snake_case words. */
export function identifiers(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/`([^`\n]{2,60})`/g)) {
    const name = /[A-Za-z_$][\w$]*/.exec(m[1]!)?.[0];
    if (name && name.length >= 4) out.add(name.toLowerCase());
  }
  for (const m of s.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*_[a-z0-9_]+)\b/g)) out.add(m[1]!.toLowerCase());
  return out;
}

export interface DedupeOptions {
  /** Findings this many lines apart (or closer) on the same file may be duplicates. */
  lineWindow?: number;
  /** Similarity needed when the lines are the same (±1). */
  sameLineThreshold?: number;
  /** Similarity needed elsewhere within the window. */
  nearThreshold?: number;
  /** Similarity needed when both findings name the same code identifier in their titles. */
  sharedNameThreshold?: number;
}

function distance(a: Finding, b: Finding): number {
  const aEnd = a.endLine ?? a.line;
  const bEnd = b.endLine ?? b.line;
  if (a.line <= bEnd && b.line <= aEnd) return 0; // ranges overlap
  return Math.min(Math.abs(a.line - bEnd), Math.abs(b.line - aEnd));
}

function similar(a: Finding, b: Finding, o: Required<DedupeOptions>): boolean {
  if (a.path !== b.path) return false;
  const dist = distance(a, b);
  if (dist > o.lineWindow) return false;
  const sim = jaccard(text(a), text(b));
  if (sim >= (dist <= 1 ? o.sameLineThreshold : o.nearThreshold)) return true;
  // Two lenses describing one problem in their own words still name the same function or variable.
  const ia = identifiers(a.title);
  const shared = [...identifiers(b.title)].some((n) => ia.has(n));
  return shared && sim >= o.sharedNameThreshold;
}

const DEFAULTS: Required<DedupeOptions> = { lineWindow: 3, sameLineThreshold: 0.25, nearThreshold: 0.4, sharedNameThreshold: 0.1 };

/** Merge findings that different lenses reported about the same problem. The more severe wording wins. */
export function dedupeFindings(findings: readonly Finding[], options: DedupeOptions = {}): Finding[] {
  const o = { ...DEFAULTS, ...options };
  const out: Finding[] = [];
  for (const f of findings) {
    const idx = out.findIndex((g) => similar(g, f, o));
    if (idx === -1) {
      out.push({ ...f, lenses: [...new Set(f.lenses.length ? f.lenses : [f.lens])] });
      continue;
    }
    const g = out[idx]!;
    const winner = atLeast(f.severity, g.severity) && f.severity !== g.severity ? f : g;
    out[idx] = { ...winner, id: g.id, lenses: [...new Set([...g.lenses, ...f.lenses, f.lens])] };
  }
  return out;
}

export interface ExistingComment {
  path?: string;
  line?: number;
  body: string;
  resolved: boolean;
}

/** Drop findings that an existing discussion already covers (open or resolved): a point made once isn't made again. */
export function dedupeAgainstThreads(
  findings: readonly Finding[],
  threads: readonly ExistingComment[],
  options: DedupeOptions = {},
): { fresh: Finding[]; covered: { finding: Finding; thread: ExistingComment }[] } {
  const o = { ...DEFAULTS, ...options };
  const fresh: Finding[] = [];
  const covered: { finding: Finding; thread: ExistingComment }[] = [];
  for (const f of findings) {
    const ft = text(f);
    const title = tokens(f.title);
    const names = identifiers(f.title);
    const hit = threads.find((t) => {
      if (t.path !== undefined && t.path !== f.path) return false;
      // A thread is long and the finding short, so similarity of whole texts runs low. How much of the finding's
      // title shows up where the thread starts says more: a repeat of our own earlier finding scores near 1.
      const head = tokens(t.body.slice(0, 600));
      const contained = containment(title, head);
      const sameName = [...identifiers(t.body.slice(0, 600))].some((n) => names.has(n));
      const dist = t.line === undefined ? Infinity : Math.abs(t.line - f.line);
      if (t.path === undefined || dist > o.lineWindow) {
        // Review-level comment: only a strong textual match counts.
        return contained >= 0.8 || jaccard(ft, tokens(t.body)) >= 0.5;
      }
      if (contained >= 0.6 || (sameName && contained >= 0.4)) return true;
      return jaccard(ft, tokens(t.body)) >= (dist <= 1 ? o.sameLineThreshold : o.nearThreshold);
    });
    if (hit) covered.push({ finding: f, thread: hit });
    else fresh.push(f);
  }
  return { fresh, covered };
}
