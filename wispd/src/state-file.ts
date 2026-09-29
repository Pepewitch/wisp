import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Small JSON records the daemon keeps in the Wisp home for later diagnosis:
 * the run marker, recent unclean exits, the last self-update. Read by the
 * daemon and by `wisp doctor`, which may run while the daemon is down, so
 * both halves are synchronous and never throw.
 */

/** The parsed file, or null when it is missing or unreadable. */
export function readStateFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Replace the file atomically (a reader sees the old record or the new one,
 * never half of either), private to this user. Returns whether it was written:
 * a record that cannot be kept is a lost diagnostic, not a daemon failure.
 */
export function writeStateFile(path: string, value: unknown): boolean {
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    return true;
  } catch {
    return false;
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // nothing left to do about a temp file that cannot be removed
    }
  }
}
