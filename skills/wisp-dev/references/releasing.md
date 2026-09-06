# Releasing and publishing Wisp

Use this playbook for a versioned Linux/macOS release, GitHub publication, or
Homebrew tap update. It records the v0.4 process that produced and qualified
the public alpha.8 release. The scripts are authoritative when a command or
filename changes.

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
`.app` configured for macOS 12.3 or newer. `scripts/release-macos.ts` and
`scripts/release-desktop.ts` ad-hoc sign their outputs; they do not Developer
ID sign, notarize, or timestamp them.

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
   daemon and desktop assets the same way, verifies all nine checksums, renders
   and audits both Homebrew recipes offline, creates the
   "Wisp <version>" GitHub prerelease with the release notes as its body,
   verifies the nine public URLs anonymously, audits the Formula and Cask
   online, and pushes exactly `Formula/wisp.rb` and
   `Casks/wisp-desktop.rb` to `Pepewitch/homebrew-tap` in one commit.

The workflow needs the `HOMEBREW_TAP_TOKEN` repository secret: a fine-grained
personal access token with Contents write access to the tap repository. It
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
install/upgrade commands, changes, known limits, and the exact nine expected
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

Review the full diff, including any regenerated
`web/ui-dist/index.html`. Commit the release preparation and land it on
`main`. Re-run `bun run build` after the commit and require a clean bundle:

```sh
bun run build
git diff --exit-code -- web/ui-dist/index.html
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

## 4. Build and reproduce all nine assets

Build on Apple Silicon macOS so the same checkout can cross-compile Linux and
produce, sign, and verify the native Mac binary:

```sh
bun run build:ui
bun run scripts/release-linux.ts --require-tag
bun run scripts/release-macos.ts --require-tag
CARGO_TARGET_DIR="$(mktemp -d)" bun run scripts/release-desktop.ts --require-tag
```

The release directory must contain exactly:

```text
wisp-v<version>-linux-x86_64
release-manifest.json
SHA256SUMS
wisp-v<version>-darwin-arm64.tar.gz
release-manifest-darwin-arm64.json
SHA256SUMS-darwin-arm64
wisp-desktop-v<version>-darwin-arm64.tar.gz
release-manifest-desktop-darwin-arm64.json
SHA256SUMS-desktop-darwin-arm64
```

Snapshot those files, rebuild from the same clean tag, and compare every byte:

```sh
first="$(mktemp -d)"
cp "$release_dir"/* "$first/"
bun run scripts/release-linux.ts --require-tag
bun run scripts/release-macos.ts --require-tag
CARGO_TARGET_DIR="$(mktemp -d)" bun run scripts/release-desktop.ts --require-tag
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

The builders refuse a dirty tree or a `package.json`/`src/version.ts`
mismatch. The Mac builder also verifies arm64 architecture, ad-hoc signature,
archive contents, and embedded version/commit identity.
The desktop builder additionally verifies the Cargo/Tauri/plist/binary version,
Mach-O deployment minimum, exact bundle inventory, absence of builder paths,
and a clean committed web bundle after packaging. Use different
`CARGO_TARGET_DIR` values for the two desktop builds so Cargo cannot turn the
reproducibility check into a cache hit.

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

Also scan the nine release files and every retained evaluator directory for
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
bun test tests/homebrew-formula.test.ts tests/homebrew-cask.test.ts
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

Download all nine assets through their public URLs without a GitHub token and
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
```

This checks the bytes users can actually fetch, not only GitHub's authenticated
release metadata.

## 8. Render and publish the Homebrew Formula and Cask

Once the Mac assets are public, repeat the prepared recipe audits online and
synchronize the two files in one tap commit:

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
bun test tests/homebrew-formula.test.ts tests/homebrew-cask.test.ts
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
    --except signing,github_prerelease_version \
    Pepewitch/tap/wisp-desktop
git -C "$tap" diff --check
git -C "$tap" diff -- Formula/wisp.rb Casks/wisp-desktop.rb
```

The Formula and Cask must pin immutable GitHub URLs and SHA-256 values, contain
no credential, and retain the ad-hoc/non-notarized caveat. The Formula keeps
daemon state outside Homebrew's prefix and exposes the launchd service. The
Cask installs `Wisp.app`, depends on the Formula, and states that uninstall
preserves desktop metadata and Keychain credentials unless the user removes
connections or resets desktop data first.

The two named exceptions are deliberate and temporary for the disclosed custom
tap alpha: `signing` skips Homebrew's Gatekeeper audit while the app is ad-hoc
signed, and `github_prerelease_version` permits the immutable prerelease asset.
The Cask must also skip livecheck while no stable desktop release exists. Keep
all other strict online audits enabled. Remove each exception as part of the
same change that makes its premise false; never carry `signing` into a release
whose manifest claims Developer ID signing and notarization.

Commit and push the tap only with explicit authorization:

```sh
git -C "$tap" add Formula/wisp.rb Casks/wisp-desktop.rb
git -C "$tap" diff --cached --check
git -C "$tap" diff --cached -- Formula/wisp.rb Casks/wisp-desktop.rb
git -C "$tap" commit -F - <<EOF
release: update Wisp to $version

Co-authored-by: factory-droid[bot] <138933559+factory-droid[bot]@users.noreply.github.com>
EOF
git -C "$tap" push origin HEAD:main
```

Then verify the public tap:

```sh
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
    --except signing,github_prerelease_version \
    Pepewitch/tap/wisp-desktop
```

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
brew upgrade --cask wisp-desktop
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
codesign --verify --deep --strict "$app"
open -a Wisp
sleep 4
ps -axo comm= | awk -F/ '$NF == "wisp-desktop" { found=1 } END { exit !found }'
```

## 10. Close out without rewriting history

After public qualification, update the README, install guides, and release
notes with only the facts just observed. Keep raw and machine-specific
evidence outside the public repository. Retain prior passes and failures in
the private project record rather than rewriting them.

The final receipt should name:

- version, tag, full commit, and clean-tree status;
- all nine filenames and SHA-256 values;
- reproducibility result, configured desktop minimum, and actually qualified
  host versions;
- source, install, activation, evaluator, security, Formula/Cask audit/test, and
  anonymous-download results;
- production backup and state-preservation result;
- exact limitations, including signing/notarization and unrun human gates;
- Wisp and tap commit ids plus public release URLs.

If any claim cannot be tied to retained evidence, remove or weaken the claim.
