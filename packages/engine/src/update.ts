import { createHash } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parsePublicKey, verifySignature, type PublicKey } from "./minisign.ts";

/**
 * The release key. Its secret half signs SHA256SUMS in the release workflow; this half is built into every binary,
 * so an update is installed only when it comes from the same signer. Also verifiable with the minisign tool:
 * `minisign -Vm SHA256SUMS -P RWTk8l0TkAFZQOxVkYWEHrU6Nj+j1UTCGOMps627c4qsvaX3fvRFzhpx`
 */
export const RELEASE_PUBLIC_KEY = `untrusted comment: Crewreview release key E4F25D1390015940
RWTk8l0TkAFZQOxVkYWEHrU6Nj+j1UTCGOMps627c4qsvaX3fvRFzhpx`;

export const RELEASE_REPO = "Quost/crewreview";

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface Release {
  tag: string;
  version: string;
  prerelease: boolean;
  assets: ReleaseAsset[];
  notes: string;
}

/** Compare "1.2.3", "1.2.3-beta.1": negative when a < b. Pre-releases sort before their release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2) as [string, string | undefined];
    return { nums: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

/** The asset this machine runs. */
export function assetName(platform = process.platform, arch = process.arch): string | undefined {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : undefined;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
  if (!os || !cpu || (os === "windows" && cpu !== "x64")) return undefined;
  return `crewreview-${os}-${cpu}${os === "windows" ? ".exe" : ""}`;
}

export interface UpdateSource {
  /** GitHub API base (tests point it at a local server). */
  apiBase?: string;
  repo?: string;
  token?: string;
  channel?: "stable" | "beta";
  fetch?: typeof fetch;
}

function headers(s: UpdateSource, accept = "application/vnd.github+json"): Record<string, string> {
  return { accept, "user-agent": "crewreview-updater", ...(s.token ? { authorization: `Bearer ${s.token}` } : {}) };
}

/** The newest release for the channel: stable skips pre-releases. */
export async function latestRelease(s: UpdateSource = {}): Promise<Release | undefined> {
  const f = s.fetch ?? fetch;
  const res = await f(`${s.apiBase ?? "https://api.github.com"}/repos/${s.repo ?? RELEASE_REPO}/releases?per_page=20`, { headers: headers(s) });
  if (!res.ok) throw new Error(`releases: HTTP ${res.status}`);
  const list = (await res.json()) as any[];
  const pick = list.filter((r) => !r.draft && (s.channel === "beta" || !r.prerelease)).sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
  if (!pick) return undefined;
  return {
    tag: pick.tag_name,
    version: String(pick.tag_name).replace(/^v/, ""),
    prerelease: Boolean(pick.prerelease),
    notes: pick.body ?? "",
    assets: (pick.assets ?? []).map((a: any) => ({ name: a.name, url: a.url })),
  };
}

