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
import { releaseAssetsInReadingOrder, releaseNotesPath } from "./release-promotion";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

interface MergedChange {
  subject: string;
  pull: string | null;
  /** Touched only docs, skills, workflows or tests, so probably not user-facing. */
  internal: boolean;
}

// Paths whose changes users never observe in the products. A pull request that
// touched only these is offered as "probably internal" so the judgment is
// prompted, not rediscovered from a previous release's precedent.
const INTERNAL_PREFIXES = ["docs/", "skills/", ".github/", "tests/", "wispd/tests/", "web/tests/"];

export function isInternalChange(paths: string[]): boolean {
  return paths.length > 0 && paths.every((path) => INTERNAL_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

// Migrations are numbered and appended, so the release adds every id that is
// present now and was not present at the previous tag. Deriving this stops the
// upgrade warning from depending on someone remembering to diff migrations.ts.
export function migrationIds(source: string): number[] {
  return [...source.matchAll(/^\s*id: (\d+),/gm)].map((match) => Number(match[1])).sort((a, b) => a - b);
}

export function addedMigrations(before: string, after: string): number[] {
  const had = new Set(migrationIds(before));
  return migrationIds(after).filter((id) => !had.has(id));
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

export function parseMergedChanges(log: string, pathsFor?: (subject: string) => string[]): MergedChange[] {
  return log
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const pull = /\(#(\d+)\)\s*$/.exec(line);
      return {
        subject: line.replace(/\s*\(#\d+\)\s*$/, ""),
        pull: pull ? pull[1]! : null,
        internal: isInternalChange(pathsFor?.(line) ?? []),
      };
    });
}

export function renderReleaseNotes(
  version: string,
  since: string,
  changes: MergedChange[],
  migrations: number[] = [],
): string {
  const bullets = changes.length
    ? changes
        .map((change) => {
          const reference = change.pull ? ` (#${change.pull})` : "";
          return change.internal
            ? `- TODO probably internal, so drop this or fold it into one hygiene bullet: ${change.subject}${reference}`
            : `- TODO describe for users: ${change.subject}${reference}`;
        })
        .join("\n")
    : "- TODO no merged changes were found since the previous tag";
  const assets = releaseAssetsInReadingOrder(version)
    .map((asset) => `- \`${asset}\``)
    .join("\n");
  const migrationLine =
    migrations.length === 0
      ? "This release adds no database migration."
      : `This release adds database migration ${migrations.join(" and ")}, so a ${since.replace(/^v/, "")} daemon cannot reopen a profile that ${version} has opened.`;
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
${migrationLine}

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
      (subject) => {
        // One `git log` per subject is fine here: a release has a handful of
        // commits, and this only decides which bullets get flagged.
        const found = run(["git", "log", "--no-merges", "--format=%H", "--fixed-strings", `--grep=${subject}`, `${since}..HEAD`])
          .split(/\r?\n/)
          .filter(Boolean);
        if (found.length !== 1) return [];
        return run(["git", "show", "--name-only", "--format=", found[0]!]).split(/\r?\n/).filter(Boolean);
      },
    );
    const MIGRATIONS = "wispd/src/migrations.ts";
    const migrations = addedMigrations(
      run(["git", "show", `${since}:${MIGRATIONS}`]),
      run(["git", "show", `HEAD:${MIGRATIONS}`]),
    );
    const path = releaseNotesPath(ROOT, `v${version}`);
    if (existsSync(path)) throw new Error(`release notes already exist: ${path}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderReleaseNotes(version, since, changes, migrations));
    const internal = changes.filter((change) => change.internal).length;
    console.log(
      `wrote ${path} with ${changes.length} change(s) since ${since}` +
        `${internal > 0 ? `, ${internal} flagged as probably internal` : ""}` +
        `${migrations.length > 0 ? `, adding migration ${migrations.join(" and ")}` : ", adding no migration"}`,
    );
    console.log("Edit every TODO before committing; the notes become an immutable release body.");
  } catch (error) {
    console.error(`release-notes: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
