import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachmentManifest, writeTurnAttachments } from "../../src/attachments";
import { LOG_DIR } from "../../src/config";
import { createTask, createTurn, finishTurn, setTaskFields, transition } from "../../src/store";

const TASK_ID = "tspike";
const ATTACHMENT_NAME = "transport.png";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const label = process.argv[2];
const worktree = process.argv[3];
if (!label || !worktree) throw new Error("usage: seed-transport-daemon <label> <worktree>");

const title = `transport task ${label}`;
const prompt = `transport prompt ${label}`;
const output = `transport output ${label}\n`;
const logFile = join(LOG_DIR, `${label}.out.log`);
const attachmentBytes = Buffer.concat([PNG_BYTES, Buffer.from(`-${label}`)]);

writeFileSync(logFile, output);
const stored = writeTurnAttachments(TASK_ID, 1, [
  { name: ATTACHMENT_NAME, mediaType: "image/png", data: attachmentBytes },
]);
createTask({
  id: TASK_ID,
  title,
  repo_path: worktree,
  harness: "synthetic",
  model: null,
  mode: "local",
  slot: 0,
});
setTaskFields(TASK_ID, { worktree_path: worktree, turn_count: 1 });
const turnId = createTurn(TASK_ID, 1, prompt, null, logFile, null, attachmentManifest(stored));
finishTurn(turnId, "done", 0, output.trim());
transition(TASK_ID, "done", `transport fixture ${label}`);

console.log(
  JSON.stringify({
    taskId: TASK_ID,
    title,
    prompt,
    output,
    attachmentName: ATTACHMENT_NAME,
    attachmentBase64: attachmentBytes.toString("base64"),
  }),
);
