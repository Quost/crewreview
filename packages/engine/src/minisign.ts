import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

/**
 * Minisign-compatible signatures (https://jedisct1.github.io/minisign/), so anyone can check a release with the
 * `minisign` tool too. Pre-hashed ("ED") signatures: Ed25519 over BLAKE2b-512 of the file.
 */

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function blake2b512(data: Uint8Array): Buffer {
  return Buffer.from(new Bun.CryptoHasher("blake2b512").update(data).digest());
}

export interface PublicKey {
  keyId: Buffer;
  key: KeyObject;
}

/** Parse "untrusted comment: …\nRWS…" or just the base64 line. */
export function parsePublicKey(text: string): PublicKey {
  const line = text.trim().split("\n").find((l) => !l.startsWith("untrusted comment:"))?.trim() ?? "";
  const raw = Buffer.from(line, "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== "Ed") throw new Error("not a minisign public key");
  return { keyId: raw.subarray(2, 10), key: createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw.subarray(10)]), format: "der", type: "spki" }) };
}

export class SignatureError extends Error {}

/** Check a .minisig against the file and the public key. Throws SignatureError when anything doesn't match. */
export function verifySignature(file: Uint8Array, minisig: string, publicKey: PublicKey): { trustedComment: string } {
  const lines = minisig.trim().split("\n").map((l) => l.trim());
  const sigLine = lines.find((l, i) => i > 0 && !l.startsWith("untrusted comment:") && !l.startsWith("trusted comment:"));
  const trustedLine = lines.find((l) => l.startsWith("trusted comment: "));
  const globalLine = trustedLine ? lines[lines.indexOf(trustedLine) + 1] : undefined;
  if (!sigLine || !trustedLine || !globalLine) throw new SignatureError("malformed signature file");
  const sig = Buffer.from(sigLine, "base64");
  if (sig.length !== 74) throw new SignatureError("malformed signature");
  const algo = sig.subarray(0, 2).toString();
  if (!sig.subarray(2, 10).equals(publicKey.keyId)) throw new SignatureError("signed with a different key");
  const signature = sig.subarray(10);
  const message = algo === "ED" ? blake2b512(file) : algo === "Ed" ? Buffer.from(file) : undefined;
  if (!message) throw new SignatureError("unknown signature algorithm");
  if (!verify(null, message, publicKey.key, signature)) throw new SignatureError("signature doesn't match the file");
  const trustedComment = trustedLine.slice("trusted comment: ".length);
  const global = Buffer.from(globalLine, "base64");
  if (!verify(null, Buffer.concat([signature, Buffer.from(trustedComment)]), publicKey.key, global)) throw new SignatureError("trusted comment was altered");
  return { trustedComment };
}

// ---- signing side (release script and tests) ----

export interface SecretKey {
  keyId: Buffer;
  key: KeyObject;
  publicKey: PublicKey;
}

/** A new key pair. The secret is a base64 line: key id (8 bytes) + Ed25519 seed (32 bytes). Keep it secret. */
export function generateKeys(): { secret: string; publicKeyText: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = Buffer.from(crypto.getRandomValues(new Uint8Array(8)));
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
  const publicKeyText = `untrusted comment: Crewreview release key ${keyId.toString("hex").toUpperCase()}\n${Buffer.concat([Buffer.from("Ed"), keyId, pub]).toString("base64")}\n`;
  return { secret: Buffer.concat([keyId, seed]).toString("base64"), publicKeyText };
}

export function parseSecretKey(secret: string): SecretKey {
  const raw = Buffer.from(secret.trim(), "base64");
  if (raw.length !== 40) throw new Error("not a Crewreview secret key");
  const keyId = raw.subarray(0, 8);
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw.subarray(8)]), format: "der", type: "pkcs8" });
  const pub = createPublicKey(key);
  return { keyId, key, publicKey: { keyId, key: pub } };
}

/** A pre-hashed minisign signature for `file`. */
export function signFile(file: Uint8Array, secret: SecretKey, trustedComment: string, untrustedComment = "signature from Crewreview release key"): string {
  const signature = sign(null, blake2b512(file), secret.key);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), secret.key);
  const sigLine = Buffer.concat([Buffer.from("ED"), secret.keyId, signature]).toString("base64");
  return `untrusted comment: ${untrustedComment}\n${sigLine}\ntrusted comment: ${trustedComment}\n${global.toString("base64")}\n`;
}
