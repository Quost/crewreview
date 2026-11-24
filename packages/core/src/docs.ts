/**
 * What a change does to the things around the code that people read and operate by: environment variables, the docs
 * that describe the changed files, the examples and deploy notes that list settings. Found by code, so the docs lens
 * judges a short list instead of remembering to look.
 */

export interface EnvRead {
  name: string;
  path: string;
  /** Line on the new side, for a variable the change starts reading. */
  line?: number;
}

// One read of a variable by name, in the usual languages: Elixir, Node/Bun/Deno/Vite, Python, Ruby, Go, Rust, PHP,
// Java/Kotlin, C#, shell-style defaults in config files. The name is the first group.
const READS: RegExp[] = [
  /System\.(?:get_env|fetch_env!?)\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /\{:system,\s*"([A-Z][A-Z0-9_]+)"/g,
  /(?:process|Bun)\.env\.([A-Z][A-Z0-9_]+)/g,
  /(?:process|Bun)\.env\[\s*["'`]([A-Z][A-Z0-9_]+)["'`]\s*\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
  /Deno\.env\.get\(\s*["'`]([A-Z][A-Z0-9_]+)["'`]/g,
  /os\.(?:getenv|environ\.get)\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /os\.environ\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g,
  /ENV(?:\.fetch\(|\[)\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /os\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /env::var(?:_os)?\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /\b(?:getenv|env)\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /System\.getenv\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /Environment\.GetEnvironmentVariable\(\s*"([A-Z][A-Z0-9_]+)"/g,
];
/** `${NAME}` and `${NAME:-default}` read a variable only in config and scripts; in code it's string interpolation. */
const INTERPOLATED = /\$\{([A-Z][A-Z0-9_]+)(?::?[-=?][^}]*)?\}/g;
const CONFIG_LIKE = /\.(ya?ml|toml|ini|conf|cfg|properties|sh|bash|zsh|env)$|(^|\/)(Dockerfile|Containerfile|Procfile|Makefile)[^/]*$/i;

/** Variables every machine has, or that tooling sets: never a setting someone has to document. */
const AMBIENT = new Set(["PATH", "HOME", "USER", "PWD", "SHELL", "TERM", "LANG", "TMPDIR", "TZ", "CI", "NODE_ENV", "MIX_ENV", "RAILS_ENV", "PORT", "HOSTNAME", "DEBUG"]);

/** Where docs, examples and settings live: files a change can leave stale without breaking a test. */
export const DOC_FILE = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
export const ENV_EXAMPLE = /(^|\/)\.env(\.[\w-]+)?\.(example|sample|dist|template|defaults?)$|(^|\/)(example|sample)\.env$/i;
export const DEPLOY_DOC = /(^|\/)(deploy(ment|ing)?|runbook|operations?|install(ation)?|setup|configuration|environment)[^/]*\.(md|mdx|rst|adoc|txt)$/i;
export const TRANSLATION_FILE = /\.(po|pot)$|(^|\/)(locales?|i18n|translations?|lang)\/[^/]+\.(json|ya?ml|properties|xliff|xlf|strings|arb)$/i;
export const DECISION_RECORD = /(^|\/)(adrs?|decisions?|rfcs?)\/[^/]+\.(md|mdx|rst|adoc)$/i;

/** A file people read or operate by rather than run: docs, examples, deploy notes, translations, decisions. */
export function isDocOrSetting(path: string): boolean {
  return DOC_FILE.test(path) || ENV_EXAMPLE.test(path) || DEPLOY_DOC.test(path) || TRANSLATION_FILE.test(path) || DECISION_RECORD.test(path);
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function namesIn(line: string, path: string): string[] {
  const out: string[] = [];
  for (const re of CONFIG_LIKE.test(path) ? [...READS, INTERPOLATED] : READS) {
    re.lastIndex = 0;
    for (let m = re.exec(line); m; m = re.exec(line)) if (m[1] && !AMBIENT.has(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * The environment variables a change starts and stops reading, from its diff. A name read on an added line and on no
 * removed line is new; one read on a removed line and on no added line is gone (a rename shows as both). Reads in
 * docs, examples and tests don't count: they describe a setting, the code reads it.
 */
export function envChanges(diff: string): { added: EnvRead[]; removed: EnvRead[] } {
  const plus: EnvRead[] = [];
  const minus: EnvRead[] = [];
  let path = "";
  let right = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      path = "";
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("+++ ")) path = line.slice(4).replace(/^b\//, "").trim();
      else if (line.startsWith("--- ") && !path) path = line.slice(4).replace(/^a\//, "").trim();
    }
    const h = HUNK.exec(line);
    if (h) {
      inHunk = true;
      right = Number(h[1]);
      continue;
    }
    if (!inHunk || !path || path === "/dev/null" || isDocOrSetting(path) || TEST_PATH.test(path)) {
      if (inHunk && (line.startsWith("+") || line.startsWith(" "))) right++;
      continue;
    }
    if (line.startsWith("+")) {
      for (const name of namesIn(line.slice(1), path)) plus.push({ name, path, line: right });
      right++;
    } else if (line.startsWith("-")) {
      for (const name of namesIn(line.slice(1), path)) minus.push({ name, path });
    } else if (line.startsWith(" ")) right++;
  }
  const plusNames = new Set(plus.map((r) => r.name));
  const minusNames = new Set(minus.map((r) => r.name));
  return { added: firstOf(plus.filter((r) => !minusNames.has(r.name))), removed: firstOf(minus.filter((r) => !plusNames.has(r.name))) };
}

const TEST_PATH = /(^|\/)(test|tests|spec|specs|__tests__)\/|[._-](test|spec)\.[a-z]+$|_test\.exs?$/i;

function firstOf(reads: EnvRead[]): EnvRead[] {
  const seen = new Set<string>();
  return reads.filter((r) => (seen.has(r.name) ? false : (seen.add(r.name), true)));
}

/**
 * The words docs would use for a changed file: its name with and without the extension ("rdstation-backfill.mjs",
 * "rdstation-backfill"), skipping names too generic to point anywhere ("index", "utils").
 */
export function fileMentions(path: string): string[] {
  const base = path.split("/").pop() ?? path;
  const stem = base.replace(/\.[^.]+$/, "");
  if (GENERIC_STEMS.has(stem.toLowerCase()) || stem.length < 4) return [];
  return stem === base ? [base] : [base, stem];
}

const GENERIC_STEMS = new Set(["index", "main", "utils", "util", "helpers", "helper", "types", "constants", "config", "app", "mod", "lib", "init", "readme", "changelog", "package", "router", "routes", "schema", "test", "tests", "setup"]);
