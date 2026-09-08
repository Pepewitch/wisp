# Releasing and publishing Wisp

Use this playbook for a versioned Linux/macOS release, GitHub publication, or
Homebrew tap update. It records the evolving v0.4 process, including the first
signed Desktop publication in alpha.12 and the first public in-app update in
alpha.13. The scripts are authoritative when a command or filename changes.

Publishing a tag, GitHub release, or tap commit changes public state. Do it
only when the owner explicitly authorizes that release. Preparation and local
qualification do not imply permission to publish.

## Release invariants

- A release is built from one clean commit carrying one synchronized version.
- The exact commit has an annotated `v<version>` tag before release scripts run
  with `--require-tag`.
- Linux and Apple Silicon assets are rebuilt twice and compared byte for byte.
- Published tags, assets, release notes, and qualification evidence are
  immutable. Fix a bad release with a new version, never by moving a tag or
  replacing an asset.
- Candidate wording stays candidate wording until the public path passes.
  Never claim production readiness, broad platform support, human acceptance,
  signing, notarization, or qualification that the evidence does not prove.
- Raw evaluator output stays gitignored. Commit only reviewed, sanitized
  verdict records. Keep failed or superseded attempts under a clearly named
  `superseded/` path.
- Wisp and its Homebrew tap are separate repositories. Review, commit, and
  publish each one independently.

Current distribution targets are Ubuntu 24.04 LTS x86_64/glibc, an
experimental Apple Silicon arm64 daemon archive, and an Apple Silicon desktop
`.app` configured for macOS 12.3 or newer. `scripts/release-macos.ts` keeps the
standalone daemon archive ad-hoc signed. Local and reproducibility Desktop
builds are also ad-hoc, but a publishable Desktop archive must use the
`--signed` path: Developer ID Application signature, trusted timestamp,
hardened runtime, notarization, staple, and a separate updater signature.

## Automated publishing on tag push

`.github/workflows/release.yml` automates the publish steps below. The
maintainer's push of the annotated `v<version>` tag is the explicit publish
authorization and the sole trigger. It runs two jobs:

1. `release-linux` requires the tag to point at `origin/main`, scans history
   with Gitleaks, builds the Linux asset with `--require-tag`, proves the
   three files reproduce byte for byte on a clean rebuild, and exercises the
   artifact through `scripts/test-install.sh` and
   `scripts/test-activation.sh`.
2. `publish` runs on arm64 macOS, builds and reproducibility-checks the Mac
   daemon and unsigned Desktop payloads the same way, then creates and verifies
   one trusted Desktop archive. It verifies all ten assets, renders and audits
   both Homebrew recipes plus the Desktop update channel offline, creates the
   "Wisp <version>" GitHub prerelease with the release notes as its body,
   verifies the ten public URLs and both Desktop trust chains anonymously,
   audits every non-livecheck Formula/Cask rule online, pushes exactly
   `Formula/wisp.rb`, `Casks/wisp-desktop.rb`, and
   `updates/wisp-desktop-alpha.json` to `Pepewitch/homebrew-tap` in one commit,
   waits for the fixed raw channel URL to converge, then requires the full
   livecheck audit.

The workflow needs these repository secrets:

- `HOMEBREW_TAP_TOKEN`: fine-grained token with Contents write access to the tap;
- `APPLE_CERTIFICATE`: base64 PKCS#12 Developer ID Application certificate;
- `APPLE_CERTIFICATE_PASSWORD`;
- `APPLE_SIGNING_IDENTITY`: the exact Developer ID Application identity;
- `APPLE_API_ISSUER`, `APPLE_API_KEY`, and `APPLE_API_PRIVATE_KEY` for
  notarization;
- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for the
  updater archive.

The matching updater public key is committed at
`desktop/src-tauri/updater-public.key`. Never print or place a private value on
a command line captured in logs. The workflow writes the Apple API key to a
mode-`0600` runner-temporary file and stops before publication if any input or
trust check is absent. It
never writes back to this repository — assets attach to the GitHub release
and the Formula/Cask commit lands in the tap repository — so publishing cannot
re-trigger this repository's CI. Nothing is public until the `publish` job
runs, so a failed Linux-side gate cannot half-publish a release.

