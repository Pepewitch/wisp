# Wisp 0.9 qualification

This ledger separates release evidence from the version label. The 0.9 releases
are regular pre-1.0 releases, not a claim of exhaustive security or platform
coverage. 0.9.0 is the current release. The 0.8 records remain in
[the 0.8 ledger](../v0.8/QUALIFICATION.md).

The tested limits, remaining platform gaps and native dependency advisory scope
recorded for 0.5 under
[Still unqualified or outside scope](../v0.5/QUALIFICATION.md#still-unqualified-or-outside-scope)
still apply to 0.9.0.

## 0.9.0 publication

**Published and promoted on 2026-11-14.**
[Wisp 0.9.0](https://github.com/Pepewitch/wisp/releases/tag/v0.9.0) is the
latest regular GitHub release (`draft: false`, `prerelease: false`), published
at 06:09:08 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`fa1ca8911e0f256124f1744b0f2367853d99f33e`](https://github.com/Pepewitch/wisp/commit/fa1ca8911e0f256124f1744b0f2367853d99f33e),
landed through [PR #579](https://github.com/Pepewitch/wisp/pull/579). It carries
warm Claude processes that start a task's next turn sooner
([#563](https://github.com/Pepewitch/wisp/pull/563)), Claude's
`AskUserQuestion` answered on the question card inside the turn
([#546](https://github.com/Pepewitch/wisp/pull/546),
[#547](https://github.com/Pepewitch/wisp/pull/547)), batched routine subtask
reports ([#554](https://github.com/Pepewitch/wisp/pull/554)), and the other
changes listed in the release notes since 0.8.8.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/43450184953)
completed every job successfully on attempt 5. Attempts 1 to 4 (2026-11-13)
failed only in `macos-trusted`, at the first notarization submission: Apple's
notary service answered HTTP 403, "A required agreement is missing or has
expired", because an updated Apple Developer Program agreement was waiting for
the team to accept it. The same API key had notarized 0.8.8 the day before.
`publish` and `promote` were skipped on every failed attempt, so nothing was
public. Rerunning only the failed job was safe because the tag was unpublished
and correct and nothing in the repository needed to change; attempt 5 ran after
the agreement was accepted and Apple's service had picked it up:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/43449797273) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `fa1ca89` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 06:11:58 UTC with Homebrew tap commit
[`dfdb3931feb73913039906db2af4ceba826f089b`](https://github.com/Pepewitch/homebrew-tap/commit/dfdb3931feb73913039906db2af4ceba826f089b).
The Formula, Cask, daemon update channel, and Desktop update channel all serve
0.9.0.

0.9.0 adds database migration 34, so a 0.8.8 daemon cannot reopen a profile that
0.9.0 has opened. No PNG asset or brand-generator input changed since 0.8.8, so
the PNG assets were not re-rendered. This is a fully automated publication: no
maintainer qualification — fresh-install or upgrade receipts, a Desktop updater
journey across this version, the token-spending harness probes, the paid
evaluator panel, a live run of the warm Claude process or the question card
against the published daemon, a live Droid turn, or a person scrolling long
transcripts in the Desktop webview — was performed, and this record does not
claim them. Before tagging, a compiled build of main was run in an isolated
home with real Claude and Codex turns, a warm follow-up turn, a subtask report,
search, and a question answered on the card; that is pre-release evidence, not
a check of the published artifacts. The published assets and release body
remain immutable; this ledger records the completed outcome separately.
