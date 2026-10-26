// Migration 28 (message-source), applied to a profile 0.8.0 leaves behind:
// an old Wisp message gets a source only where stored ids say what wrote it,
// never from its text; every other row keeps NULL, and the person's bubble.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, MIGRATIONS } from "../src/migrations";

const AT = "2026-10-01T00:00:00.000Z";

test("a schema-27 profile gains task_messages.source_json, backfilled from workflow links only, and only 28 runs", () => {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "wisp-migrate-source-")), "wisp.db"), { create: true });
  db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of [...MIGRATIONS].sort((a, b) => a.id - b.id).filter((m) => m.id <= 27)) {
    migration.up(db);
    db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, 'then')").run(migration.id, migration.name);
  }
  const workflow = (id: string, type: string) => db.run(`INSERT INTO workflows (id, task_id, type, version, params_json, state, reason, context_n,
    next_check_at, expires_at, created_at, updated_at) VALUES (?, 'told', ?, '1', '{}', 'active', '', 1, ?, ?, ?, ?)`, [id, type, AT, AT, AT, AT]);
  const message = (id: string, origin: string, text: string, task = "told", workflowId: string | null = null) => db.run(`INSERT INTO task_messages
    (id, task_id, context_n, harness, text, status, attachment_hash, origin, workflow_id, created_at, updated_at)
    VALUES (?, ?, 1, 'claude', ?, 'delivered', '', ?, ?, ?, ?)`, [id, task, text, origin, workflowId, AT, AT]);
  const wake = (workflowId: string, key: string, messageId: string) =>
    db.run("INSERT INTO workflow_wakes (workflow_id, event_key, message_id, prior_checkpoint_json) VALUES (?, ?, ?, '{}')", [workflowId, key, messageId]);
  const history = (workflowId: string, kind: string, messageId: string, pr: number | null) =>
    db.run("INSERT INTO workflow_history (workflow_id, at, kind, detail, message_id, pr) VALUES (?, ?, ?, 'a detail', ?, ?)", [workflowId, AT, kind, messageId, pr]);

  workflow("wbeat", "heartbeat");
  workflow("wpilot", "pr-autopilot");
  workflow("wwatch", "sample-watch");
  workflow("wsched", "schedule-steer");
  message("mbeat", "workflow", "[Wisp heartbeat wbeat]");
  wake("wbeat", "tick-1", "mbeat");
  message("mfix", "workflow", "[Wisp auto-fix · PR #12 · round 2 of 5 · head abcdef0]");
  wake("wpilot", "ci:abc:test", "mfix");
  history("wpilot", "wake", "mfix", 12);
  db.run(`INSERT INTO auto_review_rounds (id, task_id, workflow_id, pr, head, round, token, state, created_at)
    VALUES ('rd1', 'told', 'wpilot', 12, 'abc', 2, 'tok', 'fail', ?)`, [AT]);
  message("mreview", "workflow", "[Wisp auto-review · PR #12 · round 2 of 3 · head abc]");
  wake("wpilot", "review:rd1", "mreview");
  message("mresume", "workflow", "The network dropped; continue from where you stopped.");
  wake("wpilot", "network:t1:1", "mresume");
  history("wpilot", "network-resume", "mresume", 12);
  message("mwatch", "plugin", "[Wisp workflow wwatch: sample-watch]", "told", "wwatch");
  // the person's words, sent later by a schedule
  message("msched", "scheduled", "Use the staged rollout", "told", "wsched");
  // Wisp's by origin, but linked to nothing that says which part of Wisp
  message("mlost", "workflow", "[Wisp auto-fix · PR #3 · round 1 of 5 · head abcdef0]");
  // the person typing what reads like a round
  message("mhuman", "human", "[Wisp auto-fix · PR #3 · round 1 of 5] I typed this");
  // a reviewer's verdict reminder: Wisp's message in a review's reviewer task
  db.run(`INSERT INTO round_reviews (id, round_id, role, reviewer_task_id, harness, token, state, created_at)
    VALUES ('v1', 'rd1', 'primary', 'treviewer', 'droid', 'tok', 'pass', ?)`, [AT]);
  message("mnudge", "workflow", "Your review is still open.", "treviewer");

  expect(migrate(db).applied.filter((id) => id <= 28)).toEqual([28]);
  const sources = Object.fromEntries((db.query("SELECT id, source_json FROM task_messages").all() as { id: string; source_json: string | null }[])
    .map((row) => [row.id, row.source_json === null ? null : JSON.parse(row.source_json)]));
  expect(sources).toEqual({
    mbeat: { by: "workflow", kind: "heartbeat" },
    // an old auto-fix row cannot say its round
    mfix: { by: "autopilot", kind: "auto-fix", pr: 12, round: null, rounds: null },
    mreview: { by: "autopilot", kind: "auto-review", pr: 12, round: 2, rounds: null },
    mresume: { by: "autopilot", kind: "network-resume", pr: 12, round: null, rounds: null },
    mwatch: { by: "workflow", kind: "sample-watch" },
    msched: null,
    mlost: null,
    mhuman: null,
    mnudge: { by: "autopilot", kind: "review-nudge", pr: 12, round: 2, rounds: null },
  });
  expect(migrate(db).applied).toEqual([]);
});