Preparation (steps 1-3, landed on `main` as the release preparation PR), the
external evaluator panel, the exact-credential scan of step 5, local
qualification in step 9, and the step 10 close-out records remain private
maintainer records.
Steps 4-8 below remain the manual fallback and the source of the automated
gates. If the workflow fails before the prerelease is created, delete the
tag, fix, and re-tag: an unpublished tag is still mutable. Once assets are
public, never mutate them.

## 1. Prepare a release branch

Start from a fresh `origin/main` worktree and install the locked dependencies:

```sh
version=0.0.0-alpha.N
git fetch origin --tags
git worktree add ".worktrees/release-$version" \
  -b "release/$version" origin/main
cd ".worktrees/release-$version"
bun install --frozen-lockfile
```

Set the values used below:

```sh
tag="v$version"
repo="$(git rev-parse --show-toplevel)"
release_dir="$repo/dist/release/$tag"
notes="$repo/docs/v0.N/RELEASE-NOTES-alpha.N.md"
tap="$(brew --repository Pepewitch/tap)"
```

The manual fallback requires `Pepewitch/tap` to be Homebrew's registered,
clean tap checkout so name-based Formula and Cask audits resolve the files just
rendered. Do not substitute an arbitrary clone without registering it first.

Confirm that the target version and tag do not already exist locally or
remotely. Stop if either exists; release identities are not reusable.

```sh
test -z "$(git tag --list "$tag")" || {
  echo "local tag already exists: $tag" >&2
  exit 1
}
remote_tag="$(git ls-remote --tags origin "refs/tags/$tag")" || exit
if test -n "$remote_tag"; then
  echo "remote tag already exists: $tag" >&2
  exit 1
fi
```

## 2. Synchronize the version and claims

For every release, update these direct pins:

- `package.json`;
- `src/version.ts`;
- `desktop/src-tauri/Cargo.toml`, `Cargo.lock`, and `tauri.conf.json`;
- the literal source-build expectations in `tests/version.test.ts`;
- the default and help text in `scripts/install.sh`;
- the default artifact paths in `scripts/test-install.sh` and
  `scripts/test-activation.sh`;
- `VERSION` in `scripts/evaluator/run.sh`; and
- the new release notes plus README/install wording that truly
  applies to this version.

Search the old version before committing:

```sh
rg -n -F '<old-version>' \
  package.json src tests scripts README.md docs skills
```

Classify every match. Do not rewrite published release notes merely to make an
old version look current.
`web/ui/package.json` has its own workspace version and is not a Wisp release
pin.

Write release notes before tagging. State platform scope, signing posture,
install/upgrade commands, changes, known limits, and the exact ten expected
assets. Before public verification, describe unrun gates as pending.

## 3. Run the source gates

Run the complete repository gate and the release-specific checks:

```sh
bun run check
bun run brand:check
bun run smoke
bun run build
bun run test:evaluator
git diff --check
```

Review the full source diff. `web/ui-dist/index.html` is ignored build output;
never stage it in the release-preparation PR. Commit the release preparation
and land it on `main`. Re-run `bun run build` after the commit and require a
clean source tree:

```sh
bun run build
git fetch origin
test -z "$(git status --porcelain=v1 --untracked-files=normal)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
```

Do not tag an unmerged branch or a dirty worktree.

Create the annotated tag locally. Do not push it yet:

```sh
git tag -a "$tag" -m "Wisp $version"
test "$(git describe --tags --exact-match HEAD)" = "$tag"
```

## 4. Reproduce the payload, then build all ten assets

Build on Apple Silicon macOS so the same checkout can cross-compile Linux and
produce and verify the native Mac artifacts. Generate the ignored UI bundle
once and retain its checksum; every builder in this release must consume those
exact bytes rather than silently regenerate them. First build the Desktop app
without release credentials; this is the reproducible payload proof, not the
public Desktop artifact:

```sh
bun run build:ui
bun run scripts/release-linux.ts --require-tag
bun run scripts/release-macos.ts --require-tag
desktop_repro_target="$(mktemp -d)"
WISP_PREBUILT_UI=1 CARGO_TARGET_DIR="$desktop_repro_target" \
  bun run scripts/release-desktop.ts --require-tag
```

