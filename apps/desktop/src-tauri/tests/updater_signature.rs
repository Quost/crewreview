//! The updater plugin checks every download with minisign-verify, taking the public key and the signature
//! base64-wrapped. These tests run the same calls on signatures from our own signer (scripts/release-key.ts), so a
//! release can't ship an update the app would refuse.
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use minisign_verify::{PublicKey, Signature};

fn unwrap_b64(text: &str) -> String {
    String::from_utf8(STANDARD.decode(text).unwrap()).unwrap()
}

/// What latest.json carries: the .minisig file, base64-encoded.
fn as_published(minisig: &str) -> Signature {
    Signature::decode(&unwrap_b64(&STANDARD.encode(minisig))).unwrap()
}

#[test]
fn the_release_key_in_tauri_conf_verifies_a_real_release_signature() {
    let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let key = PublicKey::decode(&unwrap_b64(conf["plugins"]["updater"]["pubkey"].as_str().unwrap())).unwrap();
    let data = include_bytes!("fixtures/SHA256SUMS");
    let signature = as_published(include_str!("fixtures/SHA256SUMS.minisig"));
    key.verify(data, &signature, true).unwrap();

    let mut altered = data.to_vec();
    altered[0] ^= 1;
    assert!(key.verify(&altered, &signature, true).is_err());
}

#[test]
fn new_signatures_carry_the_version_the_updater_requires() {
    let key = PublicKey::decode(include_str!("fixtures/sample.pub")).unwrap();
    let signature = as_published(include_str!("fixtures/sample.bin.minisig"));
    key.verify(include_bytes!("fixtures/sample.bin"), &signature, true).unwrap();
    // The plugin reads tab-separated key:value pairs from the trusted comment (after the signature checked out).
    let version = signature
        .trusted_comment()
        .split('\t')
        .find_map(|pair| pair.strip_prefix("version:"));
    assert_eq!(version, Some("0.3.0"));
}
