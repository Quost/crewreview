import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editConfig, patchToml } from "../src/index.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const file = async (text?: string) => {
  const dir = await mkdtemp(join(tmpdir(), "crewreview-config-"));
  dirs.push(dir);
  const path = join(dir, "config.toml");
  if (text !== undefined) await writeFile(path, text);
  return path;
};

describe("editing config.toml one line at a time", () => {
  const hand = `# my settings
[schedule]
interval = "5m" # quieter
peakHours = "9-18"

[review]
settle = "2m"
`;

  test("changes the key's line and keeps comments and order", () => {
    expect(patchToml(hand, "schedule.interval", '"3m"')).toBe(hand.replace('interval = "5m" # quieter', 'interval = "3m" # quieter'));
  });

  test("adds a key to its table, a missing table at the end, and removes a key", () => {
    const added = patchToml(hand, "schedule.keepAwake", "false");
    expect(added).toContain('peakHours = "9-18"\nkeepAwake = false\n\n[review]');
    expect(patchToml(hand, "review.policy.allowApprove", "false")).toEndWith('settle = "2m"\n\n[review.policy]\nallowApprove = false\n');
    expect(patchToml(hand, "schedule.peakHours", undefined)).not.toContain("peakHours");
    expect(patchToml("", "limits.dailyRuns", "300")).toBe("[limits]\ndailyRuns = 300\n");
  });

  test("writes a valid file and returns the config it makes", async () => {
    const path = await file(hand);
    const r = await editConfig(path, { "schedule.interval": "10m", "limits.dailyRuns": 200, "schedule.keepAwake": false, "review.policy.allowApprove": true });
    expect("config" in r && { interval: r.config.schedule.interval, daily: r.config.limits.dailyRuns, awake: r.config.schedule.keepAwake, approve: r.config.review.policy.allowApprove }).toEqual({ interval: 600_000, daily: 200, awake: false, approve: true });
    const text = await readFile(path, "utf8");
    expect(text).toContain('interval = "10m" # quieter');
    expect(text).toContain("# my settings");
    // An optional limit goes back to none.
    const back = await editConfig(path, { "limits.dailyRuns": null });
    expect("config" in back && back.config.limits.dailyRuns).toBeUndefined();
  });

  test("a new file, and what it refuses: unknown keys, bad values, keys written some other way", async () => {
    const fresh = await file();
    expect(await editConfig(fresh, { "attend.quiet": "1m" })).toMatchObject({ config: { attend: { quiet: 60_000 } } });
    expect(await readFile(fresh, "utf8")).toStartWith("# Crewreview settings.");

    const path = await file('[review]\npolicy = { allowApprove = false }\n');
    const before = await readFile(path, "utf8");
    expect(await editConfig(path, { "harness.custom": [] })).toMatchObject({ key: "harness.custom" });
    expect(await editConfig(path, { "schedule.interval": "soon" })).toMatchObject({ key: "schedule.interval" });
    expect(await editConfig(path, { "limits.maxDiffLines": 0 })).toMatchObject({ key: "limits.maxDiffLines" });
    expect(await editConfig(path, { "review.policy.allowApprove": true })).toHaveProperty("error");
    expect(await readFile(path, "utf8")).toBe(before);
  });
});