After the final signed pass, the release directory must contain exactly:

```text
wisp-v<version>-linux-x86_64
release-manifest.json
SHA256SUMS
wisp-v<version>-darwin-arm64.tar.gz
release-manifest-darwin-arm64.json
SHA256SUMS-darwin-arm64
wisp-desktop-v<version>-darwin-arm64.tar.gz
wisp-desktop-v<version>-darwin-arm64.tar.gz.sig
release-manifest-desktop-darwin-arm64.json
SHA256SUMS-desktop-darwin-arm64
```

At the reproducibility stage the signature file is absent and the Desktop
manifest truthfully records an ad-hoc build. Snapshot those nine files, rebuild
from the same clean tag, and compare every byte:

```sh
first="$(mktemp -d)"
cp "$release_dir"/* "$first/"
bun run scripts/release-linux.ts --require-tag
bun run scripts/release-macos.ts --require-tag
CARGO_TARGET_DIR="$desktop_repro_target" \
  cargo clean --manifest-path desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR="$desktop_repro_target" \
  bun run scripts/release-desktop.ts --require-tag
for file in "$first"/*; do
  cmp -s "$file" "$release_dir/$(basename "$file")" || {
    echo "non-reproducible asset: $(basename "$file")" >&2
    exit 1
  }
done
(cd "$release_dir" &&
  shasum -a 256 -c SHA256SUMS &&
  shasum -a 256 -c SHA256SUMS-darwin-arm64 &&
  shasum -a 256 -c SHA256SUMS-desktop-darwin-arm64)
```

After that comparison passes, provide the release credentials listed above and
build the one public Desktop archive:

```sh
WISP_PREBUILT_UI=1 CARGO_TARGET_DIR="$(mktemp -d)" \
  bun run scripts/release-desktop.ts --require-tag --signed
```

On a maintainer Mac, `APPLE_CERTIFICATE` and
`APPLE_CERTIFICATE_PASSWORD` may both be omitted when
`APPLE_SIGNING_IDENTITY` is already available in the unlocked login Keychain.
Provide the pair together when importing a PKCS#12 certificate, as CI does;
the release script refuses a partial pair. The notarization API key and Tauri
updater key remain required in both modes.

Timestamped Apple signatures are intentionally not byte-reproducible. The
signed pass must not be compared with the ad-hoc payload. Instead, the release
script verifies Developer ID identity, timestamp, hardened runtime,
notarization, and staple; archives the app; updater-signs that exact archive;
verifies the signature with an independent streaming verifier; re-extracts the
archive; and repeats the Apple trust checks. Its manifest and checksum set bind
the signature file and trust posture.

The builders refuse a dirty tree or a `package.json`/`src/version.ts`
mismatch. The Mac builder also verifies arm64 architecture, ad-hoc signature,
archive contents, and embedded version/commit identity.
The Desktop builder additionally verifies the Cargo/Tauri/plist/binary version,
Mach-O deployment minimum, exact bundle inventory, absence of builder paths,
and a clean source tree after packaging. Tag CI builds and reproduces the UI on
Linux, transfers it with a checksum, and sets `WISP_PREBUILT_UI=1` for every
Desktop pass so the daemon and application package one canonical bundle.
Apple's linker changes the
required Mach-O UUID when Cargo's absolute target path changes. Use the same
`CARGO_TARGET_DIR` for both reproducibility builds, but run `cargo clean` in
that exact target between them so the second pass cannot be a cache hit.

Exercise the Linux artifact through the public installer contract and the
fake-model evaluator before spending model quota:

```sh
bun run test:install
bun run test:activation
scripts/evaluator/run.sh --preflight --rebuild-image
```

Run the paid evaluator panel only when the release scope requires it. Follow
[`scripts/evaluator/README.md`](../../../scripts/evaluator/README.md): use a
revocable, spend-capped mode-`0600` key file, run cases sequentially, and
review the sanitized evidence before retaining any record.

## 5. Scan source, history, artifacts, and evidence

Run Gitleaks over repository history. A linked worktree's `.git` file points
into the primary checkout, so mount their common root at the same absolute
path inside the scanner:

