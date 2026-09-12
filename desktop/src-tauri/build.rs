/// `tauri::generate_context!()` embeds the shared React bundle at compile
/// time, but nothing tells cargo that it did. `tauri_build` declares
/// `tauri.conf.json`, the capabilities directory and the configured resources
/// as build inputs — not `frontendDist`. So `web/ui-dist/index.html`, the one
/// file this crate actually serves, is invisible to the fingerprint: a crate
/// compiled before `bun run build:ui` ever ran, or against last week's bundle,
/// is "fresh", and `cargo test` then checks a document nobody ships.
///
/// Both paths are named because they answer different questions. The directory
/// catches a bundle appearing or being cleared (`emptyOutDir`); the file
/// catches its contents changing, which a directory mtime does not.
fn main() {
    println!("cargo:rerun-if-changed=../../web/ui-dist");
    println!("cargo:rerun-if-changed=../../web/ui-dist/index.html");
    tauri_build::build()
}
