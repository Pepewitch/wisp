# Wisp 0.7 qualification

This ledger separates release evidence from the version label. The 0.7 releases
are regular pre-1.0 releases, not a claim of exhaustive security or platform
coverage. 0.7.2 was the last 0.7 release; 0.8.0 supersedes it, and its record
is in [the 0.8 ledger](../v0.8/QUALIFICATION.md). Earlier 0.7 records are
retained below. The 0.6 records remain in
[the 0.6 ledger](../v0.6/QUALIFICATION.md).

The tested limits, remaining platform gaps and native dependency advisory scope
recorded for 0.5 under
[Still unqualified or outside scope](../v0.5/QUALIFICATION.md#still-unqualified-or-outside-scope)
still apply to 0.7.2.

## 0.7.2 publication

**Published and promoted on 2026-10-26.**
[Wisp 0.7.2](https://github.com/Pepewitch/wisp/releases/tag/v0.7.2) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 04:00:40 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`bd4d12655a52f3c0672334c230b6725a59f5728e`](https://github.com/Pepewitch/wisp/commit/bd4d12655a52f3c0672334c230b6725a59f5728e),
landed through [PR #424](https://github.com/Pepewitch/wisp/pull/424). It carries
subtasks, on by default: a task can start explore, review and continue
subtasks, hear their turn, stuck, setup-failed and PR reports, and archive them
as one family
([#414](https://github.com/Pepewitch/wisp/pull/414),
[#417](https://github.com/Pepewitch/wisp/pull/417),
[#418](https://github.com/Pepewitch/wisp/pull/418)); `wisp new` from inside a
task now creates a task for the project's checkout
([#413](https://github.com/Pepewitch/wisp/pull/413)); and the other changes
listed in the release notes since 0.7.1.

Two earlier pushes of the tag never published. On release commit `6719b1c` and
then `a927103`, `macos-trusted` failed before the `publish` job ran, because a
request to Apple's CloudKit ticket service dropped
(`NSURLErrorDomain -1005`, stapler Error 68). The first push failed during
`stapler validate`, twice. The second failed after Tauri ignored a failed
`stapler staple` and left Desktop without a ticket, which the inventory check
refused. [#423](https://github.com/Pepewitch/wisp/pull/423) retries
`stapler validate` on a dropped connection, and
[#424](https://github.com/Pepewitch/wisp/pull/424) staples Desktop again when
its ticket is missing and retries `stapler staple`. Each unpublished tag was
deleted and the tag was recreated on the fixed commit. In the publishing run,
one staple and one validate each dropped once and passed on the retry, and the
Desktop re-staple ran.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/40266138076)
for the published tag completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/40265949786) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `bd4d126` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 04:03:10 UTC with Homebrew tap commit
[`666f77a89bf603ad57648cb8b425a7a724e6a608`](https://github.com/Pepewitch/homebrew-tap/commit/666f77a89bf603ad57648cb8b425a7a724e6a608).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.7.2 until 0.8.0 was promoted.

0.7.2 adds database migration 26, so a 0.7.1 daemon cannot reopen a profile that
0.7.2 has opened. No PNG asset or brand-generator input changed since 0.7.1, so
the PNG assets were not re-rendered. This is a fully automated publication: no
maintainer qualification — fresh-install or upgrade receipts, a Desktop updater
journey across this version, the token-spending harness probes, or the paid
evaluator panel — was performed, and this record does not claim them. The
published assets and release body remain immutable; this ledger records the
completed outcome separately.

Nobody ran subtasks, this release's headline change, against the published
daemon. They were verified only by the four pull requests' auto-review rounds,
on throwaway daemons built from source.

## 0.7.1 publication

**Published and promoted on 2026-10-21.**
[Wisp 0.7.1](https://github.com/Pepewitch/wisp/releases/tag/v0.7.1) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 03:32:29 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`6256260aaa0f090505d00baecdb0486b65d49f4f`](https://github.com/Pepewitch/wisp/commit/6256260aaa0f090505d00baecdb0486b65d49f4f),
landed through [PR #409](https://github.com/Pepewitch/wisp/pull/409). It carries
the removal of task briefs
([#402](https://github.com/Pepewitch/wisp/pull/402)); autopilot resuming a
task after the network drops instead of leaving it failed
([#403](https://github.com/Pepewitch/wisp/pull/403)); auto-review armed when a
task is created with it ([#395](https://github.com/Pepewitch/wisp/pull/395));
and the Desktop `rustls` 0.23.46 lock
([#408](https://github.com/Pepewitch/wisp/pull/408)), with the other changes
listed in the release notes since 0.7.0.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/39538319438)
completed every job successfully on attempt 2. Attempt 1 built, signed,
notarized and published the release; its `promote` job then failed at
`xcrun stapler validate` of the downloaded daemon app, which lost its network
connection to Apple's CloudKit ticket service (Error 68), after the same step
had already verified the Desktop app's staple and Gatekeeper assessment.
Nothing had been promoted, and promotion only reads the immutable public
release, so rerunning the failed job alone was safe; attempt 2's `promote`
passed every check:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/39538085824) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `6256260` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 03:36:14 UTC with Homebrew tap commit
[`e22a6ac0d334ccf3c7f52fdb0a3469ed9c32f5e1`](https://github.com/Pepewitch/homebrew-tap/commit/e22a6ac0d334ccf3c7f52fdb0a3469ed9c32f5e1).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.7.1 until 0.7.2 was promoted.

0.7.1 adds no database migration. No PNG asset or brand-generator input changed
since 0.7.0, so the PNG assets were not re-rendered. This is a fully automated
publication: no maintainer qualification — fresh-install or upgrade receipts, a
Desktop updater journey across this version, the token-spending harness probes,
or the paid evaluator panel — was performed, and this record does not claim
them. The published assets and release body remain immutable; this ledger
records the completed outcome separately.

Nobody ran this release's headline changes against the published daemon
either: no network drop was staged to watch a task resume, and no task was
created with auto-review on to watch it arm. Both rest on the automated tests
and on the auto-review rounds of their pull requests.

## 0.7.0 publication

**Published and promoted on 2026-10-15.**
[Wisp 0.7.0](https://github.com/Pepewitch/wisp/releases/tag/v0.7.0) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 13:20:51 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`ad05a761608a966671dd27938a57dca3d9e1a64f`](https://github.com/Pepewitch/wisp/commit/ad05a761608a966671dd27938a57dca3d9e1a64f),
landed through [PR #386](https://github.com/Pepewitch/wisp/pull/386). It carries
auto-review, independent reviewer agents that check every pull request head
before it can merge ([#382](https://github.com/Pepewitch/wisp/pull/382),
[#383](https://github.com/Pepewitch/wisp/pull/383)); verification recipes, kept
in Wisp per project, that tell reviewers how to build, launch and drive the app
([#382](https://github.com/Pepewitch/wisp/pull/382)); and `wisp capture`,
screenshots Wisp takes itself in its own headless Chrome
([#385](https://github.com/Pepewitch/wisp/pull/385)). It also carries the
Desktop `quinn-proto` 0.11.19 lock for RUSTSEC-2026-0340 and RUSTSEC-2026-0343
([#387](https://github.com/Pepewitch/wisp/pull/387)) and the other changes
listed in the release notes since 0.6.9.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/38739982988)
published the release on attempt 2. Attempt 1 failed in `macos-trusted` at
"build, sign, and notarize the trusted macOS releases": `xcrun stapler staple`
lost its network connection to Apple's CloudKit ticket service while stapling
the daemon app. `publish` and `promote` never ran, so nothing was public and the
tag was untouched; rerunning the failed jobs rebuilt and re-signed the trusted
payload from the same annotated tag, and attempt 2's `publish` passed every gate
before publication, including that no release for the tag existed yet. Its
`publish` job then failed after publication: "verify anonymous public downloads"
failed and "install the published Formula the way a user does" was skipped. The
failure was the same lost connection to Apple's CloudKit ticket service, this
time during `xcrun stapler validate` of the downloaded daemon app, and not a
defect in the bytes: before it, the step had downloaded all ten public assets,
found them identical to the verified ones and to all three checksum sets, and
verified the daemon app's Developer ID signature and designated requirement. The
release was already public and immutable, so promoting it through the documented
recovery was safe. Promotion, which that failure skipped, finished in a separate
[recovery run](https://github.com/Pepewitch/wisp/actions/runs/38742078815). The
gates before publication passed; the post-publication checks did not:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/38739581155) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets before publication; the release workflow's check of the anonymous public downloads of clean tagged commit `ad05a76` failed after publication, so this record does not claim it |
| Homebrew installability | The Formula and Cask were audited offline before publication; the release workflow's install of the published Formula the way a user does was skipped after publication, so this record does not claim it |

Promotion completed at 13:24:01 UTC with Homebrew tap commit
[`3ec47ae2a6af636d64627303907cfcd3411bd4bd`](https://github.com/Pepewitch/homebrew-tap/commit/3ec47ae2a6af636d64627303907cfcd3411bd4bd).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.7.0 until 0.7.1 was promoted.

0.7.0 adds database migrations 23, 24, and 25, so a 0.6.9 daemon cannot reopen a
profile that 0.7.0 has opened. No PNG asset or brand-generator input changed
since 0.6.9, so the PNG assets were not re-rendered. Apart from the manual
re-verification below, no maintainer qualification was performed, and this
record does not claim any. That covers fresh-install or upgrade receipts, a
Desktop updater journey across this version, an auto-review round or a `wisp
capture` screenshot taken by the published daemon, the token-spending harness
probes, and the paid evaluator panel. The published assets and release body
remain immutable; this ledger records the completed outcome separately.

The checks nobody ran also include what the release workflow's post-publication
steps did not show. "verify anonymous public downloads" stopped at the daemon
app's `stapler validate`, so CI never assessed the downloaded daemon app with
Gatekeeper, never checked its entitlements in the public bytes, never verified
the public Desktop archive's updater signature or its rejection of an altered
archive, and never verified the downloaded Desktop app's signature, staple, or
Gatekeeper assessment. "install the published Formula the way a user does" was
skipped, and this record does not claim an install of the published Formula. On
2026-10-15 the daemon app was re-verified locally by hand instead:
`wisp-v0.7.0-darwin-arm64.tar.gz` and `SHA256SUMS-darwin-arm64` were downloaded
anonymously from the v0.7.0 release, and the tarball matched its checksum line.
In the extracted `Wisp Daemon.app`, `codesign --verify --deep --strict` passed,
`xcrun stapler validate` passed, and `spctl -a -vv -t execute` accepted it
(`source=Notarized Developer ID`). Only the daemon app was checked by hand; the
Desktop app (`Wisp.app`) was not, so its items above remain checks nobody ran,
and this record claims nothing beyond those results.
