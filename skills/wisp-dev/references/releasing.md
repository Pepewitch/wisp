# Releasing and publishing Wisp

Use this playbook for a versioned Linux/macOS release, GitHub publication, or
Homebrew tap update. It records the evolving v0.4 process, including the first
signed Desktop publication in alpha.12 and the first public in-app update in
alpha.13. The scripts are authoritative when a command or filename changes.

Publishing a tag, GitHub release, or tap commit changes public state. Do it
only when the owner explicitly authorizes that release. Preparation and local
qualification do not imply permission to publish.

## The short path

One release is two pull requests and the six steps below. Each step's command
stops at the first problem it cannot fix and names the command that fixes it;
when it passes, move to the next step. Do not skip a failed gate, and do not
invent extra ones — everything after this section explains what the commands
enforce and is the manual fallback when one of them fails.

A fetch that fails with `would clobber existing tag` means your copy of the
tag it names is not the one on origin. For a `v*` tag, origin's is the
published one: replace yours with
`git fetch --force origin refs/tags/<tag>:refs/tags/<tag>` and run the command
again. `release:closeout` does this itself for the tag it records.

### 1. Prepare the release branch

```sh
version=0.0.0                        # an unused regular version, or 0.0.0-alpha.N
git fetch origin --tags
git switch -c "release/$version" origin/main
bun install --frozen-lockfile
bun run version:set "$version"       # writes every version site; refuses a bad version
bun run release:notes "$version"     # scaffolds the notes, and the ledger of a new minor line
```

Then do the judgment work the scaffolds cannot:

- Edit every `TODO` in `docs/v<major>.<minor>/RELEASE-NOTES-<version>.md`:
  the summary paragraph, what each change means for a user, and the limits
  specific to this release. The notes become an immutable release body, so
  `docs:check` refuses a leftover `TODO` rather than letting it ship.
- A new minor line also starts `docs/v<major>.<minor>/QUALIFICATION.md`,
  marked prepared until the closeout. Read its introduction.
- If `main` moved since the branch was taken, `git rebase origin/main` and
  make sure the notes cover what landed. A change that lands after the tag
  is pushed belongs to the next release.

Commit the release preparation before moving on.

### 2. Gate the branch

```sh
bun run release:check "$version"
```

It refuses the mistakes that are expensive once a tag exists — a reused or
non-newer version, a branch behind `origin/main`, unfinished `TODO`s, an
install document that still names the previous release — then runs the source
gates cheapest first: whitespace, brand assets, the evaluator suite,
`bun run check` (docs, version pins, workflow pins, lint, types, all tests),
the smoke test, and a full build. Each gate logs to
`dist/release-check/<gate>.log`; only a failing gate's tail is printed.

The brand gate rasterizes the PNG assets with headless Chrome, and no CI job
renders them, so `release:check` decides: when nothing the PNGs are drawn from
changed since the previous tag (the `scripts/brand/` geometry, the assets
themselves, the desktop icons, the Geist font package), it skips the render
and still verifies every other asset. When an input did change, the render
runs (a few seconds) and must pass; it compares pixels, so Chrome encoding
the same image differently is not a failure. If it reports a PNG `STALE`, a
change since the previous release altered what the PNGs show without
regenerating them. That is a bug on `main`, not part of the release: stop and
report it, so the fix (`bun run brand`, with the new images reviewed) lands
in its own PR before the release. Never ship re-rendered PNGs no gate has
checked.

The installer and activation contracts (`test:install`, `test:activation`)
need a container runtime and are not run here; the release-candidate workflow
runs them on the exact `main` commit, and step 4 requires them. When a change
touches the release contract, keep failure-path diagnostics (the daemon's wait
status and cgroup memory/pid counters) in the same PR as the change.

A gate that fails in code this release did not change is a flake: run
`release:check` once more. If the same gate fails twice, stop and report it —
rerunning until it passes is how a real regression ships.

### 3. Land the release PR

Open the PR (title it `release: prepare <version>`; the body says what the
release ships and what the validation evidence was), wait for its checks, and
land it with a squash so the release commit is one commit carrying one
synchronized version:

```sh
gh pr merge <number> --squash --delete-branch
```

### 4. Tag the green commit

```sh
bun run release:ready "$version"
```

