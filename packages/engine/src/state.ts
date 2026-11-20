import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ReviewStatus = "running" | "pending" | "posted" | "discarded" | "failed" | "skipped" | "stale";

export interface ReviewRow {
  id: number;
  repo: string;
  number: number;
  title: string;
  url: string;
  headSha: string;
  status: ReviewStatus;
  event: string | null;
  findings: number;
  jobDir: string | null;
  error: string | null;
  postedUrl: string | null;
  /** Fingerprint of the change (see patchFingerprint), to spot pushes that only merged the base. */
  signature: string | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS heads (
  repo TEXT NOT NULL, number INTEGER NOT NULL, sha TEXT NOT NULL, first_seen INTEGER NOT NULL,
  PRIMARY KEY (repo, number, sha)
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL, status TEXT NOT NULL, event TEXT, findings INTEGER NOT NULL DEFAULT 0,
  job_dir TEXT, error TEXT, posted_url TEXT, signature TEXT, note TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_pr ON reviews (repo, number, head_sha);
CREATE INDEX IF NOT EXISTS reviews_status ON reviews (status);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL, status TEXT NOT NULL, job_dir TEXT, worktree TEXT, commit_sha TEXT, payload TEXT,
  error TEXT, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attends_pr ON attends (repo, number);
CREATE TABLE IF NOT EXISTS attend_items (
  repo TEXT NOT NULL, number INTEGER NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY (repo, number, key)
);
`;

export type AttendStatus = "running" | "pending" | "done" | "discarded" | "failed" | "stale";
/** handled: answered or fixed. needs-human: left for you. ignored: author can't steer the agent. gave-up: too many failures. */
export type ItemStatus = "handled" | "needs-human" | "ignored" | "gave-up" | "trying";

export interface AttendRow {
  id: number;
  repo: string;
  number: number;
  title: string;
  url: string;
  headSha: string;
  status: AttendStatus;
  jobDir: string | null;
  worktree: string | null;
  commitSha: string | null;
  payload: string | null;
  error: string | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

const ATTEND_COLS = `id, repo, number, title, url, head_sha AS headSha, status, job_dir AS jobDir, worktree, commit_sha AS commitSha,
  payload, error, note, created_at AS createdAt, updated_at AS updatedAt`;

const COLS = `id, repo, number, title, url, head_sha AS headSha, status, event, findings, job_dir AS jobDir, error,
  posted_url AS postedUrl, signature, note, created_at AS createdAt, updated_at AS updatedAt`;

/** Durable state of the crew: which heads we saw, what we reviewed, what waits in the inbox. */
export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** When the crew first saw this head, without recording anything. */
  seenAt(repo: string, number: number, sha: string): number | undefined {
    const row = this.db.query("SELECT first_seen AS t FROM heads WHERE repo = ? AND number = ? AND sha = ?").get(repo, number, sha) as { t: number } | null;
    return row?.t;
  }

  /** When this head was first seen; records `now` (or the time given) the first time. */
  firstSeen(repo: string, number: number, sha: string, now = Date.now()): number {
    this.db.query("INSERT OR IGNORE INTO heads (repo, number, sha, first_seen) VALUES (?, ?, ?, ?)").run(repo, number, sha, now);
    const row = this.db.query("SELECT first_seen AS t FROM heads WHERE repo = ? AND number = ? AND sha = ?").get(repo, number, sha) as { t: number };
    return row.t;
  }

  /** The latest review that counts as done for its head: posted, waiting, discarded or skipped. */
  lastDone(repo: string, number: number): ReviewRow | undefined {
    return (this.db
      .query(`SELECT ${COLS} FROM reviews WHERE repo = ? AND number = ? AND status IN ('posted','pending','discarded','skipped','stale') ORDER BY id DESC LIMIT 1`)
      .get(repo, number) ?? undefined) as ReviewRow | undefined;
  }

  /** The latest review that reached the host or the inbox with a real result (for delta and merge-only checks). */
  lastReviewed(repo: string, number: number): ReviewRow | undefined {
    return (this.db
      .query(`SELECT ${COLS} FROM reviews WHERE repo = ? AND number = ? AND status IN ('posted','pending','discarded') ORDER BY id DESC LIMIT 1`)
      .get(repo, number) ?? undefined) as ReviewRow | undefined;
  }

  failures(repo: string, number: number, sha: string): number {
    // Login and quota failures say nothing about the pull request: they don't count.
    const r = this.db
      .query("SELECT COUNT(*) AS n FROM reviews WHERE repo = ? AND number = ? AND head_sha = ? AND status = 'failed' AND COALESCE(error, '') NOT LIKE 'auth:%' AND COALESCE(error, '') NOT LIKE 'quota:%'")
      .get(repo, number, sha) as { n: number };
    return r.n;
  }

  start(r: { repo: string; number: number; title: string; url: string; headSha: string }, now = Date.now()): number {
    const res = this.db
      .query("INSERT INTO reviews (repo, number, title, url, head_sha, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)")
      .run(r.repo, r.number, r.title, r.url, r.headSha, now, now);
    return Number(res.lastInsertRowid);
  }

  update(id: number, fields: Partial<Pick<ReviewRow, "status" | "event" | "findings" | "jobDir" | "error" | "postedUrl" | "signature" | "note" | "headSha">>, now = Date.now()): void {
    const map: Record<string, string> = { status: "status", event: "event", findings: "findings", jobDir: "job_dir", error: "error", postedUrl: "posted_url", signature: "signature", note: "note", headSha: "head_sha" };
    const keys = Object.keys(fields).filter((k) => k in map);
    if (keys.length === 0) return;
    const sql = `UPDATE reviews SET ${keys.map((k) => `${map[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`;
    this.db.query(sql).run(...keys.map((k) => (fields as Record<string, string | number | null>)[k] ?? null), now, id);
  }

  staleOthers(repo: string, number: number, keepId: number, now = Date.now()): number {
    return this.db
      .query("UPDATE reviews SET status = 'stale', updated_at = ? WHERE repo = ? AND number = ? AND status = 'pending' AND id != ?")
      .run(now, repo, number, keepId).changes;
  }

  get(id: number): ReviewRow | undefined {
    return (this.db.query(`SELECT ${COLS} FROM reviews WHERE id = ?`).get(id) ?? undefined) as ReviewRow | undefined;
  }

  inbox(): ReviewRow[] {
    return this.db.query(`SELECT ${COLS} FROM reviews WHERE status = 'pending' ORDER BY id`).all() as ReviewRow[];
  }

  recent(limit = 20): ReviewRow[] {
    return this.db.query(`SELECT ${COLS} FROM reviews ORDER BY id DESC LIMIT ?`).all(limit) as ReviewRow[];
  }

  /** Runs left as 'running' by a crash or a kill become failed, so they can be retried. */
  recoverInterrupted(now = Date.now()): number {
    const a = this.db.query("UPDATE reviews SET status = 'failed', error = 'interrupted', updated_at = ? WHERE status = 'running'").run(now).changes;
    const b = this.db.query("UPDATE attends SET status = 'failed', error = 'interrupted', updated_at = ? WHERE status = 'running'").run(now).changes;
    return a + b;
  }

  // ---- attendant ----

  /** Item keys that need no more work: handled, left for you, ignored or given up. */
  attendDone(repo: string, number: number): Set<string> {
    const rows = this.db.query("SELECT key FROM attend_items WHERE repo = ? AND number = ? AND status != 'trying'").all(repo, number) as { key: string }[];
    return new Set(rows.map((r) => r.key));
  }

  markItems(repo: string, number: number, keys: readonly string[], status: ItemStatus, now = Date.now()): void {
    const q = this.db.query(
      "INSERT INTO attend_items (repo, number, key, status, attempts, updated_at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT (repo, number, key) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
    );
    for (const k of keys) q.run(repo, number, k, status, now);
  }

  /** Count a failed try for each key; the ones that reached the limit are given up. Returns those. */
  failItems(repo: string, number: number, keys: readonly string[], max: number, now = Date.now()): string[] {
    const up = this.db.query(
      "INSERT INTO attend_items (repo, number, key, status, attempts, updated_at) VALUES (?, ?, ?, 'trying', 1, ?) ON CONFLICT (repo, number, key) DO UPDATE SET attempts = attempts + 1, updated_at = excluded.updated_at",
    );
    const get = this.db.query("SELECT attempts FROM attend_items WHERE repo = ? AND number = ? AND key = ?");
    const gaveUp: string[] = [];
    for (const k of keys) {
      up.run(repo, number, k, now);
      if ((get.get(repo, number, k) as { attempts: number }).attempts >= max) gaveUp.push(k);
    }
    if (gaveUp.length) this.markItems(repo, number, gaveUp, "gave-up", now);
    return gaveUp;
  }

  /** Give items that were given up (or half-tried) another chance. Returns how many. */
  resetItems(repo: string, number: number): number {
    return this.db.query("DELETE FROM attend_items WHERE repo = ? AND number = ? AND status IN ('gave-up', 'trying')").run(repo, number).changes;
  }

  /** An answer for this pull request is being prepared right now (in this or another process). */
  attending(repo: string, number: number, staleAfterMs = 60 * 60_000, now = Date.now()): boolean {
    const r = this.db.query("SELECT COUNT(*) AS n FROM attends WHERE repo = ? AND number = ? AND status = 'running' AND updated_at > ?").get(repo, number, now - staleAfterMs) as { n: number };
    return r.n > 0;
  }

  /** Published answers on this pull request that took findings from Crewreview's own reviewer. */
  polishRounds(repo: string, number: number): number {
    const rows = this.db.query("SELECT payload FROM attends WHERE repo = ? AND number = ? AND status = 'done' AND payload IS NOT NULL").all(repo, number) as { payload: string }[];
    return rows.filter((r) => (JSON.parse(r.payload) as { items: { fromCrew: boolean }[] }).items.some((i) => i.fromCrew)).length;
  }

  startAttend(r: { repo: string; number: number; title: string; url: string; headSha: string }, now = Date.now()): number {
    const res = this.db
      .query("INSERT INTO attends (repo, number, title, url, head_sha, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)")
      .run(r.repo, r.number, r.title, r.url, r.headSha, now, now);
    return Number(res.lastInsertRowid);
  }

  updateAttend(id: number, fields: Partial<Pick<AttendRow, "status" | "jobDir" | "worktree" | "commitSha" | "payload" | "error" | "note">>, now = Date.now()): void {
    const map: Record<string, string> = { status: "status", jobDir: "job_dir", worktree: "worktree", commitSha: "commit_sha", payload: "payload", error: "error", note: "note" };
    const keys = Object.keys(fields).filter((k) => k in map);
    if (keys.length === 0) return;
    this.db.query(`UPDATE attends SET ${keys.map((k) => `${map[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => (fields as Record<string, string | null>)[k] ?? null), now, id);
  }

  getAttend(id: number): AttendRow | undefined {
    return (this.db.query(`SELECT ${ATTEND_COLS} FROM attends WHERE id = ?`).get(id) ?? undefined) as AttendRow | undefined;
  }

  recentAttends(limit = 20): AttendRow[] {
    return this.db.query(`SELECT ${ATTEND_COLS} FROM attends ORDER BY id DESC LIMIT ?`).all(limit) as AttendRow[];
  }

  attendInbox(): AttendRow[] {
    return this.db.query(`SELECT ${ATTEND_COLS} FROM attends WHERE status = 'pending' ORDER BY id`).all() as AttendRow[];
  }

  /** Waiting fixes for older commits of the same pull request can't be pushed any more. */
  staleAttends(repo: string, number: number, keepId: number, now = Date.now()): AttendRow[] {
    const rows = this.db.query(`SELECT ${ATTEND_COLS} FROM attends WHERE repo = ? AND number = ? AND status = 'pending' AND id != ?`).all(repo, number, keepId) as AttendRow[];
    this.db.query("UPDATE attends SET status = 'stale', updated_at = ? WHERE repo = ? AND number = ? AND status = 'pending' AND id != ?").run(now, repo, number, keepId);
    return rows;
  }
}
