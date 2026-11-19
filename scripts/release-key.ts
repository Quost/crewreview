#!/usr/bin/env bun
// The release signing key.
//   init <secret-file>   create a key pair: the secret goes to <secret-file> (mode 600), the public key is printed
//                        to paste into packages/engine/src/update.ts. Then: gh secret set RELEASE_SIGNING_KEY < <secret-file>
//   sign <file>          sign <file> with $RELEASE_SIGNING_KEY into <file>.minisig (used by the release workflow)
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { generateKeys, parseSecretKey, signFile, trustedComment } from "../packages/engine/src/minisign.ts";

const [cmd, arg] = process.argv.slice(2);
if (cmd === "init" && arg) {
  if (existsSync(arg)) {
    console.error(`${arg} exists; refusing to overwrite a key`);
    process.exit(1);
  }
  const { secret, publicKeyText } = generateKeys();
  await writeFile(arg, `${secret}\n`, { mode: 0o600 });
  console.log(publicKeyText.trim());
  console.log(`\nSecret key written to ${arg}. Keep a backup somewhere safe; losing it means users must reinstall by hand.`);
} else if (cmd === "sign" && arg) {
  const secret = process.env.RELEASE_SIGNING_KEY;
  if (!secret) {
    console.error("RELEASE_SIGNING_KEY is not set");
    process.exit(1);
  }
  const data = new Uint8Array(await readFile(arg));
  const version = (process.env.GITHUB_REF_NAME ?? "").replace(/^v/, "");
  const comment = trustedComment(arg.split("/").pop() ?? arg, version, Math.floor(Date.now() / 1000));
  await writeFile(`${arg}.minisig`, signFile(data, parseSecretKey(secret), comment));
  console.log(`signed ${arg}`);
} else {
  console.error("usage: bun scripts/release-key.ts init <secret-file> | sign <file>");
  process.exit(2);
}
