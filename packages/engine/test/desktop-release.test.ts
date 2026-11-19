import { describe, expect, test } from "bun:test";
import { DESKTOP_UPDATE_PACKAGES, desktopManifest, generateKeys, parsePublicKey, parseSecretKey, signFile, trustedComment, verifySignature } from "../src/index.ts";

describe("desktop release", () => {
  test("signed comments carry file and version in the updater's format, and still verify", () => {
    const keys = generateKeys();
    const data = new TextEncoder().encode("package");
    const minisig = signFile(data, parseSecretKey(keys.secret), trustedComment("Crewreview-linux-x64.AppImage", "0.3.0", 1795200000));
    const { trustedComment: comment } = verifySignature(data, minisig, parsePublicKey(keys.publicKeyText));
    expect(comment).toBe("timestamp:1795200000\tfile:Crewreview-linux-x64.AppImage\tversion:0.3.0");
  });

  test("latest.json lists every platform with its versioned URL and base64 signature", () => {
    const sigs = Object.fromEntries(Object.values(DESKTOP_UPDATE_PACKAGES).map((f) => [f, `sig of ${f}`]));
    const m = desktopManifest("0.3.0", sigs, "notes", new Date("2026-11-20T10:00:00Z"));
    expect(Object.keys(m.platforms).sort()).toEqual(["darwin-aarch64", "darwin-x86_64", "linux-aarch64", "linux-x86_64", "windows-x86_64"]);
    expect(m.platforms["darwin-aarch64"]).toEqual({
      url: "https://github.com/Quost/crewreview/releases/download/v0.3.0/Crewreview-macos-arm64.app.tar.gz",
      signature: Buffer.from("sig of Crewreview-macos-arm64.app.tar.gz").toString("base64"),
    });
    expect(m.pub_date).toBe("2026-11-20T10:00:00.000Z");
  });

  test("a missing platform stops the release instead of stranding its users", () => {
    expect(() => desktopManifest("0.3.0", {}, "", new Date())).toThrow(/no signature for Crewreview-macos-arm64/);
  });
});
