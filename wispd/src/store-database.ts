import { Database } from "bun:sqlite";
import { DB_PATH } from "./config";
import { wispCommand } from "./command";
import { ownsHome } from "./home-lock";
import { enforceForeignKeys, migrate, SchemaTooNewError } from "./migrations";

// An import must never create or migrate the application database. The daemon
// initializes this live binding only after acquiring profile ownership.
export let db: Database;
let initialized = false;

export function initializeStore(): void {
  if (!ownsHome()) throw new Error("Database initialization requires Wisp home ownership; start the daemon with 'serve'.");
  let opened: Database | undefined;
  try {
    opened = initialized ? db : new Database(DB_PATH, { create: true });
    migrate(opened);
    enforceForeignKeys(opened);
    db = opened;
    initialized = true;
  } catch (error) {
    opened?.close();
    initialized = false;
    const detail = error instanceof Error ? error.message : String(error);
    const action = error instanceof SchemaTooNewError
      ? "Install the same or a newer Wisp version, then restart. Do not delete the database or downgrade its schema."
      : `Run '${wispCommand()} doctor --database' using this same WISP_HOME. Check available disk space and directory permissions, and close any database editor holding a write lock. After fixing the reported problem, restart Wisp; completed migration steps are retained and failed steps are retried transactionally. Do not delete the database; preserve a copy before any manual repair or restore.`;
    throw new Error(`Could not initialize ${DB_PATH}: ${detail} No task recovery was started. ${action}`, { cause: error });
  }
}
