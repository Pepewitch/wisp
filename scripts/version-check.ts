#!/usr/bin/env bun
// Gate: every place that repeats the release version agrees with
// wispd/package.json. Runs in `bun run check`, so a half-applied version bump
// cannot reach a release branch.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVersionSites } from "./release-versions";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

if (import.meta.main) {
  try {
    const { version, sites, values } = checkVersionSites(ROOT);
    console.log(`release version ${version} agrees across ${sites} sites (${values} occurrences)`);
  } catch (error) {
    console.error(`version-check: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
