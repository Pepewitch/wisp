# Wisp 0.7 qualification

This ledger separates release evidence from the version label. The 0.7 releases
are regular pre-1.0 releases, not a claim of exhaustive security or platform
coverage. 0.7.0 is the current release. The 0.6 records remain in
[the 0.6 ledger](../v0.6/QUALIFICATION.md).

The tested limits, remaining platform gaps and native dependency advisory scope
recorded for 0.5 under
[Still unqualified or outside scope](../v0.5/QUALIFICATION.md#still-unqualified-or-outside-scope)
still apply to 0.7.0.

## 0.7.0 publication

**Published and promoted on 2026-10-15.**
[Wisp 0.7.0](https://github.com/Pepewitch/wisp/releases/tag/v0.7.0) is the
latest regular GitHub release (`draft: false`, `prerelease: false`), published
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
The Formula, Cask, daemon update channel, and Desktop update channel all serve
0.7.0.

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
skipped, and this record does not claim an install of the published Formula. The
anonymous re-verification of the public release was done locally by hand
instead: the checksums matched, `codesign` verified the signature, `stapler
validate` passed, and `spctl` accepted it as Notarized Developer ID. This record
claims nothing beyond those four results.