```sh
common_root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
docker run --rm --platform linux/amd64 \
  --mount "type=bind,source=$common_root,target=$common_root,readonly" \
  zricethezav/gitleaks:v8.28.0 git "$repo" \
  --gitleaks-ignore-path "$repo/.gitleaksignore" \
  --redact
```

The tracked ignore file has one fingerprint-exact exception for a reviewed
minified `web/vendor/xterm.js` false positive in history. Never replace it
with a path/rule-wide exclusion. Any new fingerprint fails the gate.

Also scan the ten release files and every retained evaluator directory for
the exact active credential used during qualification. The following scanner
reads the secret from its file, checks tracked files plus explicit artifact
roots, and prints paths only:

```sh
key_file=/absolute/path/to/mode-0600-key
evidence_dir="$repo/dist/evaluator/<run-id>"
KEY_FILE="$key_file" python3 - "$repo" "$release_dir" "$evidence_dir" <<'PY'
import os
import subprocess
import sys
from pathlib import Path

repo = Path(sys.argv[1]).resolve()
secret = Path(os.environ["KEY_FILE"]).read_bytes().strip()
if not secret:
    raise SystemExit("credential file is empty")

tracked = subprocess.check_output(
    ["git", "-C", str(repo), "ls-files", "-z"]
).split(b"\0")
paths = [repo / raw.decode() for raw in tracked if raw]
for value in sys.argv[2:]:
    root = Path(value)
    if root.exists():
        paths.extend(path for path in root.rglob("*") if path.is_file())

hits = []
for path in paths:
    if path.is_symlink() or path.stat().st_size > 100_000_000:
        continue
    if secret in path.read_bytes():
        hits.append(str(path))
if hits:
    print("\n".join(sorted(set(hits))))
    raise SystemExit("exact credential scan failed")
print("exact credential scan: pass")
PY
```

Never place the credential itself on a command line or print it. The evaluator
performs its own real-key and key-shaped scan, but the host-side closeout scan
is still required.

Inspect manifests and release notes for local paths, account data, tokens,
headers, query strings, and unsupported claims. Compiled binaries disable
automatic `.env` and `bunfig` loading in `scripts/build-binary.ts`; keep that
boundary.

## 6. Publish the GitHub prerelease

Reconfirm explicit authorization, GitHub authentication, repository
visibility, the tag target, and the asset list. Before pushing the tag, render
the Formula and Cask from the local manifests and run offline audits so a DSL
error cannot strand public assets without an installable tap update:

```sh
bun run scripts/render-homebrew-formula.ts \
  --manifest "$release_dir/release-manifest-darwin-arm64.json" \
  --output "$tap/Formula/wisp.rb"
bun run scripts/render-homebrew-cask.ts \
  --manifest "$release_dir/release-manifest-desktop-darwin-arm64.json" \
  --output "$tap/Casks/wisp-desktop.rb"
bun run scripts/render-desktop-update-channel.ts \
  --manifest "$release_dir/release-manifest-desktop-darwin-arm64.json" \
  --notes "$notes" \
  --output "$tap/updates/wisp-desktop-alpha.json"
bun test tests/homebrew-formula.test.ts tests/homebrew-cask.test.ts \
  tests/desktop-update-channel.test.ts
brew style "$tap/Formula/wisp.rb" "$tap/Casks/wisp-desktop.rb"
brew audit --strict Pepewitch/tap/wisp
brew audit --strict --cask Pepewitch/tap/wisp-desktop
```

Then push the tag and create the release from the existing tag:

```sh
gh auth status
gh repo view Pepewitch/wisp --json visibility,url
git push origin "$tag"

gh release create "$tag" \
  "$release_dir/wisp-v$version-linux-x86_64" \
  "$release_dir/release-manifest.json" \
  "$release_dir/SHA256SUMS" \
  "$release_dir/wisp-v$version-darwin-arm64.tar.gz" \
  "$release_dir/release-manifest-darwin-arm64.json" \
  "$release_dir/SHA256SUMS-darwin-arm64" \
  "$release_dir/wisp-desktop-v$version-darwin-arm64.tar.gz" \
  "$release_dir/wisp-desktop-v$version-darwin-arm64.tar.gz.sig" \
  "$release_dir/release-manifest-desktop-darwin-arm64.json" \
  "$release_dir/SHA256SUMS-desktop-darwin-arm64" \
  --repo Pepewitch/wisp \
  --verify-tag \
  --prerelease \
  --latest=false \
  --title "Wisp $version" \
  --notes-file "$notes"
```

