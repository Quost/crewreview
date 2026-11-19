import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDirs,
  assetName,
  compareVersions,
  fetchVerified,
  generateKeys,
  latestRelease,
  launchdLabel,
  launchdPlist,
  parsePublicKey,
  parseSecretKey,
  replaceBinary,
  serviceSpec,
  signFile,
  systemdUnit,
  UpdateError,
  verifySignature,
  windowsTaskCommand,
} from "../src/index.ts";

describe("minisign", () => {
  const { secret, publicKeyText } = generateKeys();
  const sk = parseSecretKey(secret);
  const pk = parsePublicKey(publicKeyText);
  const file = new TextEncoder().encode("abc123  crewreview-darwin-arm64\n");

  test("a signature made with the secret key verifies with the public key", () => {
    const sig = signFile(file, sk, "crewreview v1.0.0");
    expect(verifySignature(file, sig, pk).trustedComment).toBe("crewreview v1.0.0");
  });

  test("any change to the file, the signature, the comment or the key fails", () => {
    const sig = signFile(file, sk, "crewreview v1.0.0");
    expect(() => verifySignature(new TextEncoder().encode("evil"), sig, pk)).toThrow("doesn't match");
    expect(() => verifySignature(file, sig.replace("crewreview v1.0.0", "crewreview v9.9.9"), pk)).toThrow("altered");
    const other = parsePublicKey(generateKeys().publicKeyText);
    expect(() => verifySignature(file, sig, other)).toThrow("different key");
    expect(() => verifySignature(file, "garbage", pk)).toThrow();
  });
});

describe("versions and assets", () => {
  test("semver order with pre-releases", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("v0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.0-beta.2", "0.1.0")).toBeLessThan(0);
    expect(compareVersions("0.1.0-beta.10", "0.1.0-beta.2")).toBeGreaterThan(0);
  });
  test("asset per platform", () => {
    expect(assetName("darwin", "arm64")).toBe("crewreview-darwin-arm64");
    expect(assetName("win32", "x64")).toBe("crewreview-windows-x64.exe");
    expect(assetName("win32", "arm64")).toBeUndefined();
  });
});

