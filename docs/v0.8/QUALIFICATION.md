# Wisp 0.8 qualification

This ledger separates release evidence from the version label. The 0.8 releases
are regular pre-1.0 releases, not a claim of exhaustive security or platform
coverage. 0.8.8 is the current release; earlier 0.8 records are retained
below. The 0.7 records remain in
[the 0.7 ledger](../v0.7/QUALIFICATION.md).

The tested limits, remaining platform gaps and native dependency advisory scope
recorded for 0.5 under
[Still unqualified or outside scope](../v0.5/QUALIFICATION.md#still-unqualified-or-outside-scope)
still apply to 0.8.8.

## 0.8.8 publication

**Published and promoted on 2026-11-12.**
[Wisp 0.8.8](https://github.com/Pepewitch/wisp/releases/tag/v0.8.8) is the
latest regular GitHub release (`draft: false`, `prerelease: false`), published
at 12:06:55 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`c9fac28b8f9529078ed265707cde8accffbd05e9`](https://github.com/Pepewitch/wisp/commit/c9fac28b8f9529078ed265707cde8accffbd05e9),
landed through [PR #543](https://github.com/Pepewitch/wisp/pull/543). It carries
Fable 5.2 in Claude's curated model lineup
([#538](https://github.com/Pepewitch/wisp/pull/538)), `@` mentions and the `/`
palette in the New task composer
([#537](https://github.com/Pepewitch/wisp/pull/537)), a sidebar that keeps
following task state after a login-time start raced its daemon
([#536](https://github.com/Pepewitch/wisp/pull/536)), and the other changes
listed in the release notes since 0.8.7.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/43213209150)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/43212853190) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `c9fac28` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 12:13:59 UTC with Homebrew tap commit
[`9ccbb5db064acec52eaf6970c687c4e30b895007`](https://github.com/Pepewitch/homebrew-tap/commit/9ccbb5db064acec52eaf6970c687c4e30b895007).
The Formula, Cask, daemon update channel, and Desktop update channel all serve
0.8.8.

0.8.8 adds database migration 33, so a 0.8.7 daemon cannot reopen a profile that
0.8.8 has opened. No PNG asset or brand-generator input changed since 0.8.7, so
the PNG assets were not re-rendered. This is a fully automated publication: no
maintainer qualification — fresh-install or upgrade receipts, a Desktop updater
journey across this version, the token-spending harness probes, or the paid
evaluator panel — was performed, and this record does not claim them. The
published assets and release body remain immutable; this ledger records the
completed outcome separately.

Two checks specific to this release were not run, and this record does not
claim them. **No Wisp task has run on `claude-fable-5-2`.** Its argv acceptance
was proven without spending a turn — print-mode `/model` on claude-code 2.1.322
echoed the id back with `num_turns: 0`, `duration_api_ms: 0` and every usage
counter zero — and the stream, usage and settlement contracts it would exercise
are per-harness rather than per-model, pinned at 2.1.240–2.1.283 and untouched
here. The minimal live turn
[harness sync §5](../../skills/wisp-dev/references/harness-sync.md#5-escalate-to-one-minimal-live-turn)
prescribes for a new id was therefore waived deliberately, not overlooked; the
first real Fable 5.2 turn will be a user's. **No Desktop updater journey was
observed across this version**, which matters more than usual because 0.8.8
moves `tauri-plugin-updater` from 2.11.0 to 2.14.1
([#541](https://github.com/Pepewitch/wisp/pull/541)) — a change inside the
component that performs the update. Its signature verification, altered-archive
rejection and channel contents were verified by the release workflow and the
independent update verifier, but an in-app 0.8.7 → 0.8.8 update was not
performed by hand.

## 0.8.7 publication

**Published and promoted on 2026-11-04.**
[Wisp 0.8.7](https://github.com/Pepewitch/wisp/releases/tag/v0.8.7) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 10:30:48 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`04ffbf64420f307128a5bcad9b72c4076a34cddb`](https://github.com/Pepewitch/wisp/commit/04ffbf64420f307128a5bcad9b72c4076a34cddb),
landed through [PR #532](https://github.com/Pepewitch/wisp/pull/532). It carries
subtask reports that steer into a parent's long-running turn
([#526](https://github.com/Pepewitch/wisp/pull/526)) and show as Wisp's own
block while queued ([#528](https://github.com/Pepewitch/wisp/pull/528)), usage
limits that keep their last good reading when a refresh fails
([#530](https://github.com/Pepewitch/wisp/pull/530)), `wisp report ack`
([#531](https://github.com/Pepewitch/wisp/pull/531)), and the other changes
listed in the release notes since 0.8.6.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/41813464215)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/41812868486) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `04ffbf6` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 10:32:55 UTC with Homebrew tap commit
[`fc301cb160043ff236281fdc01441d4657608b78`](https://github.com/Pepewitch/homebrew-tap/commit/fc301cb160043ff236281fdc01441d4657608b78).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.8.7 until 0.8.8 was promoted.

0.8.7 adds database migration 32, so a 0.8.6 daemon cannot reopen a profile that
0.8.7 has opened. No PNG asset or brand-generator input changed since 0.8.6, so
the PNG assets were not re-rendered. This is a fully automated publication: no
maintainer qualification — fresh-install or upgrade receipts, a Desktop updater
journey across this version, the token-spending harness probes, or the paid
evaluator panel — was performed, and this record does not claim them. The
published assets and release body remain immutable; this ledger records the
completed outcome separately.

The local `release:check` did not pass on a machine at load 100–125. It
stopped at one 5-second timeout in `tests/install-script.test.ts`. Run by hand,
`bun run build` passed, but `bun run smoke` failed twice at its daemon-restart
step: the fake harness's 8-second turn ended while the daemon was down. The
published 0.8.6 failed the same step under the same load. The owner authorized
publishing anyway. Nobody ran a live check against the published daemon of a
report steering into a running turn, of `wisp report ack`, or of the Claude
usage read's lighter flags.

## 0.8.6 publication

**Published and promoted on 2026-11-02.**
[Wisp 0.8.6](https://github.com/Pepewitch/wisp/releases/tag/v0.8.6) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 11:41:04 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`a5bf91412cb52f312793b28f3f643db525a7af7f`](https://github.com/Pepewitch/wisp/commit/a5bf91412cb52f312793b28f3f643db525a7af7f),
landed through [PR #514](https://github.com/Pepewitch/wisp/pull/514). It carries
`wisp wait` for tasks to settle ([#496](https://github.com/Pepewitch/wisp/pull/496)),
subtasks that queue at their parent's running cap
([#508](https://github.com/Pepewitch/wisp/pull/508)), Cursor's model list
restored when a model check lists nothing
([#503](https://github.com/Pepewitch/wisp/pull/503)), and the other changes
listed in the release notes since 0.8.5.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/41437567897)
published the release. Its `publish` job then failed after publication: "verify
anonymous public downloads" failed and "install the published Formula the way a
user does" was skipped. The failure was Apple's: the step's last check,
`xcrun stapler validate` on the downloaded Desktop app, lost its connection to
Apple's CloudKit ticket service ("The network connection was lost", Error 68),
the same transient drop that hit 0.7.0 and 0.7.1. Every check before it in that
step passed on the anonymous downloads: the seven checksums, the daemon app's
signature, entitlements, staple and Gatekeeper assessment, the Desktop updater
signature, and the rejection of an altered archive. Promoting was safe because
the remaining Desktop checks then passed by hand on the published bytes (below). Promotion, which that failure skipped, finished in a separate
[recovery run](https://github.com/Pepewitch/wisp/actions/runs/41438916186). The
gates before publication passed; the post-publication checks did not:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/41437266595) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets before publication; the release workflow's check of the anonymous public downloads of clean tagged commit `a5bf914` failed after publication, so this record does not claim it |
| Homebrew installability | The Formula and Cask were audited offline before publication; the release workflow's install of the published Formula the way a user does was skipped after publication, so this record does not claim it |

Promotion completed at 11:45:31 UTC with Homebrew tap commit
[`ddab9f4f3cc017badbccbfe36456228d542b5f60`](https://github.com/Pepewitch/homebrew-tap/commit/ddab9f4f3cc017badbccbfe36456228d542b5f60).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.8.6 until 0.8.7 was promoted.

0.8.6 adds database migrations 30 and 31, so a 0.8.5 daemon cannot reopen a
profile that 0.8.6 has opened. No PNG asset or brand-generator input changed
since 0.8.5, so the PNG assets were not re-rendered. This is a fully automated
publication: no maintainer qualification — fresh-install or upgrade receipts, a
Desktop updater journey across this version, the token-spending harness probes,
or the paid evaluator panel — was performed, and this record does not claim
them. The published assets and release body remain immutable; this ledger
records the completed outcome separately.

The local release gate, `bun run release:check 0.8.6`, never passed. It failed
twice in its `check` gate, each time on one `tests/install-script.test.ts` test
timing out at 5 s (a different test each run) on a machine at load 29–39 from
other agents. The file passed on its own (4 of 4), and the owner explicitly
authorized publishing without the local gate. `bun run smoke` and `bun run
build`, which that gate had not reached, then passed by hand on the merged
release commit `a5bf914`, and the release PR's CI passed on the same tree.

The failed "verify anonymous public downloads" step did not finish its
Desktop checks: the staple validation and the Gatekeeper assessment of the
downloaded Desktop app. Both were run by hand on a maintainer Mac against an
anonymous download of `wisp-desktop-v0.8.6-darwin-arm64.tar.gz`: its SHA-256
matched `SHA256SUMS-desktop-darwin-arm64`, `codesign --verify --deep --strict`
passed, `xcrun stapler validate` passed, and `spctl --assess` accepted it as
"Notarized Developer ID". The skipped "install the published Formula the way a
user does" was not run by hand, so no install of the published Formula is
claimed; the closeout's anonymous check above shows only that the tap serves
0.8.6. No headline change was run live against the published daemon.

## 0.8.5 publication

**Published and promoted on 2026-10-31.**
[Wisp 0.8.5](https://github.com/Pepewitch/wisp/releases/tag/v0.8.5) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 10:01:09 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`c7dfe960ac106be8dc1e741ec72d7e61b5386558`](https://github.com/Pepewitch/wisp/commit/c7dfe960ac106be8dc1e741ec72d7e61b5386558),
landed through [PR #489](https://github.com/Pepewitch/wisp/pull/489). It carries
Droid background work that outlives its turn and wakes a follow-up turn when it
finishes ([#486](https://github.com/Pepewitch/wisp/pull/486)), and the other
changes listed in the release notes since 0.8.4.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/41190168466)
completed every job successfully. It was the second tag. The first `v0.8.5`,
on the version commit `de3e0be`, ran
[release workflow 41184812358](https://github.com/Pepewitch/wisp/actions/runs/41184812358).
Its `publish` job failed in the offline Homebrew audit before anything was
published: Homebrew 7 refused to load the formula from the untrusted audit tap.
That tag was deleted, [PR #489](https://github.com/Pepewitch/wisp/pull/489)
made the audit trust the tap it creates, and the tag was recreated on `c7dfe96`
after that commit's release checks passed:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/41185934941) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `c7dfe96` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 10:03:11 UTC with Homebrew tap commit
[`7ce9e6697675ced9fc01ef5095ae9962c2b3fd1a`](https://github.com/Pepewitch/homebrew-tap/commit/7ce9e6697675ced9fc01ef5095ae9962c2b3fd1a).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.8.5 until 0.8.6 was promoted.

0.8.5 adds no database migration. No PNG asset or brand-generator input changed
since 0.8.4, so the PNG assets were not re-rendered. This is a fully automated
publication: no maintainer qualification — fresh-install or upgrade receipts, a
Desktop updater journey across this version, the token-spending harness probes,
or the paid evaluator panel — was performed, and this record does not claim
them. The published assets and release body remain immutable; this ledger
records the completed outcome separately.

Also not performed: a Droid task on the published daemon that starts
background work, ends its turn and is woken by the completion. The change was
verified with protocol fixtures and one live run of droid 0.251.0 through the
runner under test, not on an installed 0.8.5.

## 0.8.4 publication

**Published and promoted on 2026-10-30.**
[Wisp 0.8.4](https://github.com/Pepewitch/wisp/releases/tag/v0.8.4) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 09:25:46 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`478ee117b4229b5b59b76d60a07bb45ece16446c`](https://github.com/Pepewitch/wisp/commit/478ee117b4229b5b59b76d60a07bb45ece16446c),
landed through [PR #483](https://github.com/Pepewitch/wisp/pull/483). It carries
auto-review that starts on ready, holds auto-fix while it runs and sends one
combined round ([#475](https://github.com/Pepewitch/wisp/pull/475)); Claude
usage limits read with `get_usage`
([#479](https://github.com/Pepewitch/wisp/pull/479)); `wisp send` switching a
task's model, effort or harness
([#482](https://github.com/Pepewitch/wisp/pull/482)); and the other changes
listed in the release notes since 0.8.3.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/41032370204)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, and update-verifier checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/41032074699) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `478ee11` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 09:28:21 UTC with Homebrew tap commit
[`13d50fee619dcff7ca3b619d632234b18d5d3407`](https://github.com/Pepewitch/homebrew-tap/commit/13d50fee619dcff7ca3b619d632234b18d5d3407).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.8.4 until 0.8.5 was promoted.

0.8.4 adds no database migration. No PNG asset or brand-generator input changed
since 0.8.3, so the PNG assets were not re-rendered. This is a fully automated
publication: no maintainer qualification — fresh-install or upgrade receipts, a
Desktop updater journey across this version, the token-spending harness probes,
or the paid evaluator panel — was performed, and this record does not claim
them. The published assets and release body remain immutable; this ledger
records the completed outcome separately.

The local `release:check` gate was not passed for this release: it failed
twice on machine load alone (load average 60 to 110, timeouts in test files
the release did not change), and the owner authorized publishing without it.
GitHub's required checks (`test`, `browser-security`, `supply-chain`) and the
macOS `native-core` job passed on release PR #483, and every release workflow
job passed. Nobody ran the new review-on-ready flow, or a `wisp send --model`
switch, against the published daemon. The Desktop Cask's `depends_on` order
changed for Homebrew 7.0.11's `brew style`; the promotion audit accepted it.

## 0.8.3 publication

**Published and promoted on 2026-10-29.**
[Wisp 0.8.3](https://github.com/Pepewitch/wisp/releases/tag/v0.8.3) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 07:35:52 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`d522b317b7df1cc2a3da95368eabb1cc1e29e09f`](https://github.com/Pepewitch/wisp/commit/d522b317b7df1cc2a3da95368eabb1cc1e29e09f),
landed through [PR #473](https://github.com/Pepewitch/wisp/pull/473). It carries
Review now, which starts auto-review on a head without waiting for its checks
([#471](https://github.com/Pepewitch/wisp/pull/471)); reviewer prompts without
the author task's first message
([#468](https://github.com/Pepewitch/wisp/pull/468)); project rows that end
with + and reorder by long press on touch
([#469](https://github.com/Pepewitch/wisp/pull/469)); and the other changes
listed in the release notes since 0.8.2.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/40835369973)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/40835114805) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `d522b31` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 07:38:14 UTC with Homebrew tap commit
[`689d2f4b7dddf8ea10e6be39b1f74e90dae34175`](https://github.com/Pepewitch/homebrew-tap/commit/689d2f4b7dddf8ea10e6be39b1f74e90dae34175).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.8.3 until 0.8.4 was promoted.

0.8.3 adds database migration 29, so a 0.8.2 daemon cannot reopen a profile that
0.8.3 has opened. No PNG asset or brand-generator input changed since 0.8.2, so
the PNG assets were not re-rendered. This is a fully automated publication: no
maintainer qualification — fresh-install or upgrade receipts, a Desktop updater
journey across this version, the token-spending harness probes, or the paid
evaluator panel — was performed, and this record does not claim them. The
published assets and release body remain immutable; this ledger records the
completed outcome separately.

Nobody clicked Review now against a real pull request on the published daemon;
it was exercised against a throwaway daemon with a seeded PR, in tests, and in
browser captures. The touch long-press drag was verified only with synthetic
touches in a browser, not on a device.

## 0.8.2 publication

**Published and promoted on 2026-10-27.**
[Wisp 0.8.2](https://github.com/Pepewitch/wisp/releases/tag/v0.8.2) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 14:48:32 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`befbb2137882b283f955f0daf8963da5a795f99f`](https://github.com/Pepewitch/wisp/commit/befbb2137882b283f955f0daf8963da5a795f99f),
landed through [PR #465](https://github.com/Pepewitch/wisp/pull/465). It carries
turn images placed under the step that produced them
([#460](https://github.com/Pepewitch/wisp/pull/460)), the phone sidebar and
task sheet dragged under the thumb
([#463](https://github.com/Pepewitch/wisp/pull/463),
[#464](https://github.com/Pepewitch/wisp/pull/464)), Claude's current lineup
([#461](https://github.com/Pepewitch/wisp/pull/461)), and the other changes
listed in the release notes since 0.8.1.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/40523262955)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/40522905178) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `befbb21` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 14:51:25 UTC with Homebrew tap commit
[`c1744c1abfe495ce061b88c240ec26fcf6572a8a`](https://github.com/Pepewitch/homebrew-tap/commit/c1744c1abfe495ce061b88c240ec26fcf6572a8a).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.8.2 until 0.8.3 was promoted.

0.8.2 adds no database migration. No PNG asset or brand-generator input changed
since 0.8.1, so the PNG assets were not re-rendered. This is a fully automated
publication: no maintainer qualification — fresh-install or upgrade receipts, a
Desktop updater journey across this version, the token-spending harness probes,
or the paid evaluator panel — was performed, and this record does not claim
them. The published assets and release body remain immutable; this ledger
records the completed outcome separately.

Nor did anyone run this release's headline changes against the published
daemon: image steps were verified by tests and on throwaway daemons with
scripted harnesses, and the phone drags with synthetic touches in a browser,
not on a device.

## 0.8.1 publication

**Published and promoted on 2026-10-27.**
[Wisp 0.8.1](https://github.com/Pepewitch/wisp/releases/tag/v0.8.1) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 07:03:07 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`9b9e90aa22676378a7302f3fbfee7ce4ef68d68f`](https://github.com/Pepewitch/wisp/commit/9b9e90aa22676378a7302f3fbfee7ce4ef68d68f),
landed through [PR #458](https://github.com/Pepewitch/wisp/pull/458). It carries
`@` mentions of projects and their files in the composer
([#451](https://github.com/Pepewitch/wisp/pull/451)), project reordering in the
sidebar ([#454](https://github.com/Pepewitch/wisp/pull/454)), a starred default
effort per harness and model
([#453](https://github.com/Pepewitch/wisp/pull/453)), a smoother tool panel
([#449](https://github.com/Pepewitch/wisp/pull/449)), and the other changes
listed in the release notes since 0.8.0.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/40463837624)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/40463613786) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `9b9e90a` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 07:05:36 UTC with Homebrew tap commit
[`e7d8dd1d8a9ff7a36c1ffc3e6a7e3a7f09fd4e74`](https://github.com/Pepewitch/homebrew-tap/commit/e7d8dd1d8a9ff7a36c1ffc3e6a7e3a7f09fd4e74).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.8.1 until 0.8.2 was promoted.

0.8.1 adds database migration 28, so a 0.8.0 daemon cannot reopen a profile that
0.8.1 has opened. No PNG asset or brand-generator input changed since 0.8.0, so
the PNG assets were not re-rendered. This is a fully automated publication: no
maintainer qualification — fresh-install or upgrade receipts, a Desktop updater
journey across this version, the token-spending harness probes, or the paid
evaluator panel — was performed, and this record does not claim them. Nor was
a person's run of this release's headline changes against the published
daemon: `@` mentions, drag-to-reorder, and the panel glide were verified by
tests and in a browser against throwaway daemons, not on the published build,
and the Desktop drag region and ⌘\\ / ⌃\` chords remain unverified by a person
on the native app. The
published assets and release body remain immutable; this ledger records the
completed outcome separately.

## 0.8.0 publication

**Published and promoted on 2026-10-26.**
[Wisp 0.8.0](https://github.com/Pepewitch/wisp/releases/tag/v0.8.0) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 16:22:19 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`5293a6388d2a855f398e1ad2c55229c85a9bcad1`](https://github.com/Pepewitch/wisp/commit/5293a6388d2a855f398e1ad2c55229c85a9bcad1),
landed through [PR #436](https://github.com/Pepewitch/wisp/pull/436). It carries
the redesigned task screen
([#430](https://github.com/Pepewitch/wisp/pull/430)–[#435](https://github.com/Pepewitch/wisp/pull/435)),
fallback reviewers for auto-review
([#427](https://github.com/Pepewitch/wisp/pull/427)), live updates that
connect at once ([#435](https://github.com/Pepewitch/wisp/pull/435)), and the
other changes listed in the release notes since 0.7.2.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/40356921797)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/40356497539) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `5293a63` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 16:24:25 UTC with Homebrew tap commit
[`2892304c438b248cb299e9deb52f4bad204de28a`](https://github.com/Pepewitch/homebrew-tap/commit/2892304c438b248cb299e9deb52f4bad204de28a).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.8.0 until 0.8.1 was promoted.

0.8.0 adds database migration 27, so a 0.7.2 daemon cannot reopen a profile that
0.8.0 has opened. No PNG asset or brand-generator input changed since 0.7.2, so
the PNG assets were not re-rendered. This is a fully automated publication: no
maintainer qualification — fresh-install or upgrade receipts, a Desktop updater
journey across this version, the token-spending harness probes, or the paid
evaluator panel — was performed, and this record does not claim them. Nor was
a person's run of this release's headline changes against the published
daemon: `@` mentions, drag-to-reorder, and the panel glide were verified by
tests and in a browser against throwaway daemons, not on the published build,
and the Desktop drag region and ⌘\\ / ⌃\` chords remain unverified by a person
on the native app. The
published assets and release body remain immutable; this ledger records the
completed outcome separately.

Not run for this release either: the redesigned top bar's window drag and the
⌘\\ / ⌃\` shortcuts in the signed Desktop app (reviewed in code and in the
browser only), and a live fallback-reviewer substitution against a real
provider outage. The release gate passed on its third local run; the first two
ran on a machine under heavy load, and the second also exposed a codex usage
race fixed before tagging in [#437](https://github.com/Pepewitch/wisp/pull/437).
