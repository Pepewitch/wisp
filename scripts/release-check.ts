#!/usr/bin/env bun
// `bun run release:check <version>` is the local gate for a committed release
// branch, run before the release PR opens. It first refuses the mistakes that
// are expensive once a tag exists: a reused or older version, a branch behind
// main, unfinished notes, a document that still names the previous release.
// Then it runs the source gates, cheapest first. Each gate writes to its own
// log, and only a failing gate's tail is printed.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { todoLines } from "./check-release-docs";
import {
  ROOT,
  command,
  fetchMainAndTags,
  git,
  latestRelease,
  ledgerPath,
  localTagExists,
  previousRelease,
  releaseTags,
  remoteTagExists,
  versionArgument,
} from "./release-github";
import { releaseNotesPath } from "./release-promotion";
import { SOURCE_SITE, assertTaggableVersion, sourceVersion } from "./release-versions";

/** Prose that names the current release. version:set rewrites the pinned sites in them. */
export const CURRENT_RELEASE_DOCUMENTS = ["README.md", "SECURITY.md", "docs/INSTALL.md", "docs/INSTALL-MACOS.md"];

/** What the PNG brand assets are rendered from, besides the font package. */
export const PNG_INPUTS = ["brand/", "scripts/brand/", "desktop/src-tauri/icons/"];
const PNG_FONT_PACKAGE = "@fontsource-variable/geist";
const LOG_DIR = "dist/release-check";
const TAIL_LINES = 60;

export interface Gate {
  id: string;
  cmd: string[];
  env?: Record<string, string>;
  note?: string;
}

/** 1-based lines that name `version` exactly (so 0.6.2 does not match 0.6.20). */
export function linesNaming(text: string, version: string): number[] {
  const pattern = new RegExp(`(?<![0-9.])${version.replaceAll(".", "\\.")}(?![0-9])`);
  return text
    .split("\n")
    .flatMap((line, index) => (pattern.test(line) ? [index + 1] : []));
}

/**
 * Why the PNG assets must be rendered again, if anything they are drawn from
 * changed since the previous release. No CI job renders them (the Linux
 * runners have no Chrome), so this is the only check they get.
 */
export function pngInputChanges(changedPaths: readonly string[], dependencyDiff: string): string[] {
  const changes = changedPaths.filter((path) => PNG_INPUTS.some((prefix) => path.startsWith(prefix)));
  const fontLine = new RegExp(`^[+-].*${PNG_FONT_PACKAGE.replace("/", "\\/")}`, "m");
  if (fontLine.test(dependencyDiff)) changes.push(PNG_FONT_PACKAGE);
  return changes;
}

export function sourceGates(previousTag: string, pngChanges: readonly string[]): Gate[] {
  const brand: Gate =
    pngChanges.length === 0
      ? {
          id: "brand",
          cmd: ["bun", "run", "brand:check"],
          env: { CHROME_PATH: "/nonexistent" },
          note: `no PNG input changed since ${previousTag}, so the PNG render is skipped`,
        }
      : { id: "brand", cmd: ["bun", "run", "brand:check"], note: `PNG inputs changed: ${pngChanges.join(", ")}` };
  return [
    { id: "whitespace", cmd: ["git", "diff", "--check", "origin/main", "HEAD"] },
    brand,
    { id: "evaluator", cmd: ["bun", "run", "test:evaluator"] },
    { id: "check", cmd: ["bun", "run", "check"] },
    { id: "smoke", cmd: ["bun", "run", "smoke"] },
    { id: "build", cmd: ["bun", "run", "build"] },
  ];
}

function relativePath(path: string): string {
  return relative(ROOT, path);
}

function workingTreeChanges(): string {
  return git(["status", "--porcelain=v1", "--untracked-files=normal"]);
}