It finds the commit on `origin/main` that set the version, waits for that
commit's `test`, `browser-security`, `supply-chain`, `linux-contract`, and
`update-verifier` checks, and prints two commands: the annotated tag for
exactly that commit, and the push. Tagging a named commit means a change that
lands on `main` in the meantime ships in the next release, and no local state
can leak into a release.

The push is the only irreversible step and is the explicit publish
authorization; nothing before it publishes anything. A failed check gets one
rerun (`release:ready` prints the command); a check that fails again after its
rerun is a real failure — stop and report it instead of rerunning until it
passes. The tag workflow independently refuses a tag whose commit lacks the
`linux-contract` and `update-verifier` results.

### 5. Watch the publication

`.github/workflows/release.yml` builds, signs, notarizes, publishes the
immutable release, and promotes the tap — about ten minutes to the GitHub
release, with promotion following as a separate job:

```sh
run=""
until [ -n "$run" ]; do            # the run appears a few seconds after the push
  sleep 5
  run=$(gh run list --workflow release.yml --branch "v$version" --event push --json databaseId --jq '.[0].databaseId')
done
gh run watch "$run" --exit-status --compact --interval 30
```

The watch takes 10–15 minutes, so give the command a 20-minute timeout (or
run it in the background and check back). It exits non-zero if a job fails;
`gh run view "$run" --log-failed` shows why.

If the run fails before the release exists, delete the tag
(`git push origin ":refs/tags/v$version"`), fix, and re-tag: an unpublished
tag is still mutable. If `promote` fails after the release is public, never
rebuild, replace assets, or cut a new version. Rerun the failed job once
(`gh run rerun "$run" --failed`); if it fails again, dispatch the recovery,
which runs the current promotion code from `main` against the immutable tag:

```sh
gh workflow run release.yml --ref main -f tag="v$version"
```

### 6. Record the publication

```sh
git switch -c "release/$version-closeout" origin/main
bun run release:closeout "$version"
```

The release notes describe the artifact gates as pending, so the qualification
ledger is where the outcome lands. The closeout reads the release, its
workflow jobs, the promotion receipt, the release PR's checks, and the
migrations itself, verifies anonymously that the tap and both update channels
serve the version, and writes the `## <version> publication` section into
`docs/v<major>.<minor>/QUALIFICATION.md`, demoting the predecessor's claims
that are now false. Whatever still needs judgment is a `TODO` in the entry —
the highlights, why a rerun or recovery happened, a release candidate run it
cannot show passed before the tag, the checks nobody ran — and the command
ends by listing each one as `path:line`. Resolve every one
(`bun run docs:check` refuses leftovers), review the diff, and land the
closeout PR (`docs(release): record <version> publication`) with a squash.
`--dry-run` prints the same edits as a diff and writes nothing, from any
branch.

If it reports that the tap does not serve the version yet, promotion is still
converging: wait a minute and run it again. If it reports that promotion has
not finished, go back to step 5's recovery.

A superseded release keeps its evidence and loses only claims that are now
false, such as "latest". Never copy a prior release's qualification receipts
or claim checks nobody performed; the 0.5.6 record is the example of recording
an automated-only publication honestly.

## Release invariants

- A release is built from one clean commit carrying one synchronized version,
  written by `bun run version:set` and enforced by `bun run version:check`.
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
- Every third-party action is pinned to a commit SHA and every container image
  to a digest, enforced by `bun run workflows:check` in CI. Release jobs reach
  Apple signing material, updater keys, publication rights, and a tap token —
  a mutable upstream tag is an unreviewed dependency of all four (SEC-06). Pin
  the SHA and leave the human-readable version in a trailing comment; bump both
  together, deliberately.
- The advisory gate runs against the whole locked tree, including build-time
  tooling. The unchanged shadcn 4.19.0 stylesheet is vendored with its MIT
  license in `web/src/styles/shadcn.css` and `web/licenses/shadcn-MIT.txt`;
  its component-generator dependency graph was removed. Keep dependency changes separate from a version-only release.
- Top-level workflow permissions stay `contents: read`. A job that needs more
  declares it next to the step that uses it, so a job added later cannot
  inherit publication rights by existing.