Do not use `--clobber`, generate a tag through `gh`, or upload replacement
bytes. If publication is partial, inspect whether the release is still a
draft before acting. Never mutate an already published release.

Verify the published metadata and resolve the remote tag back to the candidate
commit:

```sh
gh release view "$tag" --repo Pepewitch/wisp \
  --json tagName,isDraft,isPrerelease,assets,url
git fetch origin --tags
test "$(git rev-list -n1 "$tag")" = "$(git rev-parse HEAD)"
```

## 7. Verify anonymously

Download all ten assets through their public URLs without a GitHub token and
compare them with the qualified local bytes:

```sh
anon="$(mktemp -d)"
for file in \
  "wisp-v$version-linux-x86_64" \
  release-manifest.json \
  SHA256SUMS \
  "wisp-v$version-darwin-arm64.tar.gz" \
  release-manifest-darwin-arm64.json \
  SHA256SUMS-darwin-arm64 \
  "wisp-desktop-v$version-darwin-arm64.tar.gz" \
  "wisp-desktop-v$version-darwin-arm64.tar.gz.sig" \
  release-manifest-desktop-darwin-arm64.json \
  SHA256SUMS-desktop-darwin-arm64
do
  curl --proto '=https' --tlsv1.2 -fsSL \
    "https://github.com/Pepewitch/wisp/releases/download/$tag/$file" \
    -o "$anon/$file"
  cmp -s "$release_dir/$file" "$anon/$file" || {
    echo "public asset differs: $file" >&2
    exit 1
  }
done
(cd "$anon" &&
  shasum -a 256 -c SHA256SUMS &&
  shasum -a 256 -c SHA256SUMS-darwin-arm64 &&
  shasum -a 256 -c SHA256SUMS-desktop-darwin-arm64)
cargo run --quiet --locked \
  --manifest-path desktop/src-tauri/Cargo.toml \
  --bin verify-update-signature \
  --features release-verifier -- \
  "$anon/wisp-desktop-v$version-darwin-arm64.tar.gz" \
  "$anon/wisp-desktop-v$version-darwin-arm64.tar.gz.sig" \
  desktop/src-tauri/updater-public.key
tampered="$(mktemp)"
cp "$anon/wisp-desktop-v$version-darwin-arm64.tar.gz" "$tampered"
printf 'tampered' >> "$tampered"
if cargo run --quiet --locked \
  --manifest-path desktop/src-tauri/Cargo.toml \
  --bin verify-update-signature \
  --features release-verifier -- \
  "$tampered" \
  "$anon/wisp-desktop-v$version-darwin-arm64.tar.gz.sig" \
  desktop/src-tauri/updater-public.key
then
  echo "updater signature accepted a changed artifact" >&2
  exit 1
fi
extracted="$(mktemp -d)"
tar -xzf "$anon/wisp-desktop-v$version-darwin-arm64.tar.gz" -C "$extracted"
codesign --verify --deep --strict --verbose=2 "$extracted/Wisp.app"
xcrun stapler validate "$extracted/Wisp.app"
spctl --assess --type execute --verbose=4 "$extracted/Wisp.app"
```

This checks the bytes users can actually fetch, not only GitHub's authenticated
release metadata.

## 8. Publish the Homebrew Formula, Cask, and update channel

Once the Mac assets are public, repeat the prepared recipe audits online and
synchronize the three files in one tap commit:

