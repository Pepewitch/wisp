//! Release-only verifier for the updater artifact's Minisign signature.

use std::fs::{read_to_string, File};
use std::io::Read;
use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use minisign_verify::{PublicKey, Signature};

fn main() {
    if let Err(error) = verify() {
        eprintln!("verify-update-signature: {error}");
        std::process::exit(1);
    }
}

fn verify() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let artifact = PathBuf::from(args.next().ok_or("missing artifact path")?);
    let signature = PathBuf::from(args.next().ok_or("missing signature path")?);
    let public_key = PathBuf::from(args.next().ok_or("missing public key path")?);
    if args.next().is_some() {
        return Err("usage: verify-update-signature <artifact> <signature> <public-key>".into());
    }

    // Tauri stores both values as base64-wrapped Minisign text. Decode that
    // transport layer before handing the ordinary Minisign document to the
    // independent verifier.
    let public_key = decode_tauri_text(&read_to_string(public_key)?)?;
    let signature = decode_tauri_text(&read_to_string(signature)?)?;
    let public_key = PublicKey::decode(&public_key)?;
    let signature = Signature::decode(&signature)?;
    let mut verifier = public_key.verify_stream(&signature)?;
    let mut file = File::open(artifact)?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        verifier.update(&buffer[..read]);
    }
    verifier.finalize()?;
    println!("updater signature verified");
    Ok(())
}

fn decode_tauri_text(encoded: &str) -> Result<String, Box<dyn std::error::Error>> {
    let decoded = BASE64_STANDARD.decode(encoded.trim())?;
    Ok(String::from_utf8(decoded)?)
}
