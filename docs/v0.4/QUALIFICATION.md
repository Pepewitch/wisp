# Wisp v0.4 release qualification

This is the mutable, sanitized qualification ledger for public v0.4 releases.
Git tags, GitHub release assets, and the release body remain immutable. Add new
evidence here after publication instead of rewriting those public artifacts or
inferring success from a green build.

Raw logs, screenshots, machine paths, account details, task data, and production
state do not belong in this repository. Retain those in the approved private
release record; this ledger contains only the minimum facts needed to support a
public claim.

## Current status

| Release | Immutable publication | Homebrew and Desktop channel | Human updater journey |
| --- | --- | --- | --- |
| `0.4.0-alpha.12` | Passed from `b486dea2fdcf6c57306ef1aef6af7f9b541fa1ac` | Passed at tap `f838aef032147618a5b372107fc21a97b82ff7e5` | Bootstrap release; no older updater-capable version existed |
| `0.4.0-alpha.13` | Passed from `8fb6065b902b66d88dd3a569989442b8b1296a9a` | Passed at tap `4fbb81e136043605f8b7865fa97fddb15dbc063f` | Alpha.12 → alpha.13 passed on one Apple Silicon Mac |
| `0.4.0-alpha.16` | Passed from `3a34ecb2175e5198eaf510cc017e936e4655addb` | Passed at tap `520943acf0ebc3b7a8f871444d9e7497f8eb1489` | Alpha.13 → alpha.16 pending |

“Passed” for immutable publication means the exact ten public assets matched
their checksum sets, the Desktop updater signature accepted the archive and
rejected changed bytes, and the extracted app passed Developer ID,
notarization, staple, and Gatekeeper checks. “Passed” for promotion means the
Formula, Cask, and fixed Desktop channel advanced together and strict online
audits, including post-push livecheck, passed.

The alpha.12-to-alpha.13 result is one-machine evidence, not broad support for
every Apple Silicon model or every macOS version allowed by the configured
minimum.

## Recording a two-version updater receipt

Add a row only after observing all of the following against two immutable
public versions:

1. The older signed app discovers the expected newer version and bounded
   release notes through **Updates → Check now**.
2. The Desktop row remains separate from the selected daemon row.
3. **Update Desktop and relaunch** downloads, verifies, replaces, and relaunches
   the app without asking the webview to choose a URL, signature, or key.
4. Connections, projects, selected task, task history, daemon state, branches,
   worktrees, and user changes remain present.
5. The replaced app reports the new version and passes `codesign`, stapler, and
   Gatekeeper assessment.
6. A deliberately invalid updater signature leaves the older app runnable when
   the release changes the updater, trust root, channel, or installer.
7. Homebrew receipt reconciliation reaches the same public version without a
   downgrade.

Record the old and new versions, release and tap commits, Apple Silicon/macOS
scope, checks that passed, and any unrun or failed gate. Do not summarize a
partial journey as qualification.