async function download(s: UpdateSource, asset: ReleaseAsset): Promise<Uint8Array> {
  const f = s.fetch ?? fetch;
  // The API asset URL with octet-stream works for private repositories too. It redirects to signed storage,
  // which must get the request without our token.
  let res = await f(asset.url, { headers: headers(s, "application/octet-stream"), redirect: "manual" });
  const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
  if (location) res = await f(new URL(location, asset.url), { headers: { "user-agent": "crewreview-updater" } });
  if (!res.ok) throw new Error(`${asset.name}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export class UpdateError extends Error {
  constructor(
    readonly code: "no-key" | "no-asset" | "no-sums" | "bad-signature" | "bad-checksum" | "not-binary",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Download the release binary for this machine and check it: SHA256SUMS must carry a valid signature from the
 * release key, and the binary must match its line in SHA256SUMS. Returns the verified bytes.
 */
export async function fetchVerified(release: Release, s: UpdateSource = {}, publicKey: string = RELEASE_PUBLIC_KEY, name = assetName()): Promise<Uint8Array> {
  if (!publicKey.trim()) throw new UpdateError("no-key", "this build has no release key, so it can't verify updates");
  if (!name) throw new UpdateError("no-asset", `no release binary for ${process.platform}-${process.arch}`);
  const asset = release.assets.find((a) => a.name === name);
  const sums = release.assets.find((a) => a.name === "SHA256SUMS");
  const sig = release.assets.find((a) => a.name === "SHA256SUMS.minisig");
  if (!asset) throw new UpdateError("no-asset", `release ${release.tag} has no ${name}`);
  if (!sums || !sig) throw new UpdateError("no-sums", `release ${release.tag} isn't signed`);
  let key: PublicKey;
  try {
    key = parsePublicKey(publicKey);
  } catch {
    throw new UpdateError("no-key", "the built-in release key is unreadable");
  }
  const sumsBytes = await download(s, sums);
  try {
    verifySignature(sumsBytes, new TextDecoder().decode(await download(s, sig)), key);
  } catch (e) {
    throw new UpdateError("bad-signature", (e as Error).message);
  }
  const expected = new TextDecoder()
    .decode(sumsBytes)
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find((parts) => parts[1]?.replace(/^\*/, "") === name)?.[0];
  if (!expected) throw new UpdateError("bad-checksum", `${name} isn't listed in SHA256SUMS`);
  const bytes = await download(s, asset);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new UpdateError("bad-checksum", `${name} doesn't match SHA256SUMS`);
  return bytes;
}

/**
 * Put the new binary in place of `target` atomically: write next to it, then rename over it. On Windows a running
 * .exe can't be overwritten but can be renamed, so the old one is moved aside first.
 */
export async function replaceBinary(target: string, bytes: Uint8Array): Promise<void> {
  const dir = dirname(target);
  const fresh = join(dir, `.crewreview-update-${process.pid}`);
  await writeFile(fresh, bytes);
  if (process.platform !== "win32") await chmod(fresh, 0o755);
  if (process.platform === "win32") {
    const old = `${target}.old`;
    await rm(old, { force: true });
    await rename(target, old).catch(() => {});
  }
  await rename(fresh, target);
}

/** Is this process a compiled Crewreview binary (and not `bun main.ts`)? */
export function isCompiledBinary(execPath = process.execPath): boolean {
  return !/(^|[\\/])bun(\.exe)?$/i.test(execPath);
}

/** The desktop app's update package per updater platform, as release assets (stable names, no version). */
export const DESKTOP_UPDATE_PACKAGES: Record<string, string> = {
  "darwin-aarch64": "Crewreview-macos-arm64.app.tar.gz",
  "darwin-x86_64": "Crewreview-macos-x64.app.tar.gz",
  "windows-x86_64": "Crewreview-windows-x64-setup.exe",
  "linux-x86_64": "Crewreview-linux-x64.AppImage",
  "linux-aarch64": "Crewreview-linux-arm64.AppImage",
};

/**
 * latest.json for the desktop app's updater: per platform, where the package is and its signature (the .minisig
 * file, base64, the way the Tauri updater reads it). Every platform must be there, so no user is left behind.
 */
export function desktopManifest(version: string, signatures: Record<string, string>, notes: string, date: Date, repo = RELEASE_REPO) {
  const platforms: Record<string, { signature: string; url: string }> = {};
  const missing: string[] = [];
  for (const [platform, file] of Object.entries(DESKTOP_UPDATE_PACKAGES)) {
    const minisig = signatures[file];
    if (!minisig) {
      missing.push(file);
      continue;
    }
    platforms[platform] = {
      signature: Buffer.from(minisig).toString("base64"),
      url: `https://github.com/${repo}/releases/download/v${version}/${file}`,
    };
  }
  if (missing.length > 0) throw new Error(`no signature for ${missing.join(", ")}`);
  return { version, notes, pub_date: date.toISOString(), platforms };
}

/**
 * Does this binary ship inside the desktop app? Then the app updates it: replacing it in place would break the app's
 * code signature, and the next app update would put the old one back anyway.
 */
export function managedByDesktop(execPath = process.execPath, env: Record<string, string | undefined> = process.env): boolean {
  return env.CREWREVIEW_DESKTOP === "1" || /\.app\/Contents\/MacOS\/[^/]+$/.test(execPath);
}
