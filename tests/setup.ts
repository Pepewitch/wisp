// Preloaded before any test file: isolate all wisp state (db, logs, worktrees)
// into a throwaway home so tests never touch ~/.wisp.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WISP_HOME = mkdtempSync(join(tmpdir(), "wisp-test-"));
// Server fixtures share this identity regardless of Bun's test-file order.
writeFileSync(
  join(process.env.WISP_HOME, "instance-id"),
  "123e4567-e89b-42d3-a456-426614174000\n",
  { mode: 0o600 },
);