- Wisp and its Homebrew tap are separate repositories. Review, commit, and
  publish each one independently.

Current distribution targets are Ubuntu 24.04 LTS x86_64/glibc, an
experimental Apple Silicon arm64 daemon archive, and an Apple Silicon desktop
`.app` configured for macOS 12.3 or newer. Ubuntu 24.04 is the gated and
qualified Linux target, not the range the binary runs on: README.md and
`docs/INSTALL.md` state a separate glibc floor, `MINIMUM_GLIBC` in
`wispd/scripts/release-linux.ts` owns that number, and both CI and the release
build re-derive it from the artifact. A Bun upgrade that raises the floor
fails there — update the constant and both documents rather than the gate.
`wispd/scripts/release-macos.ts` keeps the reproducibility daemon archive
ad-hoc signed. Local and reproducibility Desktop builds are also ad-hoc.
Publishable macOS artifacts must use their `--signed` paths: both require a
Developer ID Application signature, trusted timestamp, hardened runtime, and
notarization and staple; the branded background daemon app fixes its identifier
at `dev.wisp.daemon`, while Desktop additionally requires a separate updater
signature.

## Automated publishing on tag push

`.github/workflows/release.yml` automates the publish steps below. The
maintainer's push of the annotated `v<version>` tag is the explicit publish
authorization. One repository-wide concurrency group serializes releases so
two tags cannot race to advance the Homebrew or Desktop channels. The
credential-free source gate runs first; all expensive platform work then fans
out:

1. `release-source` requires the tag to point at `origin/main`, requires that
   exact commit's pre-tag `linux-contract` and `update-verifier` success, scans
   full history with Gitleaks, and builds the canonical UI twice.
2. `release-linux`, two clean `macos-repro` matrix runners, and
   `macos-trusted` run concurrently. Linux still reproduces its asset and
   repeats the installer/activation journey. The two independent Mac runners
   build byte-identical ad-hoc daemon/Desktop payloads without target caches.
   The credential-isolated trusted runner builds, Developer ID signs,
   notarizes, and staples the public daemon app, then signs, notarizes, staples,
   updater-signs, and negatively tests the public Desktop archive. It also transfers the
   already-built verifier with its checksum.
3. `publish` receives those outputs, compares the two independent Mac payloads,
   verifies all ten checksum-bound assets and the updater signature, renders
   and audits both Homebrew recipes plus both update channels offline, creates
   the "Wisp <version>" GitHub release, and verifies all ten anonymous public
   downloads and both macOS trust chains. It has publication rights but no
   Apple or Homebrew write credential. This is the immutable boundary.
4. `promote` starts on a fresh arm64 macOS runner after `publish`. It downloads
   and verifies the public assets again, reuses the checksummed verifier during
   a normal tag run, audits the Formula, Cask, Desktop channel, and daemon
   channel in an isolated Homebrew tap, pushes exactly those four files, waits
   for both fixed URLs to converge, then requires the full livecheck audit. A
   manual recovery still builds the verifier from the immutable tag source.

The performance target is **under ten minutes from tag push to immutable
GitHub release** when GitHub-hosted runners and Apple notarization respond
normally. Promotion follows as a separate resumable operation and may finish
later. This is a target, not a weakened timeout: runner queues, GitHub asset
availability, and Apple's service can vary, and every trust gate remains
fail-closed.

Promotion is deliberately a separate job. If it fails after the immutable
GitHub release exists, rerun only the failed `promote` job. The workflow also
has a manual recovery input for an existing tag:

```sh
gh workflow run release.yml --ref main -f tag="v$version"
```

Manual dispatch skips compilation, Apple signing, notarization, and GitHub
release creation. It requires `--ref main` and runs the current promotion
implementation from `main` against a separate immutable checkout of the
requested tag.
This allows a promotion bug to be fixed on `main` without changing the release
source or public assets.

Pull requests that change the promotion command, renderers, Homebrew/channel
tests, or release workflow also trigger `.github/workflows/release-promotion.yml`.
Its disposable macOS runner anonymously replays whichever release the tap
currently serves, including all ten downloads, updater and Apple trust checks,
actual Homebrew audits, exact-channel comparison, and safe temporary-tap
cleanup. It records a dry-run receipt and has no tap write credential or
`--publish` capability.

