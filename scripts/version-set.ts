#!/usr/bin/env bun
// Writes one release version into every site listed in release-versions.ts.
// This replaces editing nine files by hand; `bun run version:check` then
// verifies the result by reading those files back independently.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVersionSites, sourceVersion, writeVersionSites } from "./release-versions";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

if (import.meta.main) {
  try {
    const next = process.argv[2];
    if (!next || next.startsWith("-")) {
      throw new Error("usage: version-set.ts <version>   (for example 0.5.2 or 0.6.0-alpha.1)");
    }
    const previous = sourceVersion(ROOT);
    const changed = writeVersionSites(ROOT, next);
    const verified = checkVersionSites(ROOT);
    if (verified.version !== next) throw new Error(`wrote ${next} but the source now reads ${verified.version}`);
    console.log(`set release version ${previous} -> ${next}`);
    for (const file of changed) console.log(`  updated ${file}`);
    if (changed.length === 0) console.log(`  already at ${next}`);
    console.log(`verified ${verified.sites} sites (${verified.values} occurrences)`);
  } catch (error) {
    console.error(`version-set: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
