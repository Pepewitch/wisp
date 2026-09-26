# Wisp 0.6 qualification

This ledger separates release evidence from the version label. The 0.6 releases
are regular pre-1.0 releases, not a claim of exhaustive security or platform
coverage. 0.6.2 is the current release; earlier 0.6 records are retained
below. The 0.5 records remain in
[the 0.5 ledger](../v0.5/QUALIFICATION.md).

The tested limits, remaining platform gaps and native dependency advisory scope
recorded for 0.5 under
[Still unqualified or outside scope](../v0.5/QUALIFICATION.md#still-unqualified-or-outside-scope)
still apply to 0.6.2.

## 0.6.2 publication

**Published and promoted on 2026-09-25.**
[Wisp 0.6.2](https://github.com/Pepewitch/wisp/releases/tag/v0.6.2) is the
latest regular GitHub release (`draft: false`, `prerelease: false`), published
at 11:19:47 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`3fe890a309bd03b83268b13728b3c674b2ebe96b`](https://github.com/Pepewitch/wisp/commit/3fe890a309bd03b83268b13728b3c674b2ebe96b),
landed through [PR #295](https://github.com/Pepewitch/wisp/pull/295). It
carries the usage ring for each harness's plan limits
([#293](https://github.com/Pepewitch/wisp/pull/293)), create-task drafts kept
per project ([#294](https://github.com/Pepewitch/wisp/pull/294)), the Review
judge section in Settings ([#292](https://github.com/Pepewitch/wisp/pull/292))
and the other changes listed in the release notes since 0.6.1.

The [release workflow](https://github.com/Pepewitch/wisp/actions/runs/36128051553)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/36127562239) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `3fe890a` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 11:21:53 UTC with Homebrew tap commit
[`4beeefa517a81db2c3f8524406baa490e6b9632c`](https://github.com/Pepewitch/homebrew-tap/commit/4beeefa517a81db2c3f8524406baa490e6b9632c).
The Formula, Cask, daemon update channel, and Desktop update channel all serve
0.6.2.

0.6.2 adds no database migration. Local brand checks ran without Chrome, so
the PNG assets were not re-rendered; no PNG asset or brand-generator input
changed since 0.6.1.
This is a fully automated publication: no maintainer qualification —
fresh-install or upgrade receipts, a Desktop updater journey across this
version, plan-limit reads against live claude, codex and droid accounts on the
published daemon, the token-spending harness probes, or the paid evaluator
panel — was performed, and this record does not claim them. The published
assets and release body remain immutable; this ledger records the completed
outcome separately.

## 0.6.1 publication

**Published and promoted on 2026-09-24.**
[Wisp 0.6.1](https://github.com/Pepewitch/wisp/releases/tag/v0.6.1) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 09:59:42 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`ddaa117a501a7a5cfe8aff9095d999a5f3442b93`](https://github.com/Pepewitch/wisp/commit/ddaa117a501a7a5cfe8aff9095d999a5f3442b93),
landed through [PR #290](https://github.com/Pepewitch/wisp/pull/290). It
carries the optional review judge
([#286](https://github.com/Pepewitch/wisp/pull/286)), five auto-fix rounds
([#288](https://github.com/Pepewitch/wisp/pull/288)), the pre-merge re-read
([#289](https://github.com/Pepewitch/wisp/pull/289)) and the other changes
listed in the release notes since 0.6.0.

The [release workflow](https://github.com/Pepewitch/wisp/actions/runs/35983685108)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/35983557186) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `ddaa117` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 10:01:58 UTC with Homebrew tap commit
[`0a96259af5da4fd3585b728d9eae48c96e1078a9`](https://github.com/Pepewitch/homebrew-tap/commit/0a96259af5da4fd3585b728d9eae48c96e1078a9).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.6.1 until 0.6.2 was promoted.

0.6.1 adds no database migration. Local brand checks ran without Chrome, so
the PNG assets were not re-rendered; no PNG asset or brand-generator input
changed since 0.6.0.
This is a fully automated publication: no maintainer qualification —
fresh-install or upgrade receipts, a Desktop updater journey across this
version, a review judge run against a live repository on the published
daemon, the token-spending harness probes, or the paid evaluator panel — was
performed, and this record does not claim them. The published assets and
release body remain immutable; this ledger records the completed outcome
separately.

## 0.6.0 publication

**Published and promoted on 2026-09-24.**
[Wisp 0.6.0](https://github.com/Pepewitch/wisp/releases/tag/v0.6.0) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
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
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.6.0 until 0.6.1 was promoted.

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
