# Wisp 0.5 qualification

This ledger separates release evidence from the version label. 0.5.0 is a
regular pre-1.0 release, not a claim of exhaustive security or platform coverage.

## 0.5.0 publication

**Published and promoted on 2026-09-09.**
[Wisp 0.5.0](https://github.com/Pepewitch/wisp/releases/tag/v0.5.0) is the latest
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

- Human-observed 0.4-to-0.5 in-app installation, relaunch, state preservation,
  and Homebrew receipt reconciliation. The historical alpha.12-to-alpha.13
  journey passed on one Mac; it does not qualify 0.5.0 automatically.
- Complete fresh-machine real-provider activation, Linux upgrade/rollback,
  every macOS version above the configured minimum, and cross-machine restore.
- Multi-user authorization, agent sandboxing, forensic data deletion, and an
  assurance of zero security issues. None is provided by this release.

Historical receipts remain in the [v0.4 ledger](../v0.4/QUALIFICATION.md).
