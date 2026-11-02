/**
 * A queued subtask (`wisp new --subtask --queue`) whose first prompt was
 * cancelled before it started has nothing left to start: it would read
 * `queued` forever. It waits for the person instead.
 */
import { getTask, messagesFor, transition } from "../store";

export function afterQueuedMessageCancelled(taskId: string): void {
  if (getTask(taskId)?.state !== "queued") return;
  if (messagesFor(taskId).some((message) => message.status === "queued")) return;
  transition(taskId, "needs-input", "its first prompt was cancelled before it started; send a message to start it");
}
