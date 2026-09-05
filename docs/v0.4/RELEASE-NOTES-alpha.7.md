# Wisp 0.4.0-alpha.7

This is an **experimental maintenance prerelease**, not a production-ready
release. It packages managed updates, project removal, refreshed harness
contracts, harness drift detection, and safer native steering from `main`.
Alpha.3 remains the v0.4 machine-qualification baseline; the paid three-model
panel has not been rerun for alpha.7.

## Platform scope

- Ubuntu 24.04 LTS, x86_64, glibc. Alpha.3 passed the final three-model
  activation panel; alpha.7 source, installer, activation, and release
  artifact gates are pending.
- Apple Silicon arm64, with limited single-machine Homebrew testing.
- Intel Macs are unsupported and have no artifact.

The Mac binary is **ad-hoc signed, not Developer ID signed or notarized**.
Gatekeeper may require explicit approval. Do not disable Gatekeeper globally.

## Install

Linux:

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/Pepewitch/wisp/v0.4.0-alpha.7/scripts/install.sh |
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

## Changes since alpha.6

- adds managed update discovery and activation for installer-managed Linux
  services and Homebrew-managed Apple Silicon services;
- adds project removal through the web settings dialog;
- refreshes Codex and Droid harness contracts and adds commands that detect
  and snapshot upstream harness contract drift;
- exposes daemon identity and protocol capabilities to clients;
- makes live steering safer by bounding oversized protocol frames and tool
  results, and by placing mid-turn steering only where the harness accepts it;
  and
- improves nested harness activity rendering and preserves structured activity
  across realtime stream recovery.

## Known limits

- Release qualification is pending until the tag-driven source, installer,
  activation, reproducibility, security, Formula, and anonymous-download gates
  pass.
- This release has no new paid evaluator panel or broad human usability result.
- Apple Silicon support remains experimental and narrowly tested.
- The Mac artifact is arm64-only, ad-hoc signed, and not notarized.
- The two-week reliability, complete upgrade matrix, signing, and outside-human
  acceptance gates remain future work.

## Release assets

- `wisp-v0.4.0-alpha.7-linux-x86_64`
- `release-manifest.json`
- `SHA256SUMS`
- `wisp-v0.4.0-alpha.7-darwin-arm64.tar.gz`
- `release-manifest-darwin-arm64.json`
- `SHA256SUMS-darwin-arm64`
