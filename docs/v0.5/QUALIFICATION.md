# Wisp 0.5 qualification

This ledger separates release evidence from the version label. The 0.5 releases
are regular pre-1.0 releases, not a claim of exhaustive security or platform
coverage. 0.5.16 is the current release; earlier 0.5 records are retained below.

## 0.5.16 publication

**Published and promoted on 2026-09-23.**
[Wisp 0.5.16](https://github.com/Pepewitch/wisp/releases/tag/v0.5.16) is the
latest regular GitHub release (`draft: false`, `prerelease: false`), published
at 04:50:17 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`7e677321d323254c37116793640b37a51c9b0fa7`](https://github.com/Pepewitch/wisp/commit/7e677321d323254c37116793640b37a51c9b0fa7),
landed through [PR #257](https://github.com/Pepewitch/wisp/pull/257), carrying
[PR #256](https://github.com/Pepewitch/wisp/pull/256) and
[PR #258](https://github.com/Pepewitch/wisp/pull/258).

0.5.16 exists because 0.5.15 crashed. 0.5.15 was the first release whose
hardened, Developer ID signed daemon a user could install, and it carried no
entitlements at all. The daemon reaches libc through `bun:ffi` to open a pty, so
every terminal open trapped in `pthread_jit_write_protect_np` and killed the
whole daemon; launchd restarted it and the next attempt did the same. Desktop
reported `could not open a shell (1006)` and then `could not reach the daemon`.
Measured under a real Developer ID signature against bun 1.3.14: no entitlements
SIGTRAPs, `allow-jit` alone is SIGKILLed, and
`allow-unsigned-executable-memory` is the one that works.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/35819341904)
completed all seven jobs successfully on the first attempt:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, native-core, npm, Rust, supply-chain, and public-promotion dry-run checks passed; the exact-main release candidate also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; the Desktop updater signature and altered-archive rejection passed |
| macOS daemon entitlements | New in this release: the build refuses a signed daemon whose signature lacks `allow-jit` or `allow-unsigned-executable-memory`, and both were re-checked on the downloaded public bytes |
| Public assets | All ten anonymous downloads matched all three checksum sets and clean tagged commit `7e67732` |
| Homebrew installability | The archive was proven offline to stage to one top-level directory containing the bundle, and the rendered Formula was installed and tested from the published release on a clean runner before the tap advanced |
| Distribution | Fresh-runner Homebrew audits, four-file promotion, and fixed-URL convergence for both channels passed |

The promotion receipt completed at 04:52:13 UTC with Homebrew tap commit
[`ccce77a1f6faafa55d39e0c217470bbb4adfbc1c`](https://github.com/Pepewitch/homebrew-tap/commit/ccce77a1f6faafa55d39e0c217470bbb4adfbc1c),
with the Formula, Cask, and both update channels serving 0.5.16.

0.5.16 adds no database migration.

**Maintainer upgrade receipt.** One Apple Silicon machine on macOS 26.7 was
upgraded from 0.5.15 to 0.5.16 with `brew upgrade Pepewitch/tap/wisp` followed
by `brew services restart wisp`. `wisp version` reported
`0.5.16 (commit 7e677321…)`, the daemon served under its launchd service, the
installed bundle validated its staple and carried both entitlements under the
designated requirement `identifier "dev.wisp.daemon" and anchor apple generic
and certificate leaf[subject.OU] = G823NH4M6N`, and three consecutive terminal
opens returned `{"type":"hello","pty":true,…}` and closed 1000 with the daemon
pid unchanged — the failure 0.5.15 shipped.

The Monitor change was verified end to end before release against a daemon
built from that branch, with an isolated `WISP_HOME` and a real `claude`
harness: a task arming a background Monitor recorded `ARMED`, `EVENT tick 1`,
`EVENT tick 2`, `EVENT tick 3` and `MONITOR_DONE` as five results in one turn
and finished `done`.

**Not performed, and not claimed.** No gate runs the shipped daemon's terminal
end to end; 0.5.15 passed every check while crashing on first use, because each
gate runs the binary only long enough for `wisp version`. The entitlement checks
close that specific hole, not the class. No clean-machine fresh install beyond
the release runner, no Desktop Cask upgrade or updater journey across this
version, no Linux upgrade receipt, and no paid evaluator panel. The upgrade
receipt above covers one machine, one OS version, and the Formula only. Whether
the stable code identity prevents a new **App Management** row is still not
observable: 0.5.15's row was created by a signature this release replaces, so
the question carries forward to the next upgrade.

## 0.5.15 publication

**Published and promoted on 2026-09-22.**
[Wisp 0.5.15](https://github.com/Pepewitch/wisp/releases/tag/v0.5.15) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 16:26:49 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`4553d5548dd0c5e0b0b100ee8d554b9772409e23`](https://github.com/Pepewitch/wisp/commit/4553d5548dd0c5e0b0b100ee8d554b9772409e23),
landed through [PR #254](https://github.com/Pepewitch/wisp/pull/254). The repair
it carries landed through [PR #253](https://github.com/Pepewitch/wisp/pull/253).

0.5.15 exists because 0.5.14 could not be installed. Its archive placed
`Wisp Daemon.app` at the archive root, and Homebrew descends into a lone
top-level directory before a formula's `install` runs, so the rendered Formula
searched for the bundle from inside it and stopped with `Errno::ENOENT`. Every
0.5.14 gate had passed: `brew audit` is static and never stages an archive.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/35753348053)
completed all seven jobs successfully on the first attempt:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, native-core, npm, Rust, supply-chain, and public-promotion dry-run checks passed; the exact-main release candidate also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; the Desktop updater signature and altered-archive rejection passed |
| Public assets | All ten anonymous downloads matched all three checksum sets and clean tagged commit `4553d55` |
| Homebrew installability | New in this release: the built archive was proven offline to stage to exactly one top-level directory containing the bundle before publication, and the rendered Formula was then installed and tested from the published release on a clean runner before the tap advanced |
| Distribution | Fresh-runner Homebrew audits, four-file promotion, and fixed-URL convergence for both channels passed |

The promotion receipt completed at 16:31:51 UTC with Homebrew tap commit
[`aa4314281bfd0e04c0cc6239c29fb751c3c96848`](https://github.com/Pepewitch/homebrew-tap/commit/aa4314281bfd0e04c0cc6239c29fb751c3c96848),
with the Formula, Cask, and both update channels serving 0.5.15.

0.5.15 adds no database migration.

**Maintainer upgrade receipt.** One Apple Silicon machine on macOS 26.6.2 was
upgraded from 0.5.13 to 0.5.15 with `brew upgrade Pepewitch/tap/wisp` followed
by `brew services restart wisp`. The upgrade succeeded, `wisp version` reported
`0.5.15 (commit 4553d554…)`, the daemon served its HTTP port under its launchd
service, and the installed bundle carried `Identifier=dev.wisp.daemon` under a
Developer ID Application authority with the designated requirement
`identifier "dev.wisp.daemon" and anchor apple generic and certificate
leaf[subject.OU] = G823NH4M6N` — no `cdhash` term, unlike the ad-hoc 0.5.13
binary it replaced.

**Not performed, and not claimed.** No fresh install on a clean machine beyond
the release runner, no Desktop Cask upgrade or updater journey across this
version, no Linux upgrade receipt, and no paid evaluator panel. The upgrade
receipt above covers one machine, one OS version, and the Formula only. The
stable code identity is verified as installed, but whether it actually prevents
a new **Privacy & Security ▸ App Management** row is not yet observable: that
requires a later upgrade from 0.5.15 to a subsequent release.

## 0.5.14 publication

**Published and promoted on 2026-09-22.**
[Wisp 0.5.14](https://github.com/Pepewitch/wisp/releases/tag/v0.5.14) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 11:47:21 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`e72173010835de642302e1767a3dbf0e50ab3360`](https://github.com/Pepewitch/wisp/commit/e72173010835de642302e1767a3dbf0e50ab3360),
landed through [PR #251](https://github.com/Pepewitch/wisp/pull/251).

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/35722598210)
completed all seven jobs successfully on the first attempt:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, native-core, npm, Rust, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main release candidate also passed update-verifier and Linux-contract before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; the Desktop updater signature and altered-archive rejection passed |
| Public assets | All ten anonymous downloads matched all three checksum sets and clean tagged commit `e721730` |
| Distribution | Fresh-runner Homebrew audits, four-file promotion, and fixed-URL convergence for both channels passed |

The promotion receipt completed at 11:49:18 UTC with Homebrew tap commit
[`d18f3ba1a5fa38a9b29e9d895d508038ec680f1c`](https://github.com/Pepewitch/homebrew-tap/commit/d18f3ba1a5fa38a9b29e9d895d508038ec680f1c),
with the Formula, Cask, and both update channels serving 0.5.14.

0.5.14 adds no database migration. This is a fully automated publication: no
maintainer qualification — fresh-install or upgrade receipts, an updater
journey across this version, or the paid evaluator panel — was performed, and
this record does not claim them. The published assets and release body remain
immutable; this ledger records the completed outcome separately.

## 0.5.12 publication

**Published and promoted on 2026-09-21.**
[Wisp 0.5.12](https://github.com/Pepewitch/wisp/releases/tag/v0.5.12) is the
latest regular GitHub release (`draft: false`, `prerelease: false`), published
at 04:44:43 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`a7dc50260165afb7615c69aa7debdbfdaa5ee942`](https://github.com/Pepewitch/wisp/commit/a7dc50260165afb7615c69aa7debdbfdaa5ee942),
landed through [PR #240](https://github.com/Pepewitch/wisp/pull/240).

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/35561666277)
completed all seven jobs successfully:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, native-core, npm, Rust, supply-chain, release-candidate, and public-promotion dry-run checks passed |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| Desktop trust | Developer ID timestamp and hardened runtime, Apple notarization and staple, Gatekeeper, updater signature, and altered-archive rejection passed |
| Public assets | All ten anonymous downloads matched all three checksum sets and clean tagged commit `a7dc502` |
| Distribution | Fresh-runner Homebrew audits, four-file promotion, and fixed-URL convergence for both channels passed |

The promotion receipt completed at 04:46:43 UTC with Homebrew tap commit
[`6f5ad58562901db765c1a8e1fc31c04e046cedbb`](https://github.com/Pepewitch/homebrew-tap/commit/6f5ad58562901db765c1a8e1fc31c04e046cedbb)
and both update channels serving 0.5.12.

0.5.12 adds no database migration. This is a fully automated publication: no
maintainer qualification — fresh-install or upgrade receipts, an updater
journey across this version, or the paid evaluator panel — was performed, and
this record does not claim them. The published assets and release body remain
immutable; this ledger records the completed outcome separately.

## 0.5.11 publication

**Published and promoted on 2026-09-18.**
[Wisp 0.5.11](https://github.com/Pepewitch/wisp/releases/tag/v0.5.11) is the
regular GitHub release (`draft: false`, `prerelease: false`), published
at 18:44:38 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`ba13c97613b06e8b266ae5951ab2d36a89af1f55`](https://github.com/Pepewitch/wisp/commit/ba13c97613b06e8b266ae5951ab2d36a89af1f55),
landed through [PR #235](https://github.com/Pepewitch/wisp/pull/235).

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/35381144043)
completed all seven jobs successfully:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, native-core, npm, Rust, supply-chain, release-candidate, and public-promotion dry-run checks passed |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| Desktop trust | Developer ID timestamp and hardened runtime, Apple notarization and staple, Gatekeeper, updater signature, and altered-archive rejection passed |
| Public assets | All ten anonymous downloads matched all three checksum sets and clean tagged commit `ba13c97` |
| Distribution | Fresh-runner Homebrew audits, four-file promotion, and fixed-URL convergence for both channels passed |

The promotion receipt completed at 18:46:12 UTC with Homebrew tap commit
[`8e3661070ef13c4d31030dd5366c02697e4e05ed`](https://github.com/Pepewitch/homebrew-tap/commit/8e3661070ef13c4d31030dd5366c02697e4e05ed)
and both update channels serving 0.5.11.

The exact main candidate's first Linux contract attempt failed before the tag
was created when the activation fixture exhausted its readiness window at the
container's 1.5 GiB memory ceiling without an OOM kill. The release PR
candidate had passed with the same source, and the exact-main retry passed
before publication authorization. The tag workflow then repeated the
published-artifact installer and activation contracts successfully.

0.5.11 adds no database migration. This is a fully automated publication: no
maintainer qualification — fresh-install or upgrade receipts, an updater
journey across this version, or the paid evaluator panel — was performed, and
this record does not claim them. The published assets and release body remain
immutable; this ledger records the completed outcome separately.

## 0.5.10 publication

**Published and promoted on 2026-09-18.**
[Wisp 0.5.10](https://github.com/Pepewitch/wisp/releases/tag/v0.5.10) is the
regular GitHub release (`draft: false`, `prerelease: false`), published
at 10:22:30 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`04b0e1c0cdbec9d29722ca64005ec635d21e2219`](https://github.com/Pepewitch/wisp/commit/04b0e1c0cdbec9d29722ca64005ec635d21e2219),
landed through [PR #231](https://github.com/Pepewitch/wisp/pull/231).

The second attempt of the
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/35333576930/attempts/2)
completed all seven jobs successfully:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, native-core, npm, Rust, supply-chain, release-candidate, and public-promotion dry-run checks passed |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| Desktop trust | Developer ID timestamp and hardened runtime, Apple notarization and staple, Gatekeeper, updater signature, and altered-archive rejection passed |
| Public assets | All ten anonymous downloads matched all three checksum sets and clean tagged commit `04b0e1c`; the downloaded Linux binary reported 0.5.10 at that commit |
| Distribution | Fresh-runner Homebrew audits, four-file promotion, and fixed-URL convergence for both channels passed |

The promotion receipt completed at 10:24:36 UTC with Homebrew tap commit
[`33d1f6401c468083ed8fdd87301d86ded6f7e59c`](https://github.com/Pepewitch/homebrew-tap/commit/33d1f6401c468083ed8fdd87301d86ded6f7e59c)
and both update channels serving 0.5.10.

The first Linux release job failed before any asset was public when the
activation fixture exhausted its readiness window at the container's 1.5 GiB
memory ceiling without an OOM kill. The same contract had passed for the exact
main candidate, and the workflow retry passed without a source change before
immutable publication.

0.5.10 adds database migration 12 (session context readings), so a 0.5.9
daemon cannot reopen a profile that 0.5.10 has opened. This is a fully
automated publication: no maintainer qualification — fresh-install or upgrade
receipts, an updater journey across this version, or the paid evaluator panel
— was performed, and this record does not claim them. The published assets
and release body remain immutable; this ledger records the completed outcome
separately.

## 0.5.9 publication

**Published and promoted on 2026-09-15.**
[Wisp 0.5.9](https://github.com/Pepewitch/wisp/releases/tag/v0.5.9) is a
regular GitHub release (`draft: false`, `prerelease: false`), published at
07:25:12 UTC with ten release assets. The annotated tag resolves to clean main
commit
[`29a57719b68207882125e977a57a14dcbc850716`](https://github.com/Pepewitch/wisp/commit/29a57719b68207882125e977a57a14dcbc850716),
landed through [PR #222](https://github.com/Pepewitch/wisp/pull/222).

The [release workflow](https://github.com/Pepewitch/wisp/actions/runs/34940849484)
completed all seven jobs successfully:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, native-core, npm, Rust, supply-chain, release-candidate, and public-promotion dry-run checks passed |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| Desktop trust | Developer ID timestamp and hardened runtime, Apple notarization and staple, Gatekeeper, updater signature, and altered-archive rejection passed |
| Public assets | All ten anonymous downloads matched all three checksum sets and clean tagged commit `29a5771`; the downloaded Linux binary reported 0.5.9 at that commit |
| Distribution | Fresh-runner Homebrew audits, four-file promotion, and fixed-URL convergence for both channels passed |

The promotion receipt completed at 07:26:36 UTC with Homebrew tap commit
[`677d7e50e78860ab9a2283be833c718e2df9c1d2`](https://github.com/Pepewitch/homebrew-tap/commit/677d7e50e78860ab9a2283be833c718e2df9c1d2)
and both update channels serving 0.5.9.

The first Linux release job failed before any asset was public when the
activation fixture exhausted its readiness window at the container's 1.5 GiB
memory ceiling without an OOM kill. The same contract had passed for the exact
main candidate, and the workflow retry passed without a source change before
immutable publication.

0.5.9 adds no database migration. This is a fully automated publication: no
maintainer qualification — fresh-install or upgrade receipts, an updater
journey across this version, or the paid evaluator panel — was performed, and
this record does not claim them. The published assets and release body remain
immutable; this ledger records the completed outcome separately.

## 0.5.8 publication

**Published and promoted on 2026-09-14.**
[Wisp 0.5.8](https://github.com/Pepewitch/wisp/releases/tag/v0.5.8) is the latest
regular GitHub release (`draft: false`, `prerelease: false`), published at
08:51:14 UTC with ten release assets. The annotated tag resolves to clean main
commit
[`87ae2cd094a8a9cf7551210fc335e678929ef31e`](https://github.com/Pepewitch/wisp/commit/87ae2cd094a8a9cf7551210fc335e678929ef31e),
landed through [PR #211](https://github.com/Pepewitch/wisp/pull/211) (release
preparation) and [PR #212](https://github.com/Pepewitch/wisp/pull/212)
(activation release-contract fix).

The [release workflow](https://github.com/Pepewitch/wisp/actions/runs/34823302811)
completed all three jobs successfully:

| Gate | Result |
|---|---|
| Source checks | Release preparation and activation-fix PR checks passed across test, browser-security, native-core, npm, Rust, supply-chain, and public-promotion dry-run coverage |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| Desktop trust | Developer ID timestamp and hardened runtime, Apple notarization and staple, Gatekeeper, updater signature, and altered-archive rejection passed |
| Public assets | All ten anonymous downloads matched all three checksum sets and clean tagged commit `87ae2cd`; the downloaded Linux binary reported 0.5.8 at that commit |
| Distribution | Fresh-runner Homebrew audits, four-file promotion, and fixed-URL convergence for both channels passed |

The promotion receipt completed at 08:59:33 UTC with Homebrew tap commit
[`d977c9b0ea47db822caecb1732e0bf667e77a10c`](https://github.com/Pepewitch/homebrew-tap/commit/d977c9b0ea47db822caecb1732e0bf667e77a10c)
and both update channels serving 0.5.8.

An earlier run failed before any asset was public because the activation
fixture repeatedly launched the roughly 70 MB CLI while its daemon initialized
on a one-CPU emulated container. Its effective readiness window expired while
the daemon remained alive. PR #212 replaced that work with a bounded socket
probe, one post-readiness registration, and complete timeout diagnostics. The
unpublished tag was deleted and re-cut per the recovery rule; no public bytes
were replaced.

0.5.8 adds database migrations 10 and 11, so a 0.5.7 daemon cannot reopen a
profile that 0.5.8 has opened. This is a fully automated publication: no
maintainer qualification — fresh-install or upgrade receipts, an updater
journey across this version, or the paid evaluator panel — was performed, and
this record does not claim them. The published assets and release body remain
immutable; this ledger records the completed outcome separately.

## 0.5.7 publication

**Published and promoted on 2026-09-12.**
[Wisp 0.5.7](https://github.com/Pepewitch/wisp/releases/tag/v0.5.7) is the latest
regular GitHub release (`draft: false`, `prerelease: false`), published at
11:31:35 UTC with ten release assets. The annotated tag resolves to clean main
commit
[`0af1b98b85527f3ad30dca6672aff28d9d6f9d9f`](https://github.com/Pepewitch/wisp/commit/0af1b98b85527f3ad30dca6672aff28d9d6f9d9f),
landed through [PR #188](https://github.com/Pepewitch/wisp/pull/188).

The [release workflow](https://github.com/Pepewitch/wisp/actions/runs/34690504009)
completed all three jobs successfully on the first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, native-core, npm, Rust, supply-chain, and public-promotion dry-run checks passed |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| Desktop trust | Developer ID timestamp and hardened runtime, Apple notarization and staple, Gatekeeper, updater signature, and altered-archive rejection passed |
| Public assets | All ten anonymous downloads matched all three checksum sets and clean tagged commit `0af1b98`; the downloaded Linux binary reported 0.5.7 at that commit |
| Distribution | Fresh-runner Homebrew audits, four-file promotion, and fixed-URL convergence for both channels passed |

Promotion completed with Homebrew tap commit
[`7f38831d843e1b8ff4c7eb34190616f3b7137fa6`](https://github.com/Pepewitch/homebrew-tap/commit/7f38831d843e1b8ff4c7eb34190616f3b7137fa6)
pushed at 11:37:44 UTC. Both update channels serve 0.5.7.

0.5.7 adds no database migration. This is a fully automated publication: no
maintainer qualification — fresh-install or upgrade receipts, an updater
journey across this version, or the paid evaluator panel — was performed, and
this record does not claim them. The published assets and release body remain
immutable; this ledger records the completed outcome separately.

## 0.5.6 publication

**Published and promoted on 2026-09-11.**
[Wisp 0.5.6](https://github.com/Pepewitch/wisp/releases/tag/v0.5.6) is the latest
regular GitHub release (`draft: false`, `prerelease: false`), published at
20:09:47 UTC with ten release assets. The annotated tag resolves to clean main
commit
[`20c76c9d493c590d01607b9ae07cc1cf907f4542`](https://github.com/Pepewitch/wisp/commit/20c76c9d493c590d01607b9ae07cc1cf907f4542),
landed through [PR #173](https://github.com/Pepewitch/wisp/pull/173) (release
preparation), [PR #174](https://github.com/Pepewitch/wisp/pull/174), and
[PR #175](https://github.com/Pepewitch/wisp/pull/175) (release-contract fixes).

The [release workflow](https://github.com/Pepewitch/wisp/actions/runs/34641113702)
completed all three jobs successfully:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, native-core, npm, Rust, supply-chain, and public-promotion dry-run checks passed |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| Desktop trust | Developer ID timestamp and hardened runtime, Apple notarization and staple, Gatekeeper, updater signature, and altered-archive rejection passed |
| Public assets | All ten anonymous downloads matched all three checksum sets and clean tagged commit `20c76c9`; the downloaded Linux binary reported 0.5.6 at that commit |
| Distribution | Fresh-runner Homebrew audits, four-file promotion, and fixed-URL convergence for both channels passed |

Promotion completed with Homebrew tap commit
[`9c166fccb1115f51e88cafbde1254815cfbfdfcb`](https://github.com/Pepewitch/homebrew-tap/commit/9c166fccb1115f51e88cafbde1254815cfbfdfcb)
pushed at 20:17:06 UTC. Both update channels serve 0.5.6.

Two earlier runs of the same tag failed before any asset was public and were
diagnosed as release-contract sizing, not product regressions: the installer
test's occupied-port readiness budget (20 attempts) predated the daemon's
embedded UI bundle growing from 2.1 MB to 5.6 MB (#174), and the activation
container's 768 MB cap was sized to the smaller bundle (#175, which also adds
daemon-exit and cgroup reporting to that failure path). Both unpublished tags
were deleted and re-cut per the recovery rule; no public bytes changed.

0.5.6 adds database migration 9 (task workflows), so a 0.5.5 daemon cannot
reopen a profile that 0.5.6 has opened. The run provenance here is the
automated release workflow: no maintainer qualification — fresh-install or
upgrade receipts, an updater journey across this version, or the paid
evaluator panel — was performed for this publication, and this record does not
claim them. The published assets and release body remain immutable; this
ledger records the completed outcome separately.

## 0.5.5 publication

**Published and promoted on 2026-09-11.**
[Wisp 0.5.5](https://github.com/Pepewitch/wisp/releases/tag/v0.5.5) is the latest
regular GitHub release (`draft: false`, `prerelease: false`), published at
05:03:54 UTC with ten release assets. The annotated tag resolves to clean main
commit
[`5f4fd1731a5dc7adf728742a4de491c6f68b85a1`](https://github.com/Pepewitch/wisp/commit/5f4fd1731a5dc7adf728742a4de491c6f68b85a1),
landed through [PR #159](https://github.com/Pepewitch/wisp/pull/159).

The [release workflow](https://github.com/Pepewitch/wisp/actions/runs/34563565288)
completed all three jobs successfully:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, native-core, npm, Rust, supply-chain, and public-promotion dry-run checks passed |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| Desktop trust | Developer ID timestamp and hardened runtime, Apple notarization and staple, Gatekeeper, updater signature, and altered-archive rejection passed |
| Public assets | All ten anonymous downloads matched all three checksum sets and clean tagged commit `5f4fd173`; the downloaded Linux binary reported 0.5.5 at that commit |
| Distribution | Fresh-runner Homebrew audits, four-file promotion, and fixed-URL convergence for both channels passed |

Promotion completed at **05:11:34 UTC**, with Homebrew tap commit
[`179ab6477a73dfe0d0179f9555da89a40f551ada`](https://github.com/Pepewitch/homebrew-tap/commit/179ab6477a73dfe0d0179f9555da89a40f551ada).
Both update channels serve 0.5.5, verified anonymously after promotion.

0.5.5 adds no database migration. No installed daemon service or production
Desktop profile was upgraded for these checks. The published assets and release
body remain immutable; this ledger records the completed outcome separately.

## 0.5.4 publication

**Published and promoted on 2026-09-10.**
[Wisp 0.5.4](https://github.com/Pepewitch/wisp/releases/tag/v0.5.4) is the latest
regular GitHub release (`draft: false`, `prerelease: false`), published at
13:09:42 UTC with ten release assets. The annotated tag resolves to clean main
commit
[`62b56551ca6b485c1c7cd1436af7b08b6980099e`](https://github.com/Pepewitch/wisp/commit/62b56551ca6b485c1c7cd1436af7b08b6980099e),
landed through [PR #148](https://github.com/Pepewitch/wisp/pull/148).

The [release workflow](https://github.com/Pepewitch/wisp/actions/runs/34479036157)
completed all three jobs successfully:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, native-core, npm, Rust, supply-chain, and public-promotion dry-run checks passed |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| Desktop trust | Developer ID timestamp and hardened runtime, Apple notarization and staple, Gatekeeper, updater signature, and altered-archive rejection passed |
| Public assets | All ten anonymous downloads matched all three checksum sets and clean tagged commit `62b56551`; the downloaded Linux binary reported 0.5.4 at that commit |
| Distribution | Fresh-runner Homebrew audits, four-file promotion, and fixed-URL convergence for both channels passed |

Promotion completed at **13:14:38 UTC**, with Homebrew tap commit
[`0e9f323f51a1b1cf3a00e903454ae0cbec231756`](https://github.com/Pepewitch/homebrew-tap/commit/0e9f323f51a1b1cf3a00e903454ae0cbec231756).
Both update channels serve 0.5.4, verified anonymously after promotion.

0.5.4 adds no database migration. No installed daemon service or production
Desktop profile was upgraded for these checks. The published assets and release
body remain immutable; this ledger records the completed outcome separately.

## 0.5.3 publication

**Published and promoted on 2026-09-10.**
[Wisp 0.5.3](https://github.com/Pepewitch/wisp/releases/tag/v0.5.3) is the latest
regular GitHub release (`draft: false`, `prerelease: false`), published at
07:28:11 UTC with ten assets. The annotated tag resolves to clean main commit
[`e75ba0a74a35206e71f6f3b3f303f009e11a3a6b`](https://github.com/Pepewitch/wisp/commit/e75ba0a74a35206e71f6f3b3f303f009e11a3a6b),
landed through [PR #129](https://github.com/Pepewitch/wisp/pull/129).

The [release workflow](https://github.com/Pepewitch/wisp/actions/runs/34448556586)
completed all three jobs successfully:

| Gate | Result |
|---|---|
| Source checks | 64 root, 1,137 daemon, 721 UI tests; lint/types, docs, workflow pins, browser and supply-chain checks, the native core gate, and the promotion dry run all passed on the release commit |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| Desktop trust | Developer ID timestamp and hardened runtime, Apple notarization and staple, Gatekeeper, updater signature, and altered-archive rejection passed |
| Public assets | All ten anonymous downloads matched all three checksum sets and the clean tagged source |
| Distribution | Fresh-runner Homebrew audits, four-file promotion, and fixed-URL convergence for both channels passed |

Promotion completed at **07:33:58 UTC**, with Homebrew tap commit
[`c6d87c71af7d39a667f07e6a4128246c9973778f`](https://github.com/Pepewitch/homebrew-tap/commit/c6d87c71af7d39a667f07e6a4128246c9973778f).
Both update channels serve 0.5.3, verified anonymously after promotion.

0.5.3 adds database migration 8, so a 0.5.2 daemon cannot reopen a profile
that 0.5.3 has opened.

This record was written separately from the release. The agent driving the
release published and promoted it successfully, then its harness lost network
access (`getaddrinfo ENOTFOUND api2.cursor.sh`) before recording the outcome,
so the ledger entry was completed by hand from the workflow run, the promotion
receipt, and the public release. Nothing about the published artifacts changed;
the gap was in the evidence record, which is exactly what this ledger is for.

No installed daemon service or production Desktop profile was upgraded for
these checks. The published assets and release body remain immutable; this
ledger records the completed outcome separately.

## 0.5.2 publication

**Published and promoted on 2026-09-10.**
[Wisp 0.5.2](https://github.com/Pepewitch/wisp/releases/tag/v0.5.2) was published as a
regular GitHub release (`draft: false`, `prerelease: false`), published at
03:57:43 UTC with ten assets. The annotated tag resolves to clean main commit
[`4d54ae762714e28216f6996484e2413951b597bf`](https://github.com/Pepewitch/wisp/commit/4d54ae762714e28216f6996484e2413951b597bf),
landed through [PR #121](https://github.com/Pepewitch/wisp/pull/121).

The [release workflow](https://github.com/Pepewitch/wisp/actions/runs/34433983057)
completed all three jobs successfully:

| Gate | Result |
|---|---|
| Source checks | 58 root, 1,112 daemon, 655 UI tests; lint/types, docs, workflow pins, browser and supply-chain checks, and the native core gate passed on the release commit |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| Desktop trust | Developer ID timestamp and hardened runtime, Apple notarization and staple, Gatekeeper, updater signature, and altered-archive rejection passed |
| Public assets | All ten anonymous downloads matched all three checksum sets and the clean tagged source |
| Distribution | Fresh-runner Homebrew audits, four-file promotion, fixed-URL convergence for both channels, and post-promotion livecheck passed |

The promotion receipt records completion at **04:03:53 UTC**, with Homebrew tap
commit [`5015d2e85d34f9fafc7192d37ce6596ce7495cd9`](https://github.com/Pepewitch/homebrew-tap/commit/5015d2e85d34f9fafc7192d37ce6596ce7495cd9).

No installed daemon service or production Desktop profile was upgraded for
these checks. The published assets and release body remain immutable; this
ledger records the completed outcome separately.

## 0.5.1 publication

**Published and promoted on 2026-09-09.**
[Wisp 0.5.1](https://github.com/Pepewitch/wisp/releases/tag/v0.5.1) was published as a
regular GitHub release (`draft: false`, `prerelease: false`), published at
17:26:39 UTC with ten assets. The annotated tag resolves to clean main commit
[`c81c04e9a92bb2a88c2a941ce5756a64c476c1b1`](https://github.com/Pepewitch/wisp/commit/c81c04e9a92bb2a88c2a941ce5756a64c476c1b1),
landed through [PR #114](https://github.com/Pepewitch/wisp/pull/114).

The [release workflow](https://github.com/Pepewitch/wisp/actions/runs/34381686733)
completed all three jobs successfully:

| Gate | Result |
|---|---|
| Source checks | 47 root, 1,036 daemon, 641 UI tests; lint/types, docs, workflow pins, browser and supply-chain checks, and the native core gate passed on the release commit |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks over 53.43 MB; shared UI, Linux daemon, macOS daemon, and clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| Desktop trust | Developer ID timestamp and hardened runtime, Apple notarization and staple, Gatekeeper, updater signature, and altered-archive rejection passed |
| Public assets | All ten anonymous downloads matched all three checksum sets and the clean tagged source |
| Distribution | Fresh-runner Homebrew audits, four-file promotion, fixed-URL convergence for both channels, and post-promotion livecheck passed |

The promotion receipt records completion at **17:31:10 UTC**, with Homebrew tap
commit [`e46bb5ded3595c653747674a9739139bafd27dd0`](https://github.com/Pepewitch/homebrew-tap/commit/e46bb5ded3595c653747674a9739139bafd27dd0).

0.5.1 is the first release promoted under the four-file tap contract, so it
published `updates/wisp-daemon.json` for the first time. That URL returned
`404` for the whole 0.5.0 period, which meant the daemon update discovery and
`wisp update` shipped in 0.5.0 could not resolve a version. Both channel URLs
now return `200` and serve 0.5.1, verified anonymously after promotion. The
[promotion dry run](https://github.com/Pepewitch/wisp/actions/runs/34381614758)
independently re-derived v0.5.1 from the tap and reproduced all four files
byte for byte (`tapState=already-promoted`).

No installed daemon service or production Desktop profile was upgraded for
these checks. The published assets and release body remain immutable; this
ledger records the completed outcome separately.

## 0.5.0 publication

**Published and promoted on 2026-09-09.**
[Wisp 0.5.0](https://github.com/Pepewitch/wisp/releases/tag/v0.5.0) was published as a
regular GitHub release (`draft: false`, `prerelease: false`), with ten assets.
The annotated tag resolves to clean main commit
[`6cd3cef4587fe0570d3737f5061e73f8f3b58c23`](https://github.com/Pepewitch/wisp/commit/6cd3cef4587fe0570d3737f5061e73f8f3b58c23),
landed through [PR #104](https://github.com/Pepewitch/wisp/pull/104).

The [release workflow](https://github.com/Pepewitch/wisp/actions/runs/34341499608)
completed all three jobs successfully:

| Gate | Result |
|---|---|
| Source checks | 42 root, 1,021 daemon, 635 UI tests; lint/types, docs, workflow pins, brand, 20 smoke scenarios, 12 evaluator unit tests, 20 real Chrome checks; native and packaged-app gates passed |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and clean unsigned Desktop rebuilds matched |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| Desktop trust | Developer ID timestamp and hardened runtime, Apple notarization and staple, Gatekeeper, updater signature, and altered-archive rejection passed |
| Public assets | All ten anonymous downloads matched all three checksum sets and the clean tagged source; the downloaded macOS daemon reported 0.5.0 at that commit |
| Distribution | Fresh-runner Homebrew audits, Formula/Cask/channel promotion, fixed-URL convergence, and post-promotion livecheck passed |

The promotion receipt records completion at **11:03:17 UTC**, with Homebrew tap
commit [`a1724ced4202a891a57d51cfc59b32919246e968`](https://github.com/Pepewitch/homebrew-tap/commit/a1724ced4202a891a57d51cfc59b32919246e968).
An independent anonymous download verified the checksums and public Desktop's
Apple trust and updater signature. The public Formula, Cask, and fixed Desktop
channel exactly matched rendering from those verified 0.5.0 manifests.
The legacy alpha channel name is preserved so existing 0.4 clients can discover
the regular 0.5.0 version.

No installed daemon service or production Desktop profile was upgraded for
these checks. The published assets and release body remain immutable; this
ledger records the completed outcome separately.

## Evidence inherited from the merged review fixes

- Full daemon, UI, and root suites; native Rust formatting, lint, and tests;
  smoke tests; actual Chrome authenticated terminal and media checks passed.
- A packaged ad-hoc macOS build and isolated WKWebView exercised the shared UI.
  This is not a full installed native-app onboarding or updater journey.
- Synthetic same-path offline restore preserved unpublished Git state,
  task history and attachments. CLI archive/export/purge checks passed.
- A fixture-only 100-workload admission exercise accepted steering, refused a
  101st workload, remained responsive, and stopped all fixture groups. This
  does not establish real provider throughput or suitable RAM for 100 agents.
- Removing the unused component-generator dependency graph left the generated
  CSS unchanged. The npm audit returned no advisories. Hosted Rust audit still
  reports six maintenance notices and one glib unsoundness warning; glib and
  proc-macro-error are absent from the macOS normal/build dependency tree.

## Still unqualified or outside scope

- Human-observed in-app installation, relaunch, state preservation, and
  Homebrew receipt reconciliation for 0.4-to-0.5, for 0.5.0-to-0.5.1, and for
  0.5.1-to-0.5.2. The historical alpha.12-to-alpha.13 journey passed on one
  Mac; it does not qualify any 0.5 release automatically.
- A human-observed cross-harness switch on every supported harness, and the
  0.5.1 database migration 6 and 0.5.2 migration 7 upgrades against a large
  production profile. Both migrations are covered by automated tests only.
- Complete fresh-machine real-provider activation, Linux upgrade/rollback,
  every macOS version above the configured minimum, and cross-machine restore.
- Multi-user authorization, agent sandboxing, forensic data deletion, and an
  assurance of zero security issues. None is provided by this release.

Historical receipts remain in the [v0.4 ledger](../v0.4/QUALIFICATION.md).
