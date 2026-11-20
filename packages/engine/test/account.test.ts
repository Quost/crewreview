import { describe, expect, test } from "bun:test";
import { repoRef, resolveAccountToken } from "@crewreview/hosts";
import { checkAccount } from "../src/index.ts";

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
