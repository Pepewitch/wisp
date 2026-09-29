//! What the packaged webview is actually served.
//!
//! Every other test in this crate drives native state. These read the document
//! and policy Tauri produces from the shared React bundle at compile time,
//! because that is the one place a browser-verified UI silently loses a
//! capability: the daemon serves the identical bytes with no content policy,
//! the app serves them with one, and a refused stylesheet renders wrong rather
//! than failing. `desktop/README.md` states the contract.

use std::path::Path;

use tauri::utils::assets::{AssetKey, CspHash, STYLE_NONCE_TOKEN};

/// The bundle is one self-contained document, and Tauri keys it by this path.
fn document() -> String {
    let context = wisp_desktop::context();
    let assets = context.assets();
    let Some(bytes) = assets.get(&AssetKey::from("index.html")) else {
        panic!("{}", no_index_html(assets))
    };
    String::from_utf8(bytes.to_vec()).expect("the bundle is UTF-8")
}

/// Why there is no `index.html`, in the two forms that has taken.
///
/// This has failed on CI against a bundle that demonstrably existed on disk
/// forty seconds earlier, and a bare `expect` sends the next person down the
/// same road: the message named the expectation and nothing about the world.
/// Report both sides instead. An empty asset list beside a present file is a
/// compile-time problem inside Tauri's codegen and worth an upstream issue; an
/// absent file just means the job never ran `bun run build:ui`.
fn no_index_html(assets: &dyn tauri::Assets<tauri::Wry>) -> String {
    let bundle = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/ui-dist/index.html");
    let on_disk = match std::fs::metadata(bundle.as_path()) {
        Ok(meta) => format!("{} bytes", meta.len()),
        Err(error) => format!("unreadable: {error}"),
    };
    let mut embedded: Vec<String> = assets
        .iter()
        .map(|(key, bytes)| format!("{key} ({} bytes)", bytes.len()))
        .collect();
    embedded.sort();
    let embedded = if embedded.is_empty() {
        "nothing at all".to_string()
    } else {
        embedded.join(", ")
    };
    format!(
        "the packaged bundle has no index.html\n  \
         on disk now: {} is {on_disk}\n  \
         embedded at compile time: {embedded}",
        bundle.display()
    )
}

/// xterm.js delivers the terminal's font, cell metrics and ANSI colors through
/// `<style>` elements its renderer creates after load, so the declared
/// `style-src 'unsafe-inline'` has to survive into the effective policy.
#[test]
fn inline_stylesheets_stay_allowed_for_the_terminal_renderer() {
    let context = wisp_desktop::context();
    let csp = context
        .config()
        .app
        .security
        .csp
        .as_ref()
        .expect("the packaged app declares a content policy")
        .to_string();
    assert!(
        csp.contains("style-src 'self' 'unsafe-inline'"),
        "style-src must allow inline stylesheets: {csp}"
    );
}

/// The negative half of the same rule, and the one that regressed: a nonce or
/// hash anywhere in `style-src` makes CSP ignore `'unsafe-inline'`, so Tauri
/// stamping stylesheets with a nonce would quietly refuse every stylesheet
/// created after load. Nothing may reintroduce that rewrite.
#[test]
fn tauri_stamps_no_style_nonce_or_hash_that_would_void_it() {
    assert!(
        !document().contains(STYLE_NONCE_TOKEN),
        "a style nonce placeholder survived into the packaged document"
    );

    let context = wisp_desktop::context();
    let styles: Vec<&str> = context
        .assets()
        .csp_hashes(&AssetKey::from("index.html"))
        .filter_map(|hash| match hash {
            CspHash::Style(value) => Some(value),
            _ => None,
        })
        .collect();
    assert!(
        styles.is_empty(),
        "style hashes would have the same effect as a nonce: {styles:?}"
    );
}

/// The reason `'unsafe-inline'` is granted at all, asserted against the
/// shipped bundle rather than trusted: xterm creates its stylesheets with
/// `document.createElement("style")`. If this ever stops matching, the
/// renderer has changed how it delivers styling and the policy above should be
/// tightened rather than inherited.
#[test]
fn the_shipped_bundle_really_does_create_stylesheets_after_load() {
    let document = document();
    // the minifier is free to pick the quote style, and does
    let created = ['"', '\'', '`']
        .iter()
        .any(|quote| document.contains(&format!("createElement({quote}style{quote})")));
    assert!(
        created,
        "no runtime stylesheet creation found in the bundle"
    );
}

/// `script-src` keeps its Tauri-managed nonces and hashes. Turning the rewrite
/// off wholesale would leave the bundle's inline module script authorized by
/// nothing but `'self'`, which is the protection the opt-out warns about.
#[test]
fn script_src_keeps_its_tauri_managed_hashes() {
    let context = wisp_desktop::context();
    let scripts = context
        .assets()
        .csp_hashes(&AssetKey::from("index.html"))
        .filter(|hash| matches!(hash, CspHash::Script(_)))
        .count();
    assert!(
        scripts > 0,
        "the inline bundle script must be authorized by a hash"
    );
}

/// Updater and relaunch authority stays behind bespoke Rust commands. Merely
/// installing the official plugin must never grant its generic commands to
/// the shared webview.
#[test]
fn the_webview_has_no_direct_native_update_or_system_authority() {
    let capability = include_str!("../capabilities/default.json");
    for forbidden in ["updater:", "process:", "shell:", "fs:", "http:", "dialog:"] {
        assert!(
            !capability.contains(forbidden),
            "default capability unexpectedly grants {forbidden}"
        );
    }
}