`scripts/promotion-fixture.ts` reads that fixture out of the cloned tap, so no
release version is written down in the workflow and there is nothing to advance
after a promotion. Because the fixture is by definition the release the tap
already serves, re-rendering it must reproduce the tap byte for byte; the job
asserts `tapState=already-promoted` and so fails on any change that would
rewrite already-published tap files. If a file is added to `TAP_FILES` but no
release has been promoted with it yet, the fixture resolver fails with the
missing paths named: a channel clients are told to poll is unpublished, and
promoting a release is what clears it.

The workflow needs these repository secrets:

- `HOMEBREW_TAP_TOKEN`: fine-grained token with Contents write access to the
  tap, exposed only to the promotion job;
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
trust check is absent. Immutable publication clones the public tap without the
write token; only promotion receives it. The workflow never writes back to this
repository — assets attach to the GitHub release
and the Formula/Cask commit lands in the tap repository — so publishing cannot
re-trigger this repository's CI. No release assets are public until the
`publish` job runs, so a failed Linux-side gate cannot half-publish a release.

Preparation (steps 1-3, landed on `main` as the release preparation PR), the
external evaluator panel, the exact-credential scan of step 5, local
qualification in step 9, and the step 10 close-out records remain private
maintainer records.
Steps 4-8 below remain the manual fallback and the source of the automated
gates. If the workflow fails before the release is created, delete the tag,
fix, and re-tag: an unpublished tag is still mutable. Once assets are public,
never mutate them and do not create a new version merely because channel
promotion failed. Rerun the promotion job or manually dispatch the existing
tag after fixing the promotion implementation on `main`.

## 1. Prepare a release branch

Start from a fresh `origin/main` worktree and install the locked dependencies:

```sh
version=0.0.0 # replace with an unused regular version, or 0.0.0-alpha.N
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
notes="$(RELEASE_TAG="$tag" bun -e '
  import { releaseNotesPath } from "./scripts/release-promotion";
  console.log(releaseNotesPath(process.cwd(), process.env.RELEASE_TAG));
')"
tap="$(brew --repository Pepewitch/tap)"
```

The low-level manual fallback requires `Pepewitch/tap` to be Homebrew's
registered, clean tap checkout so name-based Formula and Cask audits resolve
the files just rendered. Run that fallback only on a disposable Mac with no
installed `wisp` Formula or `wisp-desktop` Cask. Never create a colliding audit
tap on an operator machine: Homebrew can associate cleanup with the installed
token and remove the working application. The preferred promotion command
accepts a separate clean tap clone, creates its audit tap only after proving
the host is disposable, removes the copied definitions before untapping, and
refuses unsafe hosts.

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

The version lives in `wispd/package.json`. Every other file that repeats it is
listed once in `scripts/release-versions.ts`, and one command writes them all:

```sh
bun run version:set "$version"
```

Do not edit those files by hand. `bun run version:check` reads each one back
independently and fails if any disagrees, if a file changed shape so its
pattern no longer matches, or if the site count moved — it runs inside
`bun run check`, so a half-applied bump cannot reach a release branch. When a
new file starts repeating the version, add it to the table and raise
`EXPECTED_SITE_COUNT`; the tests in `tests/release-versions.test.ts` prove the
gate still refuses each way a bump can go wrong.

`version:set` also refuses anything the pipeline could not tag later, so a
version like `0.5.2-beta` fails before nine files are rewritten rather than at
`git tag`.

Then write the parts that need judgment:

```sh
bun run release:notes "$version"
```

That scaffolds `docs/v<major>.<minor>/RELEASE-NOTES-<version>.md` with the
required sections, the exact ten-asset list, install commands already carrying
the new version, and one bullet per pull request merged since the previous tag.
The first release of a minor line also starts
`docs/v<major>.<minor>/QUALIFICATION.md`, introduced as prepared until the
closeout turns it into the publication record.
Every judgment call is a `TODO` marker: the summary paragraph, what each change
means for a user, any database migration and which older daemon can no longer
reopen the profile, and the limits specific to this release. Edit all of them —
the notes become an immutable release body.

