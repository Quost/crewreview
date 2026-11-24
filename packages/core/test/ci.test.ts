import { describe, expect, test } from "bun:test";
import { ciLogExcerpt, failureSignal, pickFailingJobs } from "../src/index.ts";

const ts = (n: number) => `2026-11-24T12:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.1234567Z `;
const log = (lines: string[]) => lines.map((l, i) => ts(i) + l).join("\n");

// A job that keeps going after the step that broke: the error is far from the end.
const credoJob = log([
  "##[group]Run mix deps.get",
  ...Array.from({ length: 200 }, (_, i) => `* Getting dep_${i}`),
  "##[endgroup]",
  "##[group]Run mix credo --strict",
  "Checking 412 source files (this might take a while) ...",
  "  Refactoring opportunities",
  "┃ ",
  "┃ [F] ↗ Function body is nested too deep (max depth is 2, was 3).",
  "┃       lib/iems/firmware_schedule_worker.ex:457:9 #(Iems.FirmwareScheduleWorker.handle_send)",
  "Please report incorrect results: https://github.com/rrrene/credo/issues",
  "##[error]Process completed with exit code 8.",
  "##[group]Run actions/upload-artifact@v4",
  ...Array.from({ length: 150 }, (_, i) => `Uploading chunk ${i}`),
  "##[endgroup]",
  "Post job cleanup.",
  "[command]/usr/bin/git config --local --unset-all http.https://github.com/.extraheader",
  "Sending Teams notification",
  "Cleaning up orphan processes",
]);

describe("what of a failed job's log the agent sees", () => {
  test("the lines around the failure, not the uploads and cleanup after it", () => {
    const out = ciLogExcerpt(credoJob);
    expect(out).toContain("[F] ↗ Function body is nested too deep");
    expect(out).toContain("firmware_schedule_worker.ex:457");
    expect(out).toContain("Process completed with exit code 8.");
    expect(out).not.toContain("Sending Teams notification");
    expect(out).not.toContain("Uploading chunk");
    // Nor the step before it.
    expect(out).not.toContain("Getting dep_");
    expect(out).toContain("##[group]Run mix credo --strict");
    // Timestamps take room and say nothing.
    expect(out).not.toMatch(/2026-11-24T/);
    expect(out.startsWith("[…]\n")).toBe(true);
    expect(out.endsWith("\n[…]")).toBe(true);
  });

  test("a generic exit line keeps the step output above it", () => {
    const out = ciLogExcerpt(log(["Run ./check.sh", "widget count is 3, wanted 2", "##[error]Process completed with exit code 1.", "Post job cleanup."]));
    expect(out).toBe("Run ./check.sh\nwidget count is 3, wanted 2\n##[error]Process completed with exit code 1.\n[…]");
  });

  test("failures far apart come as separate parts, in order", () => {
    const lines = [...Array.from({ length: 100 }, (_, i) => `ok ${i}`), "  1) test sums (MathTest)", ...Array.from({ length: 100 }, (_, i) => `ok ${100 + i}`), "** (RuntimeError) boom"];
    const out = ciLogExcerpt(lines.join("\n"), { before: 2, after: 1 });
    expect(out).toBe("[…]\nok 98\nok 99\n  1) test sums (MathTest)\nok 100\n[…]\nok 198\nok 199\n** (RuntimeError) boom");
  });

  test("stays within its size, keeping the first failures", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `error: problem number ${i}`);
    const out = ciLogExcerpt(lines.join("\n"), { maxChars: 1000 });
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out).toContain("error: problem number 0");
    expect(out).not.toContain("error: problem number 1999");
  });

  test("without a failure line, the end of the log as before", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    const out = ciLogExcerpt(`${lines.join("\r\n")}\n\n`, { tail: 3 });
    expect(out).toBe("line 297\nline 298\nline 299");
  });

  test("colour codes don't hide a failure line", () => {
    expect(failureSignal("\x1b[31merror:\x1b[0m cannot find value `x`")).toBe("specific");
    expect(failureSignal(log(["##[error]Process completed with exit code 1."]))).toBe("exit-only");
    expect(failureSignal("all good")).toBe("none");
  });
});

describe("which failing jobs the agent sees", () => {
  const summary = { name: "Quality summary", log: log(["needs.credo.result = failure", "##[error]Process completed with exit code 1."]) };
  const credo = { name: "credo", log: credoJob };
  const tests = { name: "test", log: log(["  1) test it works (FooTest)", "##[error]Process completed with exit code 2."]) };
  const opaque = { name: "deploy preview" };

  test("jobs whose log names a failure first, a summary of the others last", () => {
    expect(pickFailingJobs([summary, opaque, credo, tests]).map((j) => j.name)).toEqual(["credo", "test", "deploy preview"]);
  });

  test("a summary is still shown when it's all there is", () => {
    expect(pickFailingJobs([summary]).map((j) => j.name)).toEqual(["Quality summary"]);
  });

  test("ties keep the host's order", () => {
    expect(pickFailingJobs([tests, credo], 1).map((j) => j.name)).toEqual(["test"]);
  });
});
