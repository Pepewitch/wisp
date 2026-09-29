/**
 * The search worker's entry point (search-runner.ts owns its lifecycle).
 *
 * It holds one read-only connection to the daemon's database. WAL lets it read
 * while the daemon writes, and read-only means a bug here can never write.
 * Imports stay minimal on purpose: this file is its own entry in the compiled
 * binary (build-binary.ts), so everything it imports is bundled twice, and
 * nothing it imports may open, migrate or lock the Wisp home.
 */
import { Database } from "bun:sqlite";
import { SearchCancelled, searchTasks } from "./store-search";
// Type-only: erased at build time, so the runner (and the daemon behind it) is
// never loaded here.
import type { SearchRequest, SearchWorkerReply } from "./search-runner";

declare const self: Worker;

let database: Database | null = null;

function reply(message: SearchWorkerReply): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<SearchRequest>) => {
  const message = event.data;
  if (message.type === "open") {
    try {
      database = new Database(message.path, { readonly: true });
      // A reader in WAL mode does not wait on writers; this covers the rare
      // moment the WAL index itself is being rebuilt.
      database.exec("PRAGMA busy_timeout = 2000");
      reply({ type: "ready" });
    } catch (error) {
      reply({ type: "open-failed", error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const cancel = new Int32Array(message.cancel);
  try {
    if (database === null) throw new Error("search worker has no database");
    const response = searchTasks(message.query, database, () => Atomics.load(cancel, 0) !== 0);
    reply({ type: "result", id: message.id, response });
  } catch (error) {
    if (error instanceof SearchCancelled) reply({ type: "cancelled", id: message.id });
    else reply({ type: "failed", id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
};