Finally, update the prose that names the current release: the headline and
install commands in `README.md`, `docs/INSTALL.md`, and `docs/INSTALL-MACOS.md`.
The pinned installer URLs in README and the Linux guide are version sites, so
`version:check` refuses a release that forgets them; any remaining prose that
names the release is updated by judgment.
Do not rewrite published release notes or a past release's qualification record
merely to make an old version look current; a superseded release keeps its
evidence and loses only claims that are now false, such as "latest".
`web/package.json` has its own workspace version and is not a Wisp release
pin.

Stable tags use `v<major>.<minor>.<patch>` and notes at
`docs/v<major>.<minor>/RELEASE-NOTES-<version>.md`. Alpha tags retain their
historical `RELEASE-NOTES-alpha.N.md` paths. The workflow publishes stable tags
as regular latest releases and alpha tags as prereleases. Promotion verifies
the matching GitHub status. Preserve the legacy Desktop alpha endpoint and
wire channel so installed clients can discover stable releases.

Write release notes before tagging. State platform scope, signing posture,
install/upgrade commands, changes, known limits, and the exact ten expected
assets. Before public verification, describe unrun gates as pending.

## 3. Run the source gates

The short path runs all of these through `bun run release:check`, which adds
the release-branch preconditions and the PNG-render decision on top. Run the
complete repository gate and the release-specific checks. `bun run
check` includes `version:check`, so a partially applied version bump fails
here:

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
exact bytes rather than silently regenerate them. First build both Mac
artifacts without release credentials; this is the reproducible payload proof,
not either public Mac artifact:

