# Wisp 0.6 qualification

This ledger separates release evidence from the version label. The 0.6 releases
are regular pre-1.0 releases, not a claim of exhaustive security or platform
coverage. 0.6.9 is the current release; earlier 0.6 records are retained
below. The 0.5 records remain in
[the 0.5 ledger](../v0.5/QUALIFICATION.md).

The tested limits, remaining platform gaps and native dependency advisory scope
recorded for 0.5 under
[Still unqualified or outside scope](../v0.5/QUALIFICATION.md#still-unqualified-or-outside-scope)
still apply to 0.6.9.

## 0.6.9 publication

**Published and promoted on 2026-10-09.**
[Wisp 0.6.9](https://github.com/Pepewitch/wisp/releases/tag/v0.6.9) is the
latest regular GitHub release (`draft: false`, `prerelease: false`), published
at 09:56:04 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`6d7dd68d982353bc9b91b7f231d2f2e1f502e46a`](https://github.com/Pepewitch/wisp/commit/6d7dd68d982353bc9b91b7f231d2f2e1f502e46a),
landed through [PR #378](https://github.com/Pepewitch/wisp/pull/378). It carries
per-model task brief, auto-fix and auto-merge defaults, with the brief now on
by default ([#377](https://github.com/Pepewitch/wisp/pull/377)); the
`ultracode` Claude effort level
([#376](https://github.com/Pepewitch/wisp/pull/376)); and a Desktop composer
that keeps `--` as typed ([#371](https://github.com/Pepewitch/wisp/pull/371)).
It also carries the source-map-js and KaTeX advisory fixes
([#379](https://github.com/Pepewitch/wisp/pull/379)) and the other changes
listed in the release notes since 0.6.8.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/37913293701)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/37913087502) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `6d7dd68` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 09:58:18 UTC with Homebrew tap commit
[`03f9c7f6438b9fa15d98dba230c7db645b9d4978`](https://github.com/Pepewitch/homebrew-tap/commit/03f9c7f6438b9fa15d98dba230c7db645b9d4978).
The Formula, Cask, daemon update channel, and Desktop update channel all serve
0.6.9.

0.6.9 adds no database migration. No PNG asset or brand-generator input changed
since 0.6.8, so the PNG assets were not re-rendered. Before tagging, the local
`release:check` passed at release-branch commit `56ffaa1` (squashed into
`6d7dd68`). Its first run, on the branch before the advisory fix landed,
failed one UI test on a 5-second timeout in code the release did not change;
every later run passed. The release PR's `npm` advisory check failed on newly
published source-map-js and KaTeX advisories until #379 landed on `main` and
the release branch was rebased onto it.

This is a fully automated publication: no maintainer qualification was
performed, and this record does not claim any. That covers fresh-install or
upgrade receipts, a Desktop updater journey across this version, per-model
defaults set in the published Desktop or Browser app and applied to a new task,
a live Claude turn at `ultracode` effort against the published daemon, typing
`--` in the published Desktop composer under the macOS smart-dashes setting,
Mermaid math rendered with KaTeX 0.18 in the published bundles, the
token-spending harness probes, and the paid evaluator panel. The published
assets and release body remain immutable; this ledger records the completed
outcome separately.

## 0.6.8 publication

**Published and promoted on 2026-10-04.**
[Wisp 0.6.8](https://github.com/Pepewitch/wisp/releases/tag/v0.6.8) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 07:38:45 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`6127ae06e4c5afcd156ce8de730b2fb06c84f332`](https://github.com/Pepewitch/wisp/commit/6127ae06e4c5afcd156ce8de730b2fb06c84f332),
landed through [PR #369](https://github.com/Pepewitch/wisp/pull/369). It carries
image outputs from agents, shown under the turn's reply in Browser and
Desktop and listed and saved by the CLI
([#368](https://github.com/Pepewitch/wisp/pull/368)); text attachments that
open in a viewer, with csv and tsv row previews
([#366](https://github.com/Pepewitch/wisp/pull/366)); and tool activity titled
by its description ([#367](https://github.com/Pepewitch/wisp/pull/367)). It
also carries the other changes listed in the release notes since 0.6.7.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/37185968395)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/37185878832) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `6127ae0` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 07:40:51 UTC with Homebrew tap commit
[`4d1b653fa2961bccc308d21f2e58b0344c2d87ef`](https://github.com/Pepewitch/homebrew-tap/commit/4d1b653fa2961bccc308d21f2e58b0344c2d87ef).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.6.8 until 0.6.9 was promoted.

0.6.8 adds database migration 22, so a 0.6.7 daemon cannot reopen a profile that
0.6.8 has opened. No PNG asset or brand-generator input changed since 0.6.7, so
the PNG assets were not re-rendered. Before tagging, the local `release:check`
passed on its first run at release-branch commit `d218846` (squashed into
`6127ae0`).

This is a fully automated publication: no maintainer qualification was
performed, and this record does not claim any. That covers fresh-install or
upgrade receipts, a Desktop updater journey across this version, migration 22
applied to an existing profile by the published daemon, a live image output
captured from Codex or Claude or published with `wisp output add` against the
published daemon, text and csv attachment previews and native image Save in
the published Desktop app, the token-spending harness probes, and the paid
evaluator panel. The published assets and release body remain immutable; this
ledger records the completed outcome separately.

## 0.6.7 publication

**Published and promoted on 2026-10-02.**
[Wisp 0.6.7](https://github.com/Pepewitch/wisp/releases/tag/v0.6.7) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 23:00:33 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`59c28ec519a0cb1c5158558b05616b1f98fd9e3d`](https://github.com/Pepewitch/wisp/commit/59c28ec519a0cb1c5158558b05616b1f98fd9e3d),
landed through [PR #362](https://github.com/Pepewitch/wisp/pull/362). It carries
the spirit as Wisp's mark: the Desktop app icon, the PWA icons, the favicon
and the top-bar mark ([#359](https://github.com/Pepewitch/wisp/pull/359)); one
motion vocabulary: tooltips that unfold, popups that grow from their trigger,
and a composer that grows with its draft
([#358](https://github.com/Pepewitch/wisp/pull/358)); and connection tabs that
carry one mark, their connection's health
([#364](https://github.com/Pepewitch/wisp/pull/364)). It also carries the other
changes listed in the release notes since 0.6.6, among them DOMPurify 3.4.16
([#363](https://github.com/Pepewitch/wisp/pull/363)).

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/37074523689)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/37074260302) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `59c28ec` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 23:04:04 UTC with Homebrew tap commit
[`d1322909a4cb8adf56f9c7868690285e4a147b5c`](https://github.com/Pepewitch/homebrew-tap/commit/d1322909a4cb8adf56f9c7868690285e4a147b5c).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.6.7 until 0.6.8 was promoted.

Before tagging, the local `release:check` passed at release-branch commit
`e865dc0` (squashed into `59c28ec`). Three earlier runs on 2026-10-02 had
failed its `check` gate, each on different subprocess-heavy tests at the
5-second timeout, while the machine carried a load average of 11 to 35 from
other work. The same tests passed alone and in CI, and the passing run was
on a quiet machine.

0.6.7 adds no database migration. `brand/`, `desktop/src-tauri/icons/`, and
`scripts/brand/` changed since 0.6.6, so `release:check` rendered every PNG
brand asset with headless Chrome and verified it against the committed file;
the brand gate passed. This is a fully automated publication: no maintainer
qualification was performed, and this record does not claim any. That covers
fresh-install or upgrade receipts, a Desktop updater journey across this
version, a look at the new app icon and the motion in the published Desktop
app, the token-spending harness probes, and the paid evaluator panel. The published assets
and release body remain immutable; this ledger records the completed outcome
separately.

## 0.6.6 publication

**Published and promoted on 2026-09-30.**
[Wisp 0.6.6](https://github.com/Pepewitch/wisp/releases/tag/v0.6.6) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 10:54:41 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`73a777fc68c8ce5ef649d0dfc04002a27de987e0`](https://github.com/Pepewitch/wisp/commit/73a777fc68c8ce5ef649d0dfc04002a27de987e0),
landed through [PR #355](https://github.com/Pepewitch/wisp/pull/355). It carries
the Autopilot tab: the brief on top, then the auto-merge and auto-fix
switches with their live status and history
([#354](https://github.com/Pepewitch/wisp/pull/354)); a GitHub budget that keeps
Wisp to a quarter of the hourly limit
([#347](https://github.com/Pepewitch/wisp/pull/347)); and Claude turns that
finish while a background process keeps running
([#349](https://github.com/Pepewitch/wisp/pull/349)). It also carries the other
changes listed in the release notes since 0.6.5.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/36704454640)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/36704246492) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `73a777f` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 10:56:45 UTC with Homebrew tap commit
[`2d38d80f5fe3b1177dc72a53826df05c05f90f87`](https://github.com/Pepewitch/homebrew-tap/commit/2d38d80f5fe3b1177dc72a53826df05c05f90f87).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.6.6 until 0.6.7 was promoted.

0.6.6 adds database migrations 20 and 21, so a 0.6.5 daemon cannot reopen a
profile that 0.6.6 has opened. No PNG asset or brand-generator input changed
since 0.6.5, so the PNG assets were not re-rendered. This is a fully automated
publication: no maintainer qualification — fresh-install or upgrade receipts, a
Desktop updater journey across this version, the token-spending harness probes,
or the paid evaluator panel — was performed, and this record does not claim
them. The published assets and release body remain immutable; this ledger
records the completed outcome separately.

No one ran this release's headline changes against the published build: the
Autopilot tab on an installed Desktop app, the GitHub budget against a real
rate limit, and a Claude dev server outliving its turn on the published daemon.
Each was exercised in review against fakes, the gallery, or a throwaway
development daemon.

## 0.6.5 publication

**Published and promoted on 2026-09-29.**
[Wisp 0.6.5](https://github.com/Pepewitch/wisp/releases/tag/v0.6.5) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 20:40:43 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`40d44f1e1c56c5e1d12214c66ce67758d215a7d9`](https://github.com/Pepewitch/wisp/commit/40d44f1e1c56c5e1d12214c66ce67758d215a7d9),
landed through [PR #338](https://github.com/Pepewitch/wisp/pull/338). It carries
a daemon that stays up: idle terminal shells no longer freeze it
([#319](https://github.com/Pepewitch/wisp/pull/319)), one malformed harness
line no longer crashes it ([#317](https://github.com/Pepewitch/wisp/pull/317)),
it stops gracefully and asks before an update interrupts running tasks
([#330](https://github.com/Pepewitch/wisp/pull/330)), and it runs on Bun 1.4.2
([#329](https://github.com/Pepewitch/wisp/pull/329)). It also contains
agent-written diagrams and HTML ([#328](https://github.com/Pepewitch/wisp/pull/328)),
hardens Desktop ([#321](https://github.com/Pepewitch/wisp/pull/321)), opens
finished tasks and runs search without stalling the daemon
([#332](https://github.com/Pepewitch/wisp/pull/332),
[#336](https://github.com/Pepewitch/wisp/pull/336)), and carries the other
changes listed in the release notes since 0.6.4.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/36626985549)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/36626775506) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; web and Desktop UI bundles, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `40d44f1` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 20:42:44 UTC with Homebrew tap commit
[`8c608d35095df08f567f5704ddfd35e67023de1f`](https://github.com/Pepewitch/homebrew-tap/commit/8c608d35095df08f567f5704ddfd35e67023de1f).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.6.5 until 0.6.6 was promoted.

0.6.5 adds database migrations 16–19, so a 0.6.4 daemon cannot reopen a profile
that 0.6.5 has opened. `brand/README.md` and `scripts/brand/mark.ts` changed
since 0.6.4, so release:check re-rendered the PNG assets and verified that none
was stale. This is a fully
automated publication: no maintainer qualification — fresh-install or upgrade
receipts, a Desktop updater journey across this version, the token-spending
harness probes, or the paid evaluator panel — was performed, and this record
does not claim them. The published assets and release body remain immutable;
this ledger records the completed outcome separately.

No one ran this release's headline changes against the published build: the
idle-shell fix with more shells than CPU cores, the update confirmation with a
task running, and Desktop's navigation policy, proxy bypass and
corrupt-connections recovery on an installed app. Those Desktop paths were
launch-tested only on a local pre-release build during review.

## 0.6.4 publication

**Published and promoted on 2026-09-28.**
[Wisp 0.6.4](https://github.com/Pepewitch/wisp/releases/tag/v0.6.4) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 10:15:17 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`e5b51eb591e18be527eb72e1ff9ffb4180f781fb`](https://github.com/Pepewitch/wisp/commit/e5b51eb591e18be527eb72e1ff9ffb4180f781fb),
landed through [PR #307](https://github.com/Pepewitch/wisp/pull/307). It
carries optional task briefs and the `<wisp>` input section
([#305](https://github.com/Pepewitch/wisp/pull/305)), a gzip-served first load
and lighter background work
([#304](https://github.com/Pepewitch/wisp/pull/304)), one status mark per
Desktop connection tab ([#306](https://github.com/Pepewitch/wisp/pull/306)),
terminal descriptor and compiled-daemon memory fixes
([#301](https://github.com/Pepewitch/wisp/pull/301)) and the other changes
listed in the release notes since 0.6.3.

The
[release workflow](https://github.com/Pepewitch/wisp/actions/runs/36407584702)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/36407403105) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `e5b51eb` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 10:17:19 UTC with Homebrew tap commit
[`3ec17d3247a2603636d256d85503011ff5a5bc7e`](https://github.com/Pepewitch/homebrew-tap/commit/3ec17d3247a2603636d256d85503011ff5a5bc7e).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.6.4 until 0.6.5 was promoted.

0.6.4 adds database migrations 14 and 15, so a 0.6.3 daemon cannot reopen a
profile that 0.6.4 has opened. `brand/README.md` and `scripts/brand/` changed
since 0.6.3, so release:check rendered the PNG assets with headless Chrome on
macOS and verified that every one matched. This is a fully automated
publication: no maintainer qualification — fresh-install or upgrade receipts,
a Desktop updater journey across this version, a task brief published through
the released daemon or shown in packaged Desktop, the token-spending harness
probes, or the paid evaluator panel — was performed, and this record does not
claim them. The published assets and release body remain immutable; this
ledger records the completed outcome separately.

## 0.6.3 publication

**Published and promoted on 2026-09-26.**
[Wisp 0.6.3](https://github.com/Pepewitch/wisp/releases/tag/v0.6.3) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
at 13:29:31 UTC with ten release assets. The annotated tag resolves to clean
main commit
[`765ec7738e41b776814660321dc1c698672e189f`](https://github.com/Pepewitch/wisp/commit/765ec7738e41b776814660321dc1c698672e189f),
landed through [PR #302](https://github.com/Pepewitch/wisp/pull/302). It
carries daemon-owned shell tabs with a tab menu and find
([#300](https://github.com/Pepewitch/wisp/pull/300)), the usage ring's
shortest-window rule and turn-end refresh
([#297](https://github.com/Pepewitch/wisp/pull/297)), steady connection tabs
during stream handoffs ([#298](https://github.com/Pepewitch/wisp/pull/298)),
Desktop's first-launch focus and zoom
([#299](https://github.com/Pepewitch/wisp/pull/299)) and the other changes
listed in the release notes since 0.6.2.

The [release workflow](https://github.com/Pepewitch/wisp/actions/runs/36244873056)
completed every job successfully on its first run:

| Gate | Result |
|---|---|
| Source checks | Release PR test, browser-security, Linux-contract, supply-chain, update-verifier, and public-promotion dry-run checks passed; the exact-main [release candidate](https://github.com/Pepewitch/wisp/actions/runs/36244791656) also passed Linux-contract and update-verifier before tagging |
| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |
| Linux installation | Published-artifact installer and fixture activation contracts passed |
| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |
| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit `765ec77` were verified |
| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |

Promotion completed at 13:31:32 UTC with Homebrew tap commit
[`d24bc42bbfe677f8ef76b1f7067206c30513bf11`](https://github.com/Pepewitch/homebrew-tap/commit/d24bc42bbfe677f8ef76b1f7067206c30513bf11).
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.6.3 until 0.6.4 was promoted.

0.6.3 adds no database migration. Local brand checks ran without Chrome, so
the PNG assets were checked only in tag CI; no PNG asset changed since 0.6.2.
This is a fully automated publication: no maintainer qualification —
fresh-install or upgrade receipts, a Desktop updater journey across this
version (including the first-launch focus and zoom), shell-tab close and
restart on the published daemon or packaged Desktop, the token-spending
harness probes, or the paid evaluator panel — was performed, and this record
does not claim them. The published assets and release body remain immutable;
this ledger records the completed outcome separately.

## 0.6.2 publication

**Published and promoted on 2026-09-25.**
[Wisp 0.6.2](https://github.com/Pepewitch/wisp/releases/tag/v0.6.2) is a
regular GitHub release (`draft: false`, `prerelease: false`), published
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
The Formula, Cask, daemon update channel, and Desktop update channel all served
0.6.2 until 0.6.3 was promoted.

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
