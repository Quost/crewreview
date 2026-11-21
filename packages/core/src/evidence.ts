import type { Finding } from "./model.ts";

/** Answers questions about files in the reviewed tree. `null` means the file does not exist. */
export interface FileOracle {
  lineCount(path: string): number | null;
}

/**
 * Normalize a path an agent cited into a safe repository-relative POSIX path, or null when it can't be one.
 * Agents run from a job folder that holds `head/` and `ctx/`, so a leading `head/` is accepted and removed.
 */
export function normalizeRepoPath(raw: string): string | null {
  let p = raw.trim().replace(/\\/g, "/");
  // "path:12" or "path#L12" slipped into the path field
  p = p.replace(/(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$/, "");
  while (p.startsWith("./")) p = p.slice(2);
  if (p.startsWith("head/")) p = p.slice(5);
  if (p === "" || p.startsWith("/") || /^[a-zA-Z]:\//.test(p)) return null;
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.some((s) => s === "..")) return null;
  return parts.join("/");
}

export type DropReason = "invalid-path" | "missing-file" | "line-out-of-range";

export interface EvidenceResult {
  kept: Finding[];
  dropped: { finding: Finding; reason: DropReason }[];
  /** Distinct cited paths that don't exist / distinct cited paths. */
  phantomRatio: number;
  /** The whole output looks invented: too many cited files don't exist. */
  hallucinated: boolean;
}

/**
 * Keep only findings that point at a real file and line. If two or more of the cited files don't exist and they are
 * at least half of those cited, the output as a whole is treated as hallucinated. One missing file only costs the
 * findings that cite it: a lens that cites a real file and one it got wrong is not inventing the whole review.
 */
export function checkEvidence(findings: readonly Finding[], oracle: FileOracle): EvidenceResult {
  const kept: Finding[] = [];
  const dropped: EvidenceResult["dropped"] = [];
  const cited = new Set<string>();
  const phantom = new Set<string>();

  for (const f of findings) {
    const path = normalizeRepoPath(f.path);
    if (path === null) {
      dropped.push({ finding: f, reason: "invalid-path" });
      continue;
    }
    cited.add(path);
    const lines = oracle.lineCount(path);
    if (lines === null) {
      phantom.add(path);
      dropped.push({ finding: f, reason: "missing-file" });
      continue;
    }
    if (!Number.isInteger(f.line) || f.line < 1 || f.line > Math.max(lines, 1)) {
      dropped.push({ finding: f, reason: "line-out-of-range" });
      continue;
    }
    const endLine = f.endLine !== undefined && f.endLine >= f.line ? Math.min(f.endLine, lines) : undefined;
    kept.push({ ...f, path, endLine: endLine !== undefined && endLine > f.line ? endLine : undefined });
  }

  const phantomRatio = cited.size === 0 ? 0 : phantom.size / cited.size;
  const hallucinated = phantom.size >= 2 && phantomRatio >= 0.5;
  return { kept: hallucinated ? [] : kept, dropped, phantomRatio, hallucinated };
}
