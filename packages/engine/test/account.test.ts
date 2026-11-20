import { describe, expect, test } from "bun:test";
import { repoRef, resolveAccountToken } from "@crewreview/hosts";
import { checkAccount, newRepoEntry, saveAccountToken, type LinkedRepo } from "../src/index.ts";

const gh = repoRef("github", "github.com", "acme/shop");
const gl = repoRef("gitlab", "gitlab.com", "acme/shop");

describe("the token of a review account", () => {
  test("from an environment variable, or from gh for that login; never an option on gh's command line", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]) => (calls.push(argv), argv.includes("acme-bot") ? "gho_bot\n" : undefined);
    expect(await resolveAccountToken(gh, "env:BOT_TOKEN", { BOT_TOKEN: " t1 " }, run)).toEqual({ token: "t1", source: "env" });
    expect(await resolveAccountToken(gh, "env:BOT_TOKEN", {}, run)).toEqual({ error: "env-unset", name: "BOT_TOKEN" });
    expect(await resolveAccountToken(gh, "acme-bot", {}, run)).toEqual({ token: "gho_bot", source: "gh" });
    expect(calls).toEqual([["gh", "auth", "token", "--hostname", "github.com", "--user", "acme-bot"]]);
    expect(await resolveAccountToken(gh, "someone-else", {}, run)).toEqual({ error: "not-signed-in", name: "someone-else" });
    expect(await resolveAccountToken(gh, "--hostname=evil", {}, run)).toEqual({ error: "bad-name", name: "--hostname=evil" });
    expect(await resolveAccountToken(gl, "acme-bot", {}, run)).toEqual({ error: "gitlab-needs-env", name: "acme-bot" });
    expect(calls).toHaveLength(2);
  });

  test("from the system keychain, under the name the dashboard saved it as", async () => {
    const kept: Record<string, string> = { "gitlab.com/group_7_bot": " glpat-x \n" };
    const secrets = async (n: string) => kept[n];
    const none = async () => undefined;
    expect(await resolveAccountToken(gl, "keychain:gitlab.com/group_7_bot", {}, none, secrets)).toEqual({ token: "glpat-x", source: "keychain" });
    expect(await resolveAccountToken(gl, "keychain:gitlab.com/gone", {}, none, secrets)).toEqual({ error: "keychain-missing", name: "gitlab.com/gone" });
    expect(await resolveAccountToken(gl, "keychain:../$(x)", {}, none, secrets)).toEqual({ error: "bad-name", name: "keychain:../$(x)" });
  });
});

describe("a pasted token for a second account", () => {
  const link = (ref: ReturnType<typeof repoRef>, scope?: "org"): LinkedRepo => ({ ...newRepoEntry(ref, scope ? { scope } : {}), ref });
  const group = link(repoRef("gitlab", "gitlab.acme.dev", "team/apps"), "org");
  const project = link(repoRef("gitlab", "gitlab.acme.dev", "team/apps/api"));
  const who: Record<string, string> = { "glpat-bot": "group_9_bot_1", "you-token": "you" };
  const base = {
    version: "test",
    whoami: async (_r: unknown, tk: string) => {
      if (!(tk in who)) throw new Error("401 Unauthorized\nmore");
      return who[tk]!;
    },
    resolveOwn: async () => ({ token: "you-token" }),
  };

  test("says who it is, asks each place what it can do, and keeps it in the keychain", async () => {
    const stored: [string, string][] = [];
    const r = await saveAccountToken([group, project], " glpat-bot\n", {
      ...base,
      reach: async (l) => (l.id === group.id ? "write" : "none"),
      store: async (n, v) => void stored.push([n, v]),
    });
    expect(r).toEqual({ user: "group_9_bot_1", account: "keychain:gitlab.acme.dev/group_9_bot_1", reach: [{ id: group.id, permission: "write" }, { id: project.id, permission: "none" }], accepted: [] });
    expect(stored).toEqual([["gitlab.acme.dev/group_9_bot_1", "glpat-bot"]]);
  });

  test("refuses your own token and a token the host refuses, and keeps neither", async () => {
    const stored: string[] = [];
    const d = { ...base, reach: async () => "write" as const, store: async (n: string) => void stored.push(n) };
    expect(await saveAccountToken([project], "you-token", d)).toEqual({ error: "same-account", name: "you" });
    expect(await saveAccountToken([project], "glpat-revoked", d)).toMatchObject({ error: "host", message: "401 Unauthorized" });
    expect(await saveAccountToken([project], "  ", d)).toEqual({ error: "none" });
    expect(stored).toEqual([]);
  });

  test("on GitHub it accepts the invitations first; a keychain that refuses is reported", async () => {
    const shop = link(gh);
    const d = { ...base, whoami: async (_r: unknown, tk: string) => (tk === "you-token" ? "you" : "acme-bot"), reach: async () => "write" as const };
    const accepted: string[][] = [];
    const ok = await saveAccountToken([shop], "ghp_bot", { ...d, accept: async (_r, _t, s) => (accepted.push(s), s), store: async () => {} });
    expect(ok).toMatchObject({ user: "acme-bot", account: "keychain:github.com/acme-bot", accepted: ["acme/shop"] });
    expect(accepted).toEqual([["acme/shop"]]);
    const locked = await saveAccountToken([shop], "ghp_bot", { ...d, accept: async () => [], store: async () => Promise.reject(new Error("keychain locked")) });
    expect(locked).toEqual({ error: "keychain", message: "keychain locked" });
  });
});

describe("checking a review account before it's saved", () => {
  const deps = (who: Record<string, string>, own = "you-token") => ({
    resolveAccount: async (_r: unknown, a: string) => (a === "missing" ? { error: "not-signed-in" as const, name: a } : { token: `${a}-token`, source: "gh" as const }),
    resolveOwn: async () => ({ token: own }),
    whoami: async (_r: unknown, token: string) => {
      if (!(token in who)) throw new Error("401 Bad credentials\nmore");
      return who[token]!;
    },
  });

  test("it says who the account is, refuses your own, and passes on what went wrong", async () => {
    const who = { "acme-bot-token": "acme-bot", "you-token": "you", "you-again-token": "You" };
    expect(await checkAccount(gh, "acme-bot", "test", deps(who))).toEqual({ user: "acme-bot" });
    expect(await checkAccount(gh, "you-again", "test", deps(who))).toEqual({ error: "same-account", name: "You" });
    expect(await checkAccount(gh, "missing", "test", deps(who))).toEqual({ error: "not-signed-in", name: "missing" });
    expect(await checkAccount(gh, "revoked", "test", deps(who))).toMatchObject({ error: "host", name: "revoked", message: "401 Bad credentials" });
  });
});
