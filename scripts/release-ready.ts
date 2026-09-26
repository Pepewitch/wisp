#!/usr/bin/env bun
// `bun run release:ready <version>` runs after the release PR is merged. It
// finds the commit on origin/main that set the version, waits until that
// commit's checks pass, and prints the tag commands for exactly that commit.
// Tagging a named commit rather than the checkout means no local state can
// leak into a release, and a change that lands on main in the meantime simply
// belongs to the next one. It never pushes: the tag push is the publication.
import { relative } from "node:path";
import { todoLines } from "./check-release-docs";
import {
  RELEASE_COMMIT_CHECKS,
  REPOSITORY,
  ROOT,
  command,
  checkVerdicts,
  commitCheckRuns,
  formatVerdicts,
  git,
  localTagExists,
  remoteTagExists,
  rerunAdvice,
  settleFailures,
  sleep,
  versionArgument,
  waitMinutes,
  workflowRunState,
  type CheckVerdict,
} from "./release-github";
import { releaseNotesPath } from "./release-promotion";
import { SOURCE_SITE, assertTaggableVersion } from "./release-versions";

const POLL_MS = 20_000;
const HISTORY_LIMIT = 50;

/**
 * Walking back from the newest commit that touched the version file, the
 * release commit is the oldest one still carrying `version`: later commits
 * may touch the file (a dependency bump) without being the release.
 */
export function releaseCommit(shas: readonly string[], versionAt: (sha: string) => string | null, version: string): string | null {
  let found: string | null = null;
  for (const sha of shas) {
    if (versionAt(sha) !== version) break;
    found = sha;
  }
  return found;
}

function versionAt(sha: string): string | null {
  const result = command(["git", "show", `${sha}:${SOURCE_SITE}`]);
  if (!result.ok) return null;
  const { version } = JSON.parse(result.stdout) as { version?: unknown };
  return typeof version === "string" ? version : null;
}

export function progressLine(verdicts: readonly CheckVerdict[]): string {
  const waiting = verdicts.filter((verdict) => verdict.state === "pending" || verdict.state === "missing");
  const passed = verdicts.filter((verdict) => verdict.state === "passed").length;
  return `  ${passed}/${verdicts.length} passed${waiting.length ? `; waiting for ${waiting.map((verdict) => verdict.name).join(", ")}` : ""}`;
}

/** Problems that make tagging wrong no matter what the checks say. */
function commitProblems(sha: string, version: string): string[] {
  const tag = `v${version}`;
  const problems: string[] = [];
  const notes = relative(ROOT, releaseNotesPath(ROOT, tag));
  const shown = command(["git", "show", `${sha}:${notes}`]);
  if (!shown.ok) problems.push(`${notes} is not in ${sha.slice(0, 7)}; the release PR must add it`);
  else for (const todo of todoLines(shown.stdout)) problems.push(`${notes}:${todo.line} still has a TODO on main`);
  if (localTagExists(tag)) {
    const annotated = command(["git", "cat-file", "-t", `refs/tags/${tag}`]).stdout === "tag";
    if (!annotated || git(["rev-list", "-n", "1", tag]) !== sha) {
      problems.push(`a local ${tag} exists but is not an annotated tag of ${sha.slice(0, 7)}; delete it: git tag -d ${tag}`);
    }
  }
  return problems;
}

async function waitForChecks(sha: string, minutes: number): Promise<CheckVerdict[] | null> {
  const deadline = Date.now() + minutes * 60_000;
  let last = "";
  for (;;) {
    const verdicts = settleFailures(checkVerdicts(commitCheckRuns(sha), RELEASE_COMMIT_CHECKS), workflowRunState);
    const line = progressLine(verdicts);
    if (line !== last) console.log(line);
    last = line;
    if (verdicts.some((verdict) => verdict.state === "failed")) {
      console.error(formatVerdicts(verdicts));
      console.error(rerunAdvice(verdicts));
      return null;
    }
    if (verdicts.every((verdict) => verdict.state === "passed")) return verdicts;
    if (Date.now() >= deadline) {
      console.error(formatVerdicts(verdicts));
      console.error(`The checks are still running after ${minutes} minutes. Run this command again to keep waiting.`);
      return null;
    }
    await sleep(POLL_MS);
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const version = versionArgument(args, "bun run release:ready <version> [--wait-minutes <n>]");
  assertTaggableVersion(version);
  const tag = `v${version}`;
  git(["fetch", "--quiet", "origin", "main", "--tags"]);
  if (remoteTagExists(tag)) {
    console.error(`${tag} is already pushed, so the release workflow owns it. Next: bun run release:closeout ${version}`);
    return 1;
  }
  const shas = git(["log", "--first-parent", `--max-count=${HISTORY_LIMIT}`, "--format=%H", "origin/main", "--", SOURCE_SITE])
    .split("\n")
    .filter(Boolean);
  const sha = releaseCommit(shas, versionAt, version);
  if (!sha) {
    console.error(`origin/main does not carry ${version} yet (${SOURCE_SITE} says ${versionAt("origin/main")}). Merge the release PR first.`);
    return 1;
  }
  const subject = git(["log", "-1", "--format=%s", sha]);
  console.log(`release:ready ${version}: release commit ${sha.slice(0, 7)} "${subject}"`);
  const problems = commitProblems(sha, version);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  const later = git(["log", "--oneline", `${sha}..origin/main`]);
  if (later) console.log(`  These commits landed after it and will ship in the next release, not this one:\n${later.replace(/^/gm, "    ")}`);

  const verdicts = await waitForChecks(sha, waitMinutes(args, 30));
  if (!verdicts) return 1;
  console.log(formatVerdicts(verdicts));
  const annotated = localTagExists(tag);
  console.log(`Every release check passed for ${sha.slice(0, 7)}. To publish ${version}, run:`);
  if (!annotated) console.log(`  git tag -a ${tag} -m "Wisp ${version}" ${sha}`);
  console.log(`  git push origin refs/tags/${tag}`);
  console.log("The push publishes the release and cannot be undone once assets are public. Then run:");
  console.log(`  bun run release:closeout ${version}`);
  console.log(`(the release workflow: https://github.com/${REPOSITORY}/actions/workflows/release.yml)`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`release:ready: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
