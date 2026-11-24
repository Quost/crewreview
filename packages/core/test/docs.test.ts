import { describe, expect, test } from "bun:test";
import { countChecks, envChanges, fileMentions, isDocOrSetting, parseLensOutput, settleChecks, type Check, type FileOracle } from "../src/index.ts";

const diff = (path: string, body: string) => `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n${body}`;

describe("environment variables a change reads", () => {
  test("new reads in code, with their line, across languages", () => {
    const d = [
      diff("config/runtime.exs", '@@ -10,2 +10,4 @@\n config :iems,\n+  psk: System.get_env("IEMS_BOOTSTRAP_PSK"),\n+  scs: System.fetch_env!("IEMS_BOOTSTRAP_PSK_SCS")\n'),
      diff("src/rd.ts", '@@ -1 +1,2 @@\n+const token = process.env.RD_TOKEN ?? process.env["RD_URL"];\n'),
      diff("app/settings.py", '@@ -3 +3,2 @@\n+KEY = os.environ.get("API_KEY")\n'),
    ].join("\n");
    expect(envChanges(d).added).toEqual([
      { name: "IEMS_BOOTSTRAP_PSK", path: "config/runtime.exs", line: 11 },
      { name: "IEMS_BOOTSTRAP_PSK_SCS", path: "config/runtime.exs", line: 12 },
      { name: "RD_TOKEN", path: "src/rd.ts", line: 1 },
      { name: "RD_URL", path: "src/rd.ts", line: 1 },
      { name: "API_KEY", path: "app/settings.py", line: 3 },
    ]);
  });

  test("a rename is one read gone and one new; a moved read is neither", () => {
    const d = diff("lib/a.ex", '@@ -1,3 +1,3 @@\n-x = System.get_env("OLD_NAME")\n+x = System.get_env("NEW_NAME")\n-y = System.get_env("SAME")\n+  y = System.get_env("SAME")\n');
    const r = envChanges(d);
    expect(r.added.map((e) => e.name)).toEqual(["NEW_NAME"]);
    expect(r.removed.map((e) => e.name)).toEqual(["OLD_NAME"]);
  });

  test("docs, examples, tests, ambient names and interpolation in code don't count", () => {
    const d = [
      diff(".env.example", "@@ -1 +1,2 @@\n+${DOCUMENTED}\n"),
      diff("docs/DEPLOY.md", '@@ -1 +1,2 @@\n+Set System.get_env("IN_DOCS")\n'),
      diff("test/a_test.exs", '@@ -1 +1,2 @@\n+System.put_env("T", System.get_env("IN_TEST"))\n'),
      diff("src/b.ts", "@@ -1 +1,3 @@\n+const env = process.env.NODE_ENV;\n+const s = `${MAX_RETRIES} tries`;\n"),
    ].join("\n");
    expect(envChanges(d)).toEqual({ added: [], removed: [] });
  });

  test("${NAME} reads a variable in config and scripts", () => {
    const d = diff("deploy/compose.yaml", "@@ -1 +1,2 @@\n+    DATABASE_URL: ${DATABASE_URL:-postgres://localhost}\n");
    expect(envChanges(d).added.map((e) => e.name)).toEqual(["DATABASE_URL"]);
  });
});

describe("docs and settings", () => {
  test("which files people read or operate by", () => {
    for (const p of ["README.md", "docs/integracao.md", ".env.example", ".env.production.sample", "docs/DEPLOY.md", "priv/gettext/pt_BR/LC_MESSAGES/default.po", "locales/en.json", "docs/adr/0110-key.md"]) {
      expect(isDocOrSetting(p)).toBe(true);
    }
    for (const p of ["src/app.ts", "config/runtime.exs", ".env", "src/locale.ts"]) expect(isDocOrSetting(p)).toBe(false);
  });

  test("a changed file's name as docs would mention it, unless it's too generic", () => {
    expect(fileMentions("scripts/rdstation-backfill.mjs")).toEqual(["rdstation-backfill.mjs", "rdstation-backfill"]);
    expect(fileMentions("src/utils.ts")).toEqual([]);
    expect(fileMentions("Makefile")).toEqual(["Makefile"]);
  });
});

describe("claims and rules a review checked", () => {
  const oracle: FileOracle = { lineCount: (p) => (p === "lib/auth.ex" ? 200 : null) };
  const check = (c: Partial<Check>): Check => ({ kind: "claim", text: "blocked on the server", status: "holds", ...c });

  test("read from the lens answer, with loose statuses mapped and junk skipped", () => {
    const out = parseLensOutput({
      findings: [],
      checks: [
        { kind: "claim", text: "AuthorizationKey is blocked on the server", source: "pr", status: "false", evidence: "lib/auth.ex:112" },
        { kind: "rule", text: "New env goes to DEPLOY.md", status: "followed", evidence: "docs/DEPLOY.md:3" },
        { text: "" },
        { kind: "odd", text: "only X calls Y", status: "maybe" },
      ],
    });
    expect(out?.checks).toEqual([
      { kind: "claim", text: "AuthorizationKey is blocked on the server", source: "pr", status: "fails", evidence: "lib/auth.ex:112" },
      { kind: "rule", text: "New env goes to DEPLOY.md", source: undefined, status: "holds", evidence: "docs/DEPLOY.md:3" },
      { kind: "claim", text: "only X calls Y", source: undefined, status: "unverified", evidence: undefined },
    ]);
  });

  test("holds or fails only with a real place; otherwise unverified, decided here", () => {
    const out = settleChecks(
      [
        check({ evidence: "lib/auth.ex:112", status: "fails" }),
        check({ text: "Only the worker writes ids", evidence: "lib/auth.ex:999" }),
        check({ text: "idempotent by deal_id", evidence: "somewhere" }),
        check({ text: "Blocked  on the SERVER", evidence: "lib/auth.ex:1" }),
        check({ text: "unknown", status: "unverified" }),
      ],
      oracle,
    );
    expect(out.map((c) => [c.text, c.status, c.unproven ?? false])).toEqual([
      ["blocked on the server", "fails", false],
      ["Only the worker writes ids", "unverified", true],
      ["idempotent by deal_id", "unverified", true],
      ["unknown", "unverified", false],
    ]);
    expect(countChecks(out)).toEqual({ holds: 0, fails: 1, unverified: 3 });
  });

  test("the place is read out of the words a model wraps it in", () => {
    const out = settleChecks(
      [
        check({ evidence: "head/lib/auth.ex:36-42 and confirmation_summary in the diff" }),
        check({ text: "b", evidence: "`./lib/auth.ex:7`" }),
        check({ text: "c", evidence: "lib/auth.ex (protect_recent_writes, in the diff)" }),
      ],
      oracle,
    );
    expect(out.map((c) => [c.status, c.evidence])).toEqual([
      ["holds", "lib/auth.ex:36-42"],
      ["holds", "lib/auth.ex:7"],
      ["unverified", "lib/auth.ex (protect_recent_writes, in the diff)"],
    ]);
  });
});
