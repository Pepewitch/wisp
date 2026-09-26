#!/usr/bin/env bun
// Release notes become an immutable GitHub release body, and the
// qualification ledger is the public record of what each release proved. Both
// are scaffolded with TODO markers where judgment is needed (release:notes,
// release:closeout), so a marker that survives to a commit is an unfinished
// claim. This gate runs inside `bun run docs:check`, so CI refuses it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RELEASE_DOCUMENT = /^docs\/v\d+\.\d+\/(?:RELEASE-NOTES-[^/]+|QUALIFICATION)\.md$/;

export interface TodoLine {
  line: number;
  text: string;
}

export function todoLines(source: string): TodoLine[] {
  return source
    .split("\n")
    .map((text, index) => ({ line: index + 1, text }))
    .filter((entry) => /\bTODO\b/.test(entry.text));
}

export function isReleaseDocument(path: string): boolean {
  return RELEASE_DOCUMENT.test(path);
}

function trackedReleaseDocuments(root: string): string[] {
  return execFileSync("git", ["-C", root, "ls-files", "-z", "--", "docs"], { encoding: "utf8" })
    .split("\0")
    .filter((path) => path && isReleaseDocument(path));
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const files = trackedReleaseDocuments(root);
  let found = 0;
  for (const file of files) {
    for (const entry of todoLines(readFileSync(resolve(root, file), "utf8"))) {
      found++;
      console.error(`${file}:${entry.line}: ${entry.text.trim()}`);
    }
  }
  if (found > 0) {
    console.error(`${found} TODO marker(s) left in release documents; finish or remove each one`);
    process.exit(1);
  }
  console.log(`checked ${files.length} release documents for TODO markers`);
}
