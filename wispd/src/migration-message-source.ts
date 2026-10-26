/**
 * Migration 28, kept beside the ledger (migrations.ts) because that file is
 * at its size limit; it is listed there in order like every other step.
 */
import type { Migration } from "./migrations";

export const MESSAGE_SOURCE: Migration = {
  id: 28,
  name: "message-source",
  up: (db) => {
    // What wrote a message when the person did not, as JSON TurnSource
    // (shared/api/task.ts): autopilot's kind, PR and round, or a workflow's
    // type. The transcript labels the turn it starts from it, never from the
    // text.
    const columns = db.query("PRAGMA table_info(task_messages)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "source_json")) db.exec("ALTER TABLE task_messages ADD COLUMN source_json TEXT");
    // An existing row gets a source only where stored ids say what wrote it,
    // never its text: the workflow it is linked to (through workflow_id, its
    // wake or its history entry, as migration 15 linked them for `origin`)
    // and that workflow's type; for autopilot, a resume's own history kind
    // or an auto-review round's id in its wake key. What an old auto-fix row
    // cannot say is its round, so that stays null. A row with no link keeps
    // NULL and the person's bubble: a label is not guessed.
    //
    // A turn from before migration 26 has no source_message_id; the one
    // message recorded as having started it (its task, its turn number,
    // delivery 'started') is that link, and turns(task_id, n) is unique.
    //
    // The lookups by message id have no index of their own; two are built for
    // the backfill and dropped after it, so a large profile pays once, briefly.
    db.exec(`
CREATE INDEX message_source_history ON workflow_history(message_id);
CREATE INDEX message_source_wakes ON workflow_wakes(message_id);

UPDATE turns SET source_message_id = (
  SELECT m.id FROM task_messages m WHERE m.task_id = turns.task_id AND m.turn_n = turns.n AND m.delivery = 'started'
) WHERE source_message_id IS NULL AND origin IS NULL
  AND (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = turns.task_id AND m.turn_n = turns.n AND m.delivery = 'started') = 1;

CREATE TEMP TABLE message_source_links AS
SELECT m.id AS message_id, w.type AS type,
  (SELECT event_key FROM workflow_wakes WHERE message_id = m.id LIMIT 1) AS wake_key,
  (SELECT kind FROM workflow_history WHERE message_id = m.id ORDER BY id LIMIT 1) AS history_kind,
  (SELECT pr FROM workflow_history WHERE message_id = m.id AND pr IS NOT NULL ORDER BY id LIMIT 1) AS pr
FROM task_messages m JOIN workflows w ON w.id = COALESCE(m.workflow_id,
  (SELECT workflow_id FROM workflow_wakes WHERE message_id = m.id LIMIT 1),
  (SELECT workflow_id FROM workflow_history WHERE message_id = m.id LIMIT 1))
WHERE m.source_json IS NULL AND m.origin IN ('workflow', 'plugin');

UPDATE task_messages SET source_json = (
  SELECT CASE
    WHEN l.type = 'heartbeat' THEN json_object('by', 'workflow', 'kind', 'heartbeat')
    WHEN l.type = 'pr-autopilot' AND l.history_kind = 'network-resume'
      THEN json_object('by', 'autopilot', 'kind', 'network-resume', 'pr', l.pr, 'round', NULL, 'rounds', NULL)
    WHEN l.type = 'pr-autopilot' AND r.id IS NOT NULL
      THEN json_object('by', 'autopilot', 'kind', 'auto-review', 'pr', r.pr, 'round', r.round, 'rounds', NULL)
    WHEN l.type = 'pr-autopilot' AND l.wake_key IS NOT NULL
      THEN json_object('by', 'autopilot', 'kind', 'auto-fix', 'pr', l.pr, 'round', NULL, 'rounds', NULL)
    WHEN l.type NOT IN ('pr-autopilot', 'schedule-steer') AND task_messages.origin = 'plugin'
      THEN json_object('by', 'workflow', 'kind', l.type)
  END
  FROM message_source_links l
  LEFT JOIN auto_review_rounds r ON l.wake_key LIKE 'review:%' AND r.id = substr(l.wake_key, 8)
  WHERE l.message_id = task_messages.id
) WHERE id IN (SELECT message_id FROM message_source_links);

-- a reviewer's verdict reminder: Wisp's message in a task that is a review's reviewer
UPDATE task_messages SET source_json = (
  SELECT json_object('by', 'autopilot', 'kind', 'review-nudge', 'pr', r.pr, 'round', r.round, 'rounds', NULL)
  FROM round_reviews v JOIN auto_review_rounds r ON r.id = v.round_id
  WHERE v.reviewer_task_id = task_messages.task_id LIMIT 1
) WHERE source_json IS NULL AND origin = 'workflow' AND workflow_id IS NULL
  AND task_id IN (SELECT reviewer_task_id FROM round_reviews WHERE reviewer_task_id IS NOT NULL)
  AND id NOT IN (SELECT message_id FROM message_source_links);

DROP TABLE message_source_links;
DROP INDEX message_source_history;
DROP INDEX message_source_wakes;
`);
  },
};
