import { describe, expect, test } from "bun:test";
import { awakeCommand, keepAwake, parseConfig } from "../src/index.ts";

const found = (name: string) => `/bin/${name}`;

describe("keeping the computer awake", () => {
  test("each system's own tool, tied to the daemon's process", () => {
    expect(awakeCommand("darwin", 42, found)).toEqual(["/bin/caffeinate", "-i", "-s", "-w", "42"]);
    expect(awakeCommand("linux", 42, found)).toEqual(["/bin/systemd-inhibit", "--what=idle:sleep", "--who=Crewreview", "--why=Reviewing pull requests", "--mode=block", "/bin/tail", "--pid=42", "-f", "/dev/null"]);
    const win = awakeCommand("win32", 42, found)!;
    expect(win[0]).toBe("/bin/powershell");
    expect(win.at(-1)).toContain("SetThreadExecutionState(0x80000001)");
    expect(win.at(-1)).toEndWith("Wait-Process -Id 42");
    expect(awakeCommand("linux", 42, () => undefined)).toBeUndefined();
  });

  test("one request at a time, released on off, and nothing when switched off", () => {
    const spawned: string[][] = [];
    let killed = 0;
    const spawn = (argv: string[]) => (spawned.push(argv), { kill: () => void killed++ });
    const a = keepAwake({ enabled: true, platform: "darwin", pid: 7, find: found, spawn });
    a.on();
    a.on();
    expect(spawned).toHaveLength(1);
    expect(a.active).toBe(true);
    a.off();
    a.off();
    expect([killed, a.active]).toEqual([1, false]);
    const off = keepAwake({ enabled: false, platform: "darwin", pid: 7, find: found, spawn });
    off.on();
    expect(spawned).toHaveLength(1);
    expect(parseConfig({}).schedule.keepAwake).toBe(true);
  });
});
