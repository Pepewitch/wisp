#!/usr/bin/env bun
// Scaffolds the release notes for a version: the required sections, the exact
// ten-asset list, and one bullet per pull request merged since the previous
// tag. The prose is the part that needs judgment, so this writes a draft with
// TODO markers rather than pretending to write it.
//
// Copying the previous release's notes by hand is how a stale version number
// reaches an immutable release body.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTaggableVersion } from "./release-versions";
import { expectedReleaseAssets, releaseNotesPath } from "./release-promotion";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

interface MergedChange {
  subject: string;
  pull: string | null;
}

function run(args: string[]): string {
  const result = Bun.spawnSync({ cmd: args, cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${Buffer.from(result.stderr).toString("utf8").trim()}`);
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
}

export function previousReleaseTag(): string {
  const tags = run(["git", "tag", "--list", "v*", "--sort=-v:refname"])
    .split(/\r?\n/)
    .filter(Boolean);
  const previous = tags[0];
  if (!previous) throw new Error("no v* tag found to describe changes since");
  return previous;
}

export function parseMergedChanges(log: string): MergedChange[] {
  return log
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const pull = /\(#(\d+)\)\s*$/.exec(line);
      return {
        subject: line.replace(/\s*\(#\d+\)\s*$/, ""),
        pull: pull ? pull[1]! : null,
      };
    });
}

export function renderReleaseNotes(version: string, since: string, changes: MergedChange[]): string {
  const bullets = changes.length
    ? changes
        .map((change) => `- TODO describe for users: ${change.subject}${change.pull ? ` (#${change.pull})` : ""}`)
        .join("\n")
    : "- TODO no merged changes were found since the previous tag";
  const assets = expectedReleaseAssets(version)
    .map((asset) => `- \`${asset}\``)
    .join("\n");
  return `# Wisp ${version}

TODO one paragraph: what this release is, and the two or three things a user
would notice. Say what it is, not that it is exciting.

## What changed since ${since.replace(/^v/, "")}

${bullets}

## Install or upgrade

Apple Silicon macOS (12.3 configured minimum):

\`\`\`sh
brew install --cask Pepewitch/tap/wisp-desktop
open -a Wisp
\`\`\`

The Cask installs the separate daemon Formula as a dependency. Existing
updater-capable Desktop builds can use **Updates → Check now**, then **Update
Desktop and relaunch**. Update **Local daemon** separately. The legacy alpha
channel URL remains compatible and advertises the regular ${version} version.
For Homebrew recovery or older builds without an updater:

\`\`\`sh
brew update
brew upgrade Pepewitch/tap/wisp
brew upgrade --cask --greedy Pepewitch/tap/wisp-desktop
brew services restart wisp
open -a Wisp
\`\`\`

Linux (Ubuntu 24.04 LTS, x86_64, glibc):

\`\`\`sh
curl --proto '=https' --tlsv1.2 -fsSL \\
  https://raw.githubusercontent.com/Pepewitch/wisp/v${version}/scripts/install.sh | sh
\`\`\`

Back up task state **and the original Git repositories** before upgrading.
Follow [backup and restore](https://github.com/Pepewitch/wisp/blob/v${version}/docs/INSTALL.md#back-up-and-restore-a-wisp-home); copying \`.wisp\`
alone does not preserve linked worktrees or unpublished Git objects.
TODO state any database migration this release adds, and which older daemon
version can no longer reopen the profile. Delete this line if there is none.

## Scope and known limits

This release is for a trusted single OS user. Worktrees separate checkouts;
they do not sandbox agents or their credentials. There is no multi-user
permission boundary. Closing Desktop leaves daemons and agents running.
Intel macOS and non-Apple-Silicon Desktop builds are unsupported.

Desktop publication requires Developer ID signing, notarization, a stapled
ticket, and a verified updater signature. The macOS daemon remains ad-hoc
signed. Automated release gates verify immutable downloads and promote the
Formula, Cask, daemon channel, and Desktop channel together. At source
preparation, the ${version} artifact gates are pending; the [qualification ledger](https://github.com/Pepewitch/wisp/blob/main/docs/v0.5/QUALIFICATION.md)
records the final outcome separately from these immutable release notes.

TODO limits specific to this release, then keep the standing ones below.
Native dependency advisories still include upstream maintenance notices and a
locked Linux-only glib warning. Full clean-machine provider journeys, a
human-observed Desktop upgrade across this version, broad OS coverage, and
cross-machine restore remain incomplete. Task export excludes repositories and
provider sessions; it is not a complete backup or an import format. Permanent
deletion is logical, not forensic erasure. This release is not a security
certification.

## Release assets

The release contains these ten immutable assets:

${assets}
`;
}

if (import.meta.main) {
  try {
    const version = process.argv[2];
    if (!version || version.startsWith("-")) {
      throw new Error("usage: release-notes.ts <version>   (for example 0.5.2)");
    }
    assertTaggableVersion(version);
    const since = previousReleaseTag();
    const changes = parseMergedChanges(
      run(["git", "log", "--no-merges", "--format=%s", `${since}..HEAD`]),
    );
    const path = releaseNotesPath(ROOT, `v${version}`);
    if (existsSync(path)) throw new Error(`release notes already exist: ${path}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderReleaseNotes(version, since, changes));
    console.log(`wrote ${path} with ${changes.length} change(s) since ${since}`);
    console.log("Edit every TODO before committing; the notes become an immutable release body.");
  } catch (error) {
    console.error(`release-notes: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
