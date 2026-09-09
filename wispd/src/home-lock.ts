/**
 * One owner per Wisp home (ENG-02).
 *
 * The daemon used to decide it was alone by checking whether its configured
 * address was free, releasing that probe listener, and then running recovery.
 * That is not an ownership boundary, and a review showed what it costs: two
 * daemons pointed at one home both came up healthy, and the second one's boot
 * recovery flipped the first one's live `creating` task to `failed`. It does
 * not take a test override to reach that state in production either — a
 * changed persisted port, or a different `WISP_HOST`, and the check simply
 * does not notice the daemon that is already there. Two owners then reconcile
 * each other's live state and compete for the same work, which is the opposite
 * of the single-writer assumption the spawn and claim logic is built on.
 *
 * The lock is an exclusive SQLite lock on a file inside the home, which makes
 * the OPERATING SYSTEM the arbiter rather than a pid we would have to trust:
 *
 *   * a second process is refused immediately, with no timing window to lose;
 *   * a daemon that is SIGKILLed or panics releases it, because the kernel
 *     drops the file lock with the process — there is no stale lock to reap
 *     and no pid to guess about (all three behaviors were measured on macOS
 *     before this was written, including a second connection inside the SAME
 *     process, which is also refused);
 *   * it needs no new dependency and no platform-specific FFI.
 *
 * What it deliberately is not: a distributed lock. A Wisp home on a network
 * filesystem whose locking is advisory-only is outside what this can promise,
 * and the honest answer there is not to share a home.
 */
import { Database } from "bun:sqlite";
import { HOME_LOCK_PATH, WISP_HOME } from "./config";

/** Ownership of a Wisp home, held for as long as the daemon serves it. */
export interface HomeOwnership {
  release(): void;
}

/** The home is owned by someone else; the caller must not touch its state. */
export class HomeBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeBusyError";
  }
}

/**
 * Nothing may block for long here: the answer is "you own it" or "someone else
 * does", and a daemon that waits is a daemon whose boot hangs on a mistake.
 */
const BUSY_TIMEOUT_MS = 250;

/** The live holder in THIS process, so a second `serve()` is refused too. */
let held: Database | null = null;

/**
 * Take exclusive ownership of the Wisp home, or throw `HomeBusyError`.
 *
 * Call this before anything reads or reconciles persisted state. The write is
 * what acquires the lock — `locking_mode = EXCLUSIVE` keeps it until the
 * connection closes — and the row it writes is only a breadcrumb, because the
 * lock itself is the fact.
 */
export function acquireHomeOwnership(): HomeOwnership {
  if (held !== null) {
    throw new HomeBusyError(
      `this process is already serving ${WISP_HOME}; stop that daemon before starting another`,
    );
  }
  const db = new Database(HOME_LOCK_PATH, { create: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY, pid INTEGER, acquired_at TEXT)");
    db.query("INSERT OR REPLACE INTO ownership (id, pid, acquired_at) VALUES (1, ?, ?)").run(
      process.pid,
      new Date().toISOString(),
    );
  } catch (error) {
    db.close();
    const detail = error instanceof Error ? error.message : String(error);
    // Only a BUSY lock means "someone else owns this home". CANTOPEN, a
    // permissions problem, a full disk, or a corrupt lock file are none of
    // those, and reporting them as an owner sends the operator hunting a
    // daemon that is not there (a review's note).
    if (!/busy|locked/i.test(detail)) {
      throw new Error(`${WISP_HOME}: could not take the daemon ownership lock (${detail})`, { cause: error });
    }
    throw new HomeBusyError(`${WISP_HOME} is already owned by another Wisp daemon (${detail})`);
  }
  held = db;
  return {
    release: () => {
      if (held !== db) return;
      held = null;
      db.close();
    },
  };
}

/** Whether this process currently owns the home — for diagnostics and tests. */
export function ownsHome(): boolean {
  return held !== null;
}
