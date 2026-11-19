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
`;

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

  /** When this head was first seen; records `now` the first time. */
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
    const r = this.db.query("SELECT COUNT(*) AS n FROM reviews WHERE repo = ? AND number = ? AND head_sha = ? AND status = 'failed'").get(repo, number, sha) as { n: number };
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
    return this.db.query("UPDATE reviews SET status = 'failed', error = 'interrupted', updated_at = ? WHERE status = 'running'").run(now).changes;
  }
}
