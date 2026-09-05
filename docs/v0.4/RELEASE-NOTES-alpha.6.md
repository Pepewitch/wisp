# Wisp 0.4.0-alpha.6

This is an **experimental maintenance prerelease**, not a production-ready
release. It packages the linked pull-request status work, its batched sidebar
view, and durable native steering from `main`. Alpha.3 remains the v0.4
machine-qualification baseline; the paid three-model panel was not rerun for
alpha.6.

## Platform scope

- Ubuntu 24.04 LTS, x86_64, glibc. Alpha.3 passed the final three-model
  activation panel; alpha.6 runs the source, installer, activation, and
  release artifact gates.
- Apple Silicon arm64, with limited single-machine Homebrew testing.
- Intel Macs are unsupported and have no artifact.

This is the first Wisp release built and published by GitHub Actions from the
`v0.4.0-alpha.6` tag. The binaries are
compiled by the release workflow on GitHub's `ubuntu-latest` and arm64
`macos-latest` runners with the pinned Bun 1.3.14, and the workflow proves
each platform's assets reproduce byte for byte on a clean rebuild before
publishing. Additional machine qualification is pending; this does not imply
human validation or production support.

The Mac binary is **ad-hoc signed, not Developer ID signed or notarized**.
Gatekeeper may require explicit approval. Do not disable Gatekeeper globally.

## Install

Linux:

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.4.0-alpha.6/scripts/install.sh |
  sh
```

Apple Silicon:

```sh
brew install Pepewitch/tap/wisp
wisp init
brew services start wisp
```

Existing Homebrew users upgrade with:

```sh
brew update
brew upgrade wisp
brew services restart wisp
```

## Changes since alpha.5

- discovers origin GitHub pull requests linked to task branches and exposes
  their lifecycle, CI, review, and policy-aware merge-readiness state,
  replacing duplicate push controls with a linked-PR indicator whose icon
  colors from GitHub's merge state;
- adds glanceable, batched pull-request status to the sidebar;
- makes steering durable: queued submissions persist before delivery, admit
  safely into live Claude, Droid, and Codex turns through bounded protocol
  operations, and uncertain at-least-once recovery is surfaced across the
  API, CLI, and UI; and
- aligns the slash palette and usage semantics.

## Known limits

- This release has no new paid evaluator panel or broad human usability result.
- Apple Silicon support remains experimental and narrowly tested.
- The Mac artifact is arm64-only, ad-hoc signed, and not notarized.
- The two-week reliability, complete upgrade matrix, signing, and outside-human
  acceptance gates remain future work.

## Release assets

- `wisp-v0.4.0-alpha.6-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.4.0-alpha.6-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
