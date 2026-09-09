# Wisp 0.5 qualification

This ledger separates release evidence from the version label. 0.5.0 is a
regular pre-1.0 release, not a claim of exhaustive security or platform coverage.

## 0.5.0 publication

Pending at source preparation: source checks, clean annotated main tag,
reproducible daemon and unsigned Desktop artifacts, signed/notarized Desktop,
anonymous ten-asset verification, updater tamper rejection, and Homebrew plus
fixed-channel promotion. Record the workflow and immutable source after these
checks finish. Do not modify a published release body or replace its assets.

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
