// Preloaded before any test file: isolate all wisp state (db, logs, worktrees)
// into a throwaway home so tests never touch ~/.wisp.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WISP_HOME = mkdtempSync(join(tmpdir(), "wisp-test-"));
