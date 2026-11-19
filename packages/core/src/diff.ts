export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Lines on the new side that appear in a hunk (context or added): where inline comments can go. */
  rightLines: Set<number>;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** Undo git's C-style quoting of paths with special characters ("a/caf\303\251.txt"). */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const next = body[i + 1];
    if (next !== undefined && /[0-7]/.test(next)) {
      const oct = body.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8));
      i += 3;
      continue;
    }
    const map: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v" };
    bytes.push(...new TextEncoder().encode(map[next ?? ""] ?? next ?? ""));
    i += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripPrefix(path: string, prefix: "a/" | "b/"): string {
  const p = unquoteGitPath(path.trim());
  return p.startsWith(prefix) ? p.slice(2) : p;
}

/** Parse `git diff` output (unified format, with or without renames). */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | undefined;
  let right = 0;
  let inHunk = false;

  const start = (path: string): DiffFile => {
    const f: DiffFile = { path, status: "modified", additions: 0, deletions: 0, binary: false, rightLines: new Set() };
    files.push(f);
    inHunk = false;
    return f;
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // Best guess from the header; refined by ---/+++ and rename lines.
      const m = /^diff --git (".*?"|\S+) (".*?"|\S+)$/.exec(line);
      cur = start(m ? stripPrefix(m[2]!, "b/") : line.slice(11));
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (line.startsWith("new file mode")) cur.status = "added";
      else if (line.startsWith("deleted file mode")) cur.status = "deleted";
      else if (line.startsWith("rename from ")) {
        cur.oldPath = unquoteGitPath(line.slice(12));
        cur.status = "renamed";
      } else if (line.startsWith("rename to ")) cur.path = unquoteGitPath(line.slice(10));
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") cur.binary = true;
      else if (line.startsWith("+++ ")) {
        const p = line.slice(4);
        if (p !== "/dev/null") cur.path = stripPrefix(p, "b/");
      }
    }
    const h = HUNK.exec(line);
    if (h) {
      right = Number(h[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      cur.additions++;
      cur.rightLines.add(right++);
    } else if (line.startsWith("-")) {
      cur.deletions++;
    } else if (line.startsWith(" ")) {
      cur.rightLines.add(right++);
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"
    } else if (line === "") {
      // A blank line inside a hunk is a context line whose leading space was stripped by some tools.
      // git itself always prints the space, so treat it as the end of the hunk.
      inHunk = false;
    }
  }
  return files;
}

export function totalChangedLines(files: readonly DiffFile[]): number {
  return files.reduce((n, f) => n + f.additions + f.deletions, 0);
}

/** Per-file "+a/-d" signature. Two pushes with the same signature changed the same lines: only the base moved. */
export function changeSignature(files: readonly DiffFile[]): Record<string, string> {
  const sig: Record<string, string> = {};
  for (const f of files) sig[f.path] = `+${f.additions}/-${f.deletions}`;
  return sig;
}

export function sameSignature(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}