/** Everything wrong with the branch at once, so one pass can fix it all. */
export function preconditionProblems(version: string, previous: string): string[] {
  const tag = `v${version}`;
  const problems: string[] = [];
  const changes = workingTreeChanges();
  if (changes) problems.push(`commit the release preparation first; the working tree has changes:\n${changes}`);
  const current = sourceVersion(ROOT);
  if (current !== version) problems.push(`${SOURCE_SITE} says ${current}; run: bun run version:set ${version}`);
  if (localTagExists(tag) || remoteTagExists(tag)) {
    problems.push(`${tag} already exists, and a release version is never reused; choose the next unused version`);
  }
  if (!command(["git", "merge-base", "--is-ancestor", "origin/main", "HEAD"]).ok) {
    problems.push("origin/main has commits this branch lacks; run: git rebase origin/main, then make sure the notes cover them");
  }
  const notes = releaseNotesPath(ROOT, tag);
  if (!existsSync(notes)) {
    problems.push(`${relativePath(notes)} is missing; run: bun run release:notes ${version}`);
  } else {
    for (const todo of todoLines(readFileSync(notes, "utf8"))) {
      problems.push(`${relativePath(notes)}:${todo.line}: finish this TODO: ${todo.text.trim()}`);
    }
  }
  const ledger = ledgerPath(version);
  if (!existsSync(join(ROOT, ledger))) {
    problems.push(`${ledger} is missing; release:notes writes it for the first release of a minor line`);
  }
  for (const document of CURRENT_RELEASE_DOCUMENTS) {
    const path = join(ROOT, document);
    if (!existsSync(path)) continue;
    for (const line of linesNaming(readFileSync(path, "utf8"), previous)) {
      problems.push(`${document}:${line} still names ${previous}; the current release is ${version}`);
    }
  }
  return problems;
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function tail(path: string): string {
  const lines = readFileSync(path, "utf8").replace(ANSI, "").trimEnd().split("\n");
  return lines.slice(-TAIL_LINES).map((line) => `    ${line}`).join("\n");
}

async function runGate(gate: Gate): Promise<boolean> {
  const log = join(ROOT, LOG_DIR, `${gate.id}.log`);
  const fd = openSync(log, "w");
  const started = performance.now();
  try {
    const child = Bun.spawn({
      cmd: gate.cmd,
      cwd: ROOT,
      env: { ...process.env, ...gate.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    });
    const code = await child.exited;
    const took = duration(performance.now() - started);
    if (code === 0) {
      console.log(`  pass  ${gate.id.padEnd(10)} ${took.padStart(6)}${gate.note ? `  ${gate.note}` : ""}`);
      return true;
    }
    console.error(`  FAIL  ${gate.id.padEnd(10)} ${took.padStart(6)}  ${gate.cmd.join(" ")} exited ${code}`);
    console.error(`  last ${TAIL_LINES} lines of ${relativePath(log)}:`);
    console.error(tail(log));
    return false;
  } finally {
    closeSync(fd);
  }
}

async function main(): Promise<number> {
  const version = versionArgument(process.argv.slice(2), "bun run release:check <version>");
  assertTaggableVersion(version);
  fetchMainAndTags();
  const tags = releaseTags();
  const previous = previousRelease(tags, version);
  if (!previous) throw new Error(`no release tag is older than ${version}`);
  const latest = latestRelease(tags);
  if (latest && Bun.semver.order(version, latest) <= 0) {
    throw new Error(`${version} is not newer than the latest release ${latest}; choose a newer version`);
  }
  console.log(`release:check ${version} (previous release ${previous})`);

  const problems = preconditionProblems(version, previous);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`release:check stopped before the gates: fix the ${problems.length} problem(s) above, commit, and run it again.`);
    return 1;
  }
  console.log(`  ok    ${version} is committed on a branch that contains origin/main, and v${version} is unused`);
  console.log("  ok    the release notes have no TODO markers, and no document still names the previous release");

  const previousTag = `v${previous}`;
  const changed = git(["diff", "--name-only", previousTag, "HEAD"]).split("\n").filter(Boolean);
  const dependencies = git(["diff", previousTag, "HEAD", "--", "bun.lock", "web/package.json"]);
  mkdirSync(join(ROOT, LOG_DIR), { recursive: true });
  for (const gate of sourceGates(previousTag, pngInputChanges(changed, dependencies))) {
    if (await runGate(gate)) continue;
    console.error(
      "Read the log above. If the failure is in code this release did not change (a flaky test),\n" +
        "run release:check once more. If the same gate fails twice, stop and report it.",
    );
    return 1;
  }

  const leftovers = workingTreeChanges();
  if (leftovers) {
    console.error(`a gate changed tracked or untracked files, so the commit is not what was checked:\n${leftovers}`);
    return 1;
  }
  const head = git(["rev-parse", "--short", "HEAD"]);
  console.log(`release:check passed for ${version} at ${head}.`);
  console.log("Next: push the branch and open the release PR (releasing.md, step 3).");
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`release:check: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
