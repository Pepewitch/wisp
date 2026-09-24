# Wisp 0.6 qualification

This ledger separates release evidence from the version label. The 0.6 releases
are regular pre-1.0 releases, not a claim of exhaustive security or platform
coverage. 0.6.0 is the current release. The 0.5 records remain in
[the 0.5 ledger](../v0.5/QUALIFICATION.md).

The tested limits, remaining platform gaps and native dependency advisory scope
recorded for 0.5 under
[Still unqualified or outside scope](../v0.5/QUALIFICATION.md#still-unqualified-or-outside-scope)
still apply to 0.6.0.

## 0.6.0 publication

**Published and promoted on 2026-09-24.**
[Wisp 0.6.0](https://github.com/Pepewitch/wisp/releases/tag/v0.6.0) is the
latest regular GitHub release (`draft: false`, `prerelease: false`), published
at 03:26:32 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`5bebe953f9f79c55e266bc783d518f33dbeb0449`](https://github.com/Pepewitch/wisp/commit/5bebe953f9f79c55e266bc783d518f33dbeb0449),
landed through [PR #281](https://github.com/Pepewitch/wisp/pull/281). It
carries auto-merge and auto-fix
([#267](https://github.com/Pepewitch/wisp/pull/267)–[#279](https://github.com/Pepewitch/wisp/pull/279))
and the other changes listed in the release notes since 0.5.18. It replaces
the 0.5.19 preparation from [PR #277](https://github.com/Pepewitch/wisp/pull/277),
which was never tagged.

The [release workflow](https://github.com/Pepewitch/wisp/actions/runs/35950828711)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/35949566625) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `5bebe95` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 03:28:43 UTC with Homebrew tap commit
[`f7bd690501a1a952d685ae20fb385607cc30f404`](https://github.com/Pepewitch/homebrew-tap/commit/f7bd690501a1a952d685ae20fb385607cc30f404).
The Formula, Cask, daemon update channel, and Desktop update channel all serve
0.6.0.

0.6.0 adds no database migration. Before tagging, auto-merge and auto-fix were
exercised end to end on a development daemon built from source, against a
private sandbox repository: a CI failure fixed and then merged, a review thread
fixed, answered, resolved and merged, and the archive prompt for a watched PR.
That was not the published artifact. No maintainer qualification of the
published release — fresh-install or upgrade receipts, a Desktop updater
journey across this version, live coding turns for every listed model, the
token-spending harness probes, or the paid evaluator panel — was performed,
and this record does not claim it. The published assets and release body
remain immutable; this ledger records the completed outcome separately.