```sh
tap="$(brew --repository Pepewitch/tap)"
git -C "$tap" fetch origin
test -z "$(git -C "$tap" status --porcelain=v1 --untracked-files=normal)"
git -C "$tap" pull --ff-only

bun run scripts/render-homebrew-formula.ts \
  --manifest "$release_dir/release-manifest-darwin-arm64.json" \
  --output "$tap/Formula/wisp.rb"
bun run scripts/render-homebrew-cask.ts \
  --manifest "$release_dir/release-manifest-desktop-darwin-arm64.json" \
  --output "$tap/Casks/wisp-desktop.rb"
bun run scripts/render-desktop-update-channel.ts \
  --manifest "$release_dir/release-manifest-desktop-darwin-arm64.json" \
  --notes "$notes" \
  --output "$tap/updates/wisp-desktop-alpha.json"
bun test tests/homebrew-formula.test.ts tests/homebrew-cask.test.ts \
  tests/desktop-update-channel.test.ts
brew style "$tap/Formula/wisp.rb" "$tap/Casks/wisp-desktop.rb"
homebrew_api_token="$(gh auth token)" || {
  echo "GitHub authentication is required for Homebrew's online audits" >&2
  exit 1
}
test -n "$homebrew_api_token" || {
  echo "GitHub authentication returned an empty token" >&2
  exit 1
}
HOMEBREW_GITHUB_API_TOKEN="$homebrew_api_token" \
  brew audit --strict --online Pepewitch/tap/wisp
HOMEBREW_GITHUB_API_TOKEN="$homebrew_api_token" \
  brew audit --strict --online --cask \
    --except github_prerelease_version,livecheck_version \
    Pepewitch/tap/wisp-desktop
git -C "$tap" diff --check
git -C "$tap" diff -- Formula/wisp.rb Casks/wisp-desktop.rb \
  updates/wisp-desktop-alpha.json
```

The Formula and Cask must pin immutable GitHub URLs and SHA-256 values and
contain no credential. The Formula keeps daemon state outside Homebrew's prefix
and exposes the launchd service. The Cask installs the signed and notarized
`Wisp.app`, depends on the Formula, declares `auto_updates true`, uses the alpha
channel for livecheck, and states that uninstall preserves Desktop metadata and
Keychain credentials unless the user removes connections or resets Desktop
data first. The channel must name the same archive and updater signature bound
by the release manifest.

`github_prerelease_version` is the persistent audit exception for the
custom-tap alpha. `livecheck_version` is deferred only before publication,
because the staged Cask is necessarily newer than the still-public channel.
Do not exclude Homebrew's signing or Gatekeeper checks.

Commit and push the tap only with explicit authorization:

```sh
git -C "$tap" add Formula/wisp.rb Casks/wisp-desktop.rb \
  updates/wisp-desktop-alpha.json
git -C "$tap" diff --cached --check
git -C "$tap" diff --cached -- Formula/wisp.rb Casks/wisp-desktop.rb \
  updates/wisp-desktop-alpha.json
git -C "$tap" commit -F - <<EOF
release: update Wisp to $version

Co-authored-by: factory-droid[bot] <138933559+factory-droid[bot]@users.noreply.github.com>
EOF
git -C "$tap" push origin HEAD:main
```

The fixed raw channel URL advertises a five-minute cache. Wait for that exact
URL—not a cache-busting variant—to return the committed bytes before running
the full livecheck audit:

```sh
public_channel="$(mktemp)"
channel_url="https://raw.githubusercontent.com/Pepewitch/homebrew-tap/main/updates/wisp-desktop-alpha.json"
channel_ready=0
for _ in $(seq 1 24); do
  if curl --proto '=https' --tlsv1.2 -fsSL "$channel_url" \
    -o "$public_channel" && \
    cmp -s "$tap/updates/wisp-desktop-alpha.json" "$public_channel"
  then
    channel_ready=1
    break
  fi
  sleep 15
done
test "$channel_ready" = 1

brew update
homebrew_api_token="$(gh auth token)" || {
  echo "GitHub authentication is required for Homebrew's online audits" >&2
  exit 1
}
test -n "$homebrew_api_token" || {
  echo "GitHub authentication returned an empty token" >&2
  exit 1
}
HOMEBREW_GITHUB_API_TOKEN="$homebrew_api_token" \
  brew audit --strict --online Pepewitch/tap/wisp
HOMEBREW_GITHUB_API_TOKEN="$homebrew_api_token" \
  brew audit --strict --online --cask \
    --except github_prerelease_version \
    Pepewitch/tap/wisp-desktop
```