```sh
bun run build:ui
bun run wispd/scripts/release-linux.ts --require-tag
bun run wispd/scripts/release-macos.ts --require-tag
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

At the reproducibility stage the signature file is absent and both Mac
manifests truthfully record ad-hoc builds. Snapshot those nine files, rebuild
from the same clean tag, and compare every byte:

```sh
first="$(mktemp -d)"
cp "$release_dir"/* "$first/"
bun run wispd/scripts/release-linux.ts --require-tag
bun run wispd/scripts/release-macos.ts --require-tag
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
build the two public Mac archives:

```sh
bun run wispd/scripts/release-macos.ts --require-tag --signed
WISP_PREBUILT_UI=1 CARGO_TARGET_DIR="$(mktemp -d)" \
  bun run scripts/release-desktop.ts --require-tag --signed
```

On a maintainer Mac, `APPLE_SIGNING_IDENTITY` must already be available in an
unlocked Keychain. CI imports `APPLE_CERTIFICATE` with
`APPLE_CERTIFICATE_PASSWORD` into a temporary Keychain before invoking either
signed release script. The notarization API key is required for both artifacts;
the Tauri updater key is additionally required for Desktop.

Timestamped Apple signatures are intentionally not byte-reproducible. Neither
signed pass is compared with its ad-hoc payload. The daemon release script
requires its fixed code-signing identifier and stable non-`cdhash` designated
requirement, submits the exact signed background app to Apple's notary service,
staples it, then re-extracts the archive and repeats identity, icon, and trust
checks. The Desktop release
script verifies Developer ID identity, timestamp, hardened runtime,
notarization, and staple; archives the app; updater-signs that exact archive;
verifies the signature with an independent streaming verifier; re-extracts the
archive; and repeats the Apple trust checks. Both manifests and checksum sets
bind their public trust posture.

The builders refuse a dirty tree or a `wispd/package.json`/`wispd/src/version.ts`
mismatch. The Mac daemon builder also verifies arm64 architecture, the expected
ad-hoc or Developer ID posture, background-app metadata and icon, archive
contents, and embedded version/commit identity.
The Desktop builder additionally verifies the Cargo/Tauri/plist/binary version,
Mach-O deployment minimum, exact bundle inventory, absence of builder paths,
and a clean source tree after packaging. Tag CI builds and reproduces the UI on
Linux, transfers it with a checksum, and sets `WISP_PREBUILT_UI=1` for all
three parallel Desktop builds so the daemon and application package one
canonical bundle. CI's two reproducibility copies run on independent clean
macOS hosts with target caching disabled; publication compares their six
outputs before accepting the separate trusted archives. For the sequential
manual fallback above, Apple's linker changes the required Mach-O UUID when
Cargo's absolute target path changes, so keep one `CARGO_TARGET_DIR` and run
`cargo clean` between the two builds.

Exercise the Linux artifact through the public installer contract and the
fake-model evaluator before spending model quota:

```sh
bun run test:install
bun run test:activation
wispd/scripts/evaluator/run.sh --preflight --rebuild-image
```

Run the paid evaluator panel only when the release scope requires it. Follow
[`wispd/scripts/evaluator/README.md`](../../../wispd/scripts/evaluator/README.md): use a
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
automatic `.env` and `bunfig` loading in `wispd/scripts/build-binary.ts`; keep that
boundary.

## 6. Publish the GitHub release

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
bun run scripts/render-daemon-update-channel.ts \
  --manifest "$release_dir/release-manifest.json" \
  --desktop-manifest "$release_dir/release-manifest-desktop-darwin-arm64.json" \
  --output "$tap/updates/wisp-daemon.json"
bun test tests/homebrew-formula.test.ts tests/homebrew-cask.test.ts \
  tests/desktop-update-channel.test.ts tests/daemon-update-channel.test.ts
brew style "$tap/Formula/wisp.rb" "$tap/Casks/wisp-desktop.rb"
brew audit --strict Pepewitch/tap/wisp
brew audit --strict --cask Pepewitch/tap/wisp-desktop
```

Normally push the tag and let the workflow create the release. Do not race it
with a manual `gh release create`. The following is a manual fallback only
when automated publication is disabled and all the same gates have passed;
set the release flags according to the validated version:

```sh
gh auth status
gh repo view Pepewitch/wisp --json visibility,url
git push origin "$tag"
case "$version" in
  *-alpha.*) set -- --prerelease --latest=false ;;
  *) set -- --latest=true ;;
esac

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
  "$@" \
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
daemon_extracted="$(mktemp -d)"
tar -xzf "$anon/wisp-v$version-darwin-arm64.tar.gz" -C "$daemon_extracted"
# The archive nests the bundle under one versioned directory. Homebrew descends
# into a lone top-level directory before `install` runs, so a bundle sitting at
# the archive root leaves the Formula standing inside it; 0.5.14 shipped that
# layout and could not be installed.
test "$(ls -A "$daemon_extracted")" = "wisp-v$version-darwin-arm64"
daemon_app="$daemon_extracted/wisp-v$version-darwin-arm64/Wisp Daemon.app"
daemon="$daemon_app/Contents/MacOS/wisp"
codesign --verify --deep --strict --verbose=2 "$daemon_app"
codesign --display --requirements - "$daemon" 2>&1 | \
  grep -F 'identifier "dev.wisp.daemon"'
xcrun stapler validate "$daemon_app"
spctl --assess --type execute --verbose=4 "$daemon_app"
cargo run --quiet --locked \
  --manifest-path scripts/update-verifier/Cargo.toml \
  --bin verify-update-signature \
  -- \
  "$anon/wisp-desktop-v$version-darwin-arm64.tar.gz" \
  "$anon/wisp-desktop-v$version-darwin-arm64.tar.gz.sig" \
  desktop/src-tauri/updater-public.key
tampered="$(mktemp)"
cp "$anon/wisp-desktop-v$version-darwin-arm64.tar.gz" "$tampered"
printf 'tampered' >> "$tampered"
if cargo run --quiet --locked \
  --manifest-path scripts/update-verifier/Cargo.toml \
  --bin verify-update-signature \
  -- \
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

Once the Mac assets are public, promotion is a resumable operation. Prefer the
manual recovery dispatch when the automatic `promote` job did not complete:

```sh
gh workflow run release.yml --ref main -f tag="$tag"
gh run list --workflow release.yml --limit 5
```

The dispatch uses the current promotion implementation but checks the release
identity, notes, updater key, and manifests out from the immutable tag. It
downloads all ten assets anonymously, repeats checksum, updater-signature,
tamper-rejection, Developer ID, notarization, staple, and Gatekeeper checks,
then advances the tap. If the tap and channel already contain the exact
generated bytes, it performs final verification without creating another
commit.

The same implementation is available on a disposable Apple Silicon Mac for a
dry run or an explicitly authorized manual promotion:

```sh
promotion_tap="$(mktemp -d)/homebrew-tap"
git clone https://github.com/Pepewitch/homebrew-tap.git "$promotion_tap"
bun run release:promote -- \
  --tag "$tag" \
  --tap-dir "$promotion_tap"

# Use a fresh clean tap clone after inspecting a dry run.
promotion_tap="$(mktemp -d)/homebrew-tap"
git clone https://github.com/Pepewitch/homebrew-tap.git "$promotion_tap"
bun run release:promote -- \
  --tag "$tag" \
  --tap-dir "$promotion_tap" \
  --publish
```

The command refuses a non-arm64 host, an installed Wisp Formula/Cask, a
registered `Pepewitch/tap`, a non-annotated or non-main tag, any public asset
inventory other than the exact ten files, mismatched manifest identities, a
dirty or stale tap checkout, or changes outside the exact four promotion
files. `--publish` is a separate explicit capability; omitting it never pushes.

The following low-level sequence documents the gates owned by that command.
Use it only on the disposable fallback host described above. Repeat the
prepared recipe audits online and synchronize the four files in one tap
commit:

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
bun run scripts/render-daemon-update-channel.ts \
  --manifest "$release_dir/release-manifest.json" \
  --desktop-manifest "$release_dir/release-manifest-desktop-darwin-arm64.json" \
  --output "$tap/updates/wisp-daemon.json"
bun test tests/homebrew-formula.test.ts tests/homebrew-cask.test.ts \
  tests/desktop-update-channel.test.ts tests/daemon-update-channel.test.ts
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
    --except github_prerelease_version,livecheck_version,livecheck_https_availability \
    Pepewitch/tap/wisp-desktop
git -C "$tap" diff --check
git -C "$tap" diff -- Formula/wisp.rb Casks/wisp-desktop.rb \
  updates/wisp-daemon.json updates/wisp-desktop-alpha.json
```

The Formula and Cask must pin immutable GitHub URLs and SHA-256 values and
contain no credential. The Formula keeps daemon state outside Homebrew's prefix
and exposes the launchd service. The Cask installs the signed and notarized
`Wisp.app`, depends on the Formula, declares `auto_updates true`, uses the alpha
channel for livecheck, and states that uninstall preserves Desktop metadata and
Keychain credentials unless the user removes connections or resets Desktop
data first. The channel must name the same archive and updater signature bound
by the release manifest.

`github_prerelease_version` remains an audit exception to permit promotion
recovery for historical custom-tap alphas. `livecheck_version` and `livecheck_https_availability` are
deferred only before channel promotion, because both invoke the circular
version comparison while the staged Cask is necessarily newer than the
still-public channel. The post-push audit restores both. Do not exclude
Homebrew's signing or Gatekeeper checks.

Commit and push the tap only with explicit authorization:

```sh
git -C "$tap" add Formula/wisp.rb Casks/wisp-desktop.rb \
  updates/wisp-daemon.json updates/wisp-desktop-alpha.json
git -C "$tap" diff --cached --check
git -C "$tap" diff --cached -- Formula/wisp.rb Casks/wisp-desktop.rb \
  updates/wisp-daemon.json updates/wisp-desktop-alpha.json
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
brew install Pepewitch/tap/wisp Pepewitch/tap/wisp-desktop
wisp init
brew services start wisp
wisp doctor --harness droid
brew test Pepewitch/tap/wisp
open -a Wisp
```

Use fully qualified names everywhere. A fresh Mac has an empty Homebrew trust
store, and Homebrew trusts only the names it is given, never their
dependencies: `brew install --cask Pepewitch/tap/wisp-desktop` alone stops with
`Refusing to load formula pepewitch/tap/wisp from untrusted tap`. A machine
that trusted these items in an earlier release cannot reproduce that failure,
so read `brew trust` before believing a fresh-install result from it.

For an existing installation:

```sh
brew update
brew upgrade Pepewitch/tap/wisp
brew upgrade --cask --greedy Pepewitch/tap/wisp-desktop
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
notes with only the facts just observed, and add the sanitized two-version
result to `docs/v0.4/QUALIFICATION.md`. Keep raw and machine-specific evidence
outside the public repository. Retain prior passes and failures in the private
project record rather than rewriting them. A source-document closeout does not
authorize editing the already-published GitHub release body or replacing an
asset.

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
