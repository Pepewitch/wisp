import type { Migration } from "./migrations";

export const TURN_OUTPUTS: Migration = {
  id: 22,
  name: "turn-outputs",
  up: (db) => {
    const columns = db.query("PRAGMA table_info(turns)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "outputs_json")) {
      db.exec("ALTER TABLE turns ADD COLUMN outputs_json TEXT");
    }
  },
};