This post-push Cask audit must not exclude `livecheck_version`; it proves the
application's compiled fixed channel, the public tap, and the Cask agree.

## 9. Qualify fresh install and upgrade

Back up production state before changing an owner installation. Restrict the
backup, record `wisp version --json`, hash `config.json`, run SQLite
`PRAGMA integrity_check`, count tasks/turns, and record every live branch,
worktree, and dirty path. Never infer preservation from a successful command.

For a fresh Mac:

```sh
brew install --cask Pepewitch/tap/wisp-desktop
wisp init
brew services start wisp
wisp doctor --harness droid
brew test Pepewitch/tap/wisp
open -a Wisp
```

For an existing installation:

```sh
brew update
brew upgrade wisp
brew upgrade --cask --greedy wisp-desktop
brew services restart wisp
wisp version --json
wisp doctor --harness droid
brew test Pepewitch/tap/wisp
```

Verify the launchd-managed daemon, one real task, a browser follow-up, restart,
and the same persisted task afterward. Compare the pre/post config, SQLite
integrity and counts, witness task/turns, branches, worktrees, and repository
dirty state. Confirm unrelated listeners remain untouched.

Also prove installed and source development coexist:

```sh
wisp version --json
wisp-dev version --json
wisp token
wisp-dev token
```

Bare `wisp` must use production `~/.wisp`; `wisp-dev` must use
`~/.wisp-dev`. Their configured ports must differ.

For the desktop receipt, verify the installed Cask and Formula, `.app`
architecture, plist and Mach-O deployment minimum, code-signing posture,
launch survival, Local connection, native folder picker, one remote connection,
rename, reconnect, and offline Remove connection. Do not uninstall a user's
working daemon merely to simulate an absent dependency; the audited Cask
`depends_on formula:` contract is the install proof.

The mechanical installed-app checks are:

```sh
brew list --formula wisp
brew list --cask wisp-desktop
app=/Applications/Wisp.app
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" = dev.wisp.desktop
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" = "$version"
test "$(lipo -archs "$app/Contents/MacOS/wisp-desktop")" = arm64
vtool -show-build "$app/Contents/MacOS/wisp-desktop" | grep -Eq '^ *minos +12\.3(\.0)?$'
codesign --verify --deep --strict --verbose=2 "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=4 "$app"
open -a Wisp
sleep 4
ps -axo comm= | awk -F/ '$NF == "wisp-desktop" { found=1 } END { exit !found }'
```

The first signed, self-update-capable Desktop release is a bootstrap release.
Alpha.12 filled that role because the public alpha.8 app could not discover it;
alpha.13 completed the first two-version public receipt. For a new updater,
trust-root, channel, or installer change, leave the older signed version
installed, publish the next version, use **Updates → Check now**, confirm the
displayed old/new versions and notes, then choose **Update Desktop and
relaunch**. Re-run the Apple checks against the replaced app and confirm
connections, tasks, and daemon state persist. A bad-signature negative test
must leave the older app runnable.

The native updater does not rewrite Homebrew's Caskroom receipt. After proving
the in-app replacement, run `brew upgrade --cask --greedy wisp-desktop` and
verify Homebrew reconciles to the same public version without a downgrade.
Record the two-version receipt; a fresh install alone does not qualify
self-update. See [`docs/DESKTOP-UPDATES.md`](../../../docs/DESKTOP-UPDATES.md).

## 10. Close out without rewriting history

After public qualification, update the README, install guides, and release
notes with only the facts just observed. Keep raw and machine-specific
evidence outside the public repository. Retain prior passes and failures in
the private project record rather than rewriting them.

The final receipt should name:

- version, tag, full commit, and clean-tree status;
- all ten filenames and SHA-256 values;
- reproducibility result, configured desktop minimum, and actually qualified
  host versions;
- source, install, activation, evaluator, security, Formula/Cask audit/test, and
  anonymous-download results;
- production backup and state-preservation result;
- exact limitations, including any unrun updater or human qualification gate;
- Wisp and tap commit ids plus public release URLs.

If any claim cannot be tied to retained evidence, remove or weaken the claim.
