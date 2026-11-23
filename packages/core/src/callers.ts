/**
 * The functions a change defines or modifies, read from its diff: their callers are where a changed contract breaks,
 * and those callers usually aren't in the diff. Heuristic and language-agnostic on purpose: a name too many is cheap
 * (its uses are listed and judged), a name missed is the bug that gets through.
 */
export interface ChangedSymbol {
  name: string;
  /** The file it's defined in. */
  path: string;
}

// One name per line, the first pattern that fits. Elixir/Ruby/Python def, JS/TS function and arrow constants,
// Go func, Rust fn, Kotlin fun, and Java/C#-style methods after a modifier.
const DEFS: RegExp[] = [
  /\bdef(?:p|macro|macrop)?\s+(?:self\.)?([A-Za-z_][\w]*[?!]?)/,
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[[(]/,
  /\bfn\s+([A-Za-z_]\w*)/,
  /\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/,
  /\b(?:public|private|protected|internal)\s+(?:(?:static|final|abstract|async|override|virtual|synchronized|suspend)\s+)*[\w<>[\],.? ]+?\s+([A-Za-z_]\w*)\s*\(/,
  /^\s*(?:(?:export|public|private|protected|static|async|override|readonly)\s+)*(?!(?:if|for|while|switch|catch|return|new|await|typeof|else)\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^={;]+)?\{\s*$/,
];

const COMMON = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "new", "constructor", "render", "main", "init",
  "setup", "test", "describe", "it", "get", "set", "run", "call", "apply", "handle", "update", "create", "delete",
  "to_string", "toString", "equals", "hashCode", "mount", "index", "show", "new", "edit", "list",
]);
const TEST_FILE = /(^|\/)(test|tests|spec|specs|__tests__)\/|[._-](test|spec)\.[a-z]+$|_test\.exs?$/i;

function nameIn(line: string): string | undefined {
  for (const re of DEFS) {
    const m = re.exec(line);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/** The functions the diff defines, changes or removes, with the file each is in: at most `max`, in diff order. */
export function changedSymbols(diff: string, max = 30): ChangedSymbol[] {
  const out: ChangedSymbol[] = [];
  const seen = new Set<string>();
  let path: string | undefined;
  // File headers only come between "diff --git" and the first hunk: a removed "-- comment" line reads as "--- …".
  let header = false;
  let enclosing: string | undefined;
  const add = (name: string | undefined) => {
    if (!name || !path || TEST_FILE.test(path) || name.length < 4 || COMMON.has(name) || seen.has(name)) return;
    seen.add(name);
    out.push({ name, path });
  };
  for (const line of diff.split("\n")) {
    if (out.length >= max) break;
    if (line.startsWith("diff --git")) {
      path = undefined;
      header = true;
      continue;
    }
    if (header && line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      path = p === "/dev/null" ? path : p.replace(/^b\//, "");
      continue;
    }
    if (header && line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      // A deleted file keeps its old name: its callers are the ones that break.
      if (p !== "/dev/null") path = p.replace(/^a\//, "");
      continue;
    }
    // git puts the enclosing function after the hunk range, when it knows the language; otherwise the last
    // definition above the change, in the hunk's own lines, is the one whose body it changes.
    const hunk = /^@@ [^@]+ @@ ?(.*)$/.exec(line);
    if (hunk) {
      header = false;
      enclosing = nameIn(hunk[1] ?? "");
      continue;
    }
    if (header) continue;
    const mark = line[0];
    if (mark !== " " && mark !== "+" && mark !== "-") continue;
    const defined = nameIn(line.slice(1));
    if (mark === " ") {
      if (defined) enclosing = defined;
      continue;
    }
    add(defined ?? enclosing);
    if (defined) enclosing = defined;
  }
  return out;
}