/// The exact Tauri core commands the shared UI reaches, and why:
///
/// * `listen` from `@tauri-apps/api/event` (task-focus and update-status
///   events) invokes `plugin:event|listen`, and its unlisten function
///   `plugin:event|unlisten`.
/// * `getCurrentWebview().setZoom` invokes `plugin:webview|set_webview_zoom`.
/// * Tauri's drag-region script, for the `data-tauri-drag-region` header,
///   invokes `plugin:window|internal_toggle_maximize` on a double click.
///
/// `invoke` of the app's own commands needs no core permission, and `isTauri`
/// performs no IPC at all.
const GRANTED_CORE_COMMANDS: &[&str] = &[
    "plugin:event|listen",
    "plugin:event|unlisten",
    "plugin:webview|set_webview_zoom",
    "plugin:window|internal_toggle_maximize",
];

/// Zoom changes presentation only. Keep it as the sole direct webview setter;
/// every stateful or outward action still crosses a purpose-built Rust command.
#[test]
fn the_webview_only_gets_the_core_permissions_it_uses() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json"))
            .expect("valid capability");
    assert_eq!(
        capability["permissions"],
        serde_json::json!([
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "core:webview:allow-set-webview-zoom",
            "core:window:allow-internal-toggle-maximize"
        ])
    );
}

/// Asserted against the ACL Tauri actually resolved at compile time, not the
/// JSON: every command the UI uses is reachable from the main webview, and a
/// sample of what `core:default` used to add on top is not.
#[test]
fn the_resolved_acl_grants_exactly_what_the_shared_ui_calls() {
    let mut context = wisp_desktop::context();
    let authority = context.runtime_authority_mut();
    let allowed = |command: &str| {
        authority
            .resolve_access(command, "main", "main", &tauri::ipc::Origin::Local)
            .is_some()
    };
    for command in GRANTED_CORE_COMMANDS {
        assert!(allowed(command), "{command} must stay reachable");
    }
    for command in [
        "plugin:event|emit",
        "plugin:event|emit_to",
        "plugin:window|close",
        "plugin:window|title",
        "plugin:window|get_all_windows",
        "plugin:window|start_dragging",
        "plugin:webview|get_all_webviews",
        "plugin:webview|internal_toggle_devtools",
        "plugin:app|version",
        "plugin:app|app_hide",
        "plugin:path|resolve_directory",
        "plugin:image|new",
        "plugin:menu|new",
        "plugin:tray|new",
        "plugin:resources|close",
        "plugin:dialog|open",
        "plugin:updater|check",
    ] {
        assert!(!allowed(command), "{command} must not be granted");
    }
}

/// Every place the shared UI touches the Tauri JavaScript API, so a new
/// import fails here instead of failing silently in the packaged app with a
/// refused IPC call. Adding one means adding its permission above.
#[test]
fn the_shared_ui_uses_only_the_tauri_apis_the_capability_grants() {
    fn sources(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("read web/src") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                sources(&path, out);
            } else if path
                .extension()
                .is_some_and(|extension| extension == "ts" || extension == "tsx")
            {
                out.push(path);
            }
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/src");
    let mut files = Vec::new();
    sources(&root, &mut files);
    assert!(!files.is_empty(), "no sources under {}", root.display());

    let allowed = [
        ("@tauri-apps/api/core", ["invoke", "isTauri"].as_slice()),
        ("@tauri-apps/api/event", ["listen"].as_slice()),
        ("@tauri-apps/api/webview", ["getCurrentWebview"].as_slice()),
    ];
    for file in files {
        let name = file.display().to_string();
        if name.contains(".test.") {
            continue;
        }
        let text = std::fs::read_to_string(&file).expect("source");
        assert!(
            !text.contains("__TAURI"),
            "{name} reaches Tauri internals directly"
        );
        for line in text.lines().filter(|line| line.contains("@tauri-apps/")) {
            let (module, names) = allowed
                .iter()
                .find(|(module, _)| line.contains(&format!("\"{module}\"")))
                .unwrap_or_else(|| panic!("{name} imports an ungranted Tauri API: {line}"));
            let imported = line
                .split_once('{')
                .and_then(|(_, rest)| rest.split_once('}'))
                .map(|(inside, _)| inside)
                .unwrap_or_else(|| panic!("{name}: expected a named import of {module}: {line}"));
            for item in imported.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                let item = item
                    .trim_start_matches("type ")
                    .split(" as ")
                    .next()
                    .unwrap_or(item);
                assert!(
                    names.contains(&item),
                    "{name} uses {item} from {module}; grant its permission first"
                );
            }
        }
        if text.contains("getCurrentWebview") {
            assert!(
                !text.contains("getCurrentWebview()") || {
                    let calls: Vec<&str> = text
                        .match_indices("getCurrentWebview().")
                        .map(|(at, _)| &text[at + "getCurrentWebview().".len()..])
                        .collect();
                    calls.iter().all(|rest| rest.starts_with("setZoom("))
                },
                "{name} calls a webview method other than setZoom"
            );
        }
    }
}

/// Tauri deserializes plugin configuration before the updater builder can
/// replace this inert value with the key compiled from updater-public.key.
/// Keep every endpoint and dangerous transport option out of the mutable JSON
/// configuration; the bespoke native updater owns those policy decisions.
#[test]
fn updater_configuration_is_parseable_but_carries_no_network_policy() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
    assert_eq!(
        config["plugins"]["updater"],
        serde_json::json!({ "pubkey": "UNCONFIGURED" })
    );
}
