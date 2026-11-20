import { describe, expect, test } from "bun:test";
import { parseRepoUrl, type RepoRef } from "@crewreview/hosts";
import { hostAccess, linkFromUrl, newRepoEntry, type LinkedRepo } from "../src/index.ts";

const linked = (url: string): LinkedRepo => {
  const ref = parseRepoUrl(url);
  return { ...newRepoEntry(ref, {}), ref };
};

describe("host access", () => {
  test("checks GitHub, GitLab and each linked host once, and says as whom", async () => {
    const asked: string[] = [];
    const out = await hostAccess([linked("https://github.com/acme/shop"), linked("https://gitlab.com/team/api")], {
      version: "test",
      signedIn: async () => [{ kind: "gitlab", host: "gitlab.acme.dev" }, { kind: "github", host: "github.com" }],
      resolve: async (ref: RepoRef) => (asked.push(ref.host), ref.host === "gitlab.com" ? undefined : { token: "t", source: ref.kind === "github" ? "gh" : "env" }),
      whoami: async (ref) => {
        if (ref.host === "gitlab.acme.dev") throw new Error("401 Unauthorized\nmore");
        return "ana";
      },
    });
    // gitlab.com shows up because a repository there is linked, after the hosts the CLIs know.
    expect(asked).toEqual(["github.com", "gitlab.acme.dev", "gitlab.com"]);
    expect(out).toEqual([
      { kind: "github", host: "github.com", source: "gh", user: "ana" },
      { kind: "gitlab", host: "gitlab.acme.dev", source: "env", error: "401 Unauthorized" },
      { kind: "gitlab", host: "gitlab.com" },
    ]);
  });

  test("a host that doesn't answer is reported, not waited on", async () => {
    const [gh] = await hostAccess([], { version: "test", timeoutMs: 20, signedIn: async () => [], resolve: async () => ({ token: "t", source: "env" }), whoami: () => new Promise(() => {}) });
    expect(gh).toEqual({ kind: "github", host: "github.com", source: "env", error: "github.com didn't answer" });
  });
});

describe("which hosts the setup shows", () => {
  const none = async () => undefined;
  test("the hosts gh and glab are signed in to; gitlab.com only when no other GitLab is known", async () => {
    const hosts = (signedIn: { kind: "github" | "gitlab"; host: string }[]) => hostAccess([], { version: "test", signedIn: async () => signedIn, resolve: none }).then((r) => r.map((h) => h.host));
    expect(await hosts([])).toEqual(["github.com", "gitlab.com"]);
    expect(await hosts([{ kind: "gitlab", host: "gitlab.acme.dev" }])).toEqual(["github.com", "gitlab.acme.dev"]);
    expect(await hosts([{ kind: "github", host: "github.acme.dev" }, { kind: "gitlab", host: "gitlab.com" }])).toEqual(["github.com", "gitlab.com", "github.acme.dev"]);
  });
});

describe("a link from an address", () => {
  test("a repository, an organization, the linked one, or an error", () => {
    const shop = linked("https://github.com/acme/shop");
    expect(linkFromUrl("https://github.com/acme/api", [shop])).toMatchObject({ id: "acme-api", ref: { slug: "acme/api" } });
    expect(linkFromUrl("https://github.com/acme", [shop])).toMatchObject({ id: "acme", scope: "org" });
    expect(linkFromUrl("https://GitHub.com/Acme/Shop", [shop])).toBe(shop);
    expect(linkFromUrl("not a url", [])).toMatchObject({ error: "url" });
  });
});
