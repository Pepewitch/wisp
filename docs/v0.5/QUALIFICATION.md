# Wisp 0.5 qualification

This ledger separates release evidence from the version label. The 0.5 releases
are regular pre-1.0 releases, not a claim of exhaustive security or platform
coverage. 0.5.4 is the current release; earlier 0.5 records are retained below.

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