describe("update from a release", () => {
  let server: ReturnType<typeof Bun.serve>;
  let dir: string;
  const keys = generateKeys();
  const binary = new TextEncoder().encode("#!/bin/sh\necho new crewreview\n");
  const name = "crewreview-linux-x64";
  let sums = `${createHash("sha256").update(binary).digest("hex")}  ${name}\n`;
  let tamper = false;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crewreview-update-"));
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        const base = `http://127.0.0.1:${server.port}`;
        if (u.pathname === "/repos/o/r/releases") {
          return Response.json([
            { tag_name: "v0.3.0-beta.1", prerelease: true, draft: false, assets: [] },
            { tag_name: "v0.2.0", prerelease: false, draft: false, body: "notes", assets: ["SHA256SUMS", "SHA256SUMS.minisig", name].map((n) => ({ name: n, url: `${base}/assets/${n}` })) },
            { tag_name: "v0.1.0", prerelease: false, draft: false, assets: [] },
          ]);
        }
        // Like GitHub: assets redirect to storage, which must not get the token.
        if (u.pathname.startsWith("/assets/")) return Response.redirect(`${base}/storage/${u.pathname.slice(8)}`, 302);
        if (u.pathname.startsWith("/storage/")) {
          if (req.headers.get("authorization")) return new Response("token leaked to storage", { status: 400 });
          const n = u.pathname.slice(9);
          if (n === "SHA256SUMS") return new Response(sums);
          if (n === "SHA256SUMS.minisig") return new Response(signFile(new TextEncoder().encode(sums), parseSecretKey(keys.secret), "crewreview v0.2.0"));
          if (n === name) return new Response(tamper ? new TextEncoder().encode("tampered") : binary);
        }
        return new Response("not found", { status: 404 });
      },
    });
  });
  afterAll(async () => {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  const src = () => ({ apiBase: `http://127.0.0.1:${server.port}`, repo: "o/r", token: "secret-token" });

  test("picks the newest stable release, or the beta on the beta channel", async () => {
    expect((await latestRelease(src()))?.version).toBe("0.2.0");
    expect((await latestRelease({ ...src(), channel: "beta" }))?.version).toBe("0.3.0-beta.1");
  });

  test("downloads, verifies and swaps the binary", async () => {
    const release = (await latestRelease(src()))!;
    const bytes = await fetchVerified(release, src(), keys.publicKeyText, name);
    const target = join(dir, "crewreview");
    await writeFile(target, "old");
    await replaceBinary(target, bytes);
    expect(await readFile(target, "utf8")).toContain("new crewreview");
    if (process.platform !== "win32") expect((await stat(target)).mode & 0o111).toBeTruthy();
  });

  test("refuses a tampered binary, a wrong key, and builds without a key", async () => {
    const release = (await latestRelease(src()))!;
    tamper = true;
    await expect(fetchVerified(release, src(), keys.publicKeyText, name)).rejects.toMatchObject({ code: "bad-checksum" });
    tamper = false;
    await expect(fetchVerified(release, src(), generateKeys().publicKeyText, name)).rejects.toMatchObject({ code: "bad-signature" });
    await expect(fetchVerified(release, src(), "", name)).rejects.toBeInstanceOf(UpdateError);
    // A properly signed SHA256SUMS that lists a different hash: the binary still has to match it.
    const original = sums;
    sums = sums.replace(/^[0-9a-f]+/, "0".repeat(64));
    await expect(fetchVerified(release, src(), keys.publicKeyText, name)).rejects.toMatchObject({ code: "bad-checksum" });
    sums = original;
  });
});

describe("service files", () => {
  const dirs = appDirs({ CREWREVIEW_HOME: "/tmp/crew home" });
  const spec = serviceSpec(dirs, { PATH: "/usr/bin:/opt/homebrew/bin", CREWREVIEW_HOME: "/tmp/crew home", GH_TOKEN: "nope" }, "/usr/local/bin/crewreview");

  test("a custom home gets its own service name; tokens never go into the file", () => {
    expect(spec.name).toMatch(/^crewreview-[0-9a-f]{8}$/);
    expect(spec.program).toEqual(["/usr/local/bin/crewreview", "run"]);
    expect(spec.env).toEqual({ PATH: "/usr/bin:/opt/homebrew/bin", CREWREVIEW_HOME: "/tmp/crew home" });
    expect(serviceSpec(appDirs({ HOME: "/h" }, "linux"), { PATH: "/bin" }, "/usr/local/bin/crewreview").name).toBe("crewreview");
  });

  test("launchd, systemd and Windows task", () => {
    const plist = launchdPlist(spec);
    expect(launchdLabel(spec)).toStartWith("dev.crewreview.daemon-");
    expect(plist).toContain("<string>/usr/local/bin/crewreview</string>");
    expect(plist).toContain("<key>CREWREVIEW_HOME</key><string>/tmp/crew home</string>");
    expect(plist).not.toContain("GH_TOKEN");
    const unit = systemdUnit(spec);
    expect(unit).toContain("ExecStart=/usr/local/bin/crewreview run");
    expect(unit).toContain('Environment="CREWREVIEW_HOME=/tmp/crew home"');
    expect(windowsTaskCommand({ ...spec, program: ["C:\\Program Files\\Crewreview\\crewreview.exe", "run"] })).toBe('"C:\\Program Files\\Crewreview\\crewreview.exe" run');
    const dev = serviceSpec(dirs, {}, "/Users/x/.bun/bin/bun", "/repo/apps/cli/src/main.ts");
    expect(dev.program).toEqual(["/Users/x/.bun/bin/bun", "/repo/apps/cli/src/main.ts", "run"]);
  });
});
