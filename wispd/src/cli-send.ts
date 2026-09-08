import { randomUUID } from "node:crypto";
import type { AttachmentPayload } from "./attachments";
import type { ApiTask, SendResult, TaskMessage } from "./types";

interface SendCommandOptions {
  positional: string[];
  imageFlag: string | boolean | string[] | undefined;
  commandName: string;
  readImages: (raw: string | boolean | string[] | undefined) => Promise<AttachmentPayload[] | undefined>;
  request: (path: string, method: string, body: unknown) => Promise<unknown>;
}

/** The durable-send CLI branch, split out so the top-level dispatcher stays flat. */
export async function sendCommand(options: SendCommandOptions): Promise<void> {
  const [id, ...message] = options.positional;
  if (!id || message.length === 0) {
    console.error(`usage: ${options.commandName} send <task> "message" [--image <path>]…`);
    process.exit(1);
  }
  const result = (await options.request(`/api/tasks/${id}/send`, "POST", {
    message: message.join(" "),
    clientMessageId: randomUUID(),
    attachments: await options.readImages(options.imageFlag),
  })) as ApiTask & SendResult;
  const uncertain = result.message.delivery_uncertain
    ? " (prior delivery may already have succeeded)"
    : "";
  if (result.disposition === "steered") {
    console.log(`${result.id} message ${result.message.id} sent to running turn ${result.message.turn_n}${uncertain}`);
  } else if (result.disposition === "queued-next") {
    console.log(`${result.id} message ${result.message.id} queued for the next turn${uncertain}`);
  } else {
    console.log(`${result.id} turn ${result.message.turn_n ?? result.turn_count} running${uncertain}`);
  }
}

/** One durable-message line for `wisp show`; started messages otherwise live in their turn row. */
export function taskMessageSummary(
  message: Pick<TaskMessage, "id" | "text" | "status" | "delivery" | "turn_n" | "delivery_uncertain">,
  archived: boolean,
): string | null {
  const text = message.text.slice(0, 120).replaceAll("\n", " ");
  const uncertain = message.delivery_uncertain ? " (retried after an unconfirmed delivery)" : "";
  if (message.delivery === "steered") return `— sent during turn ${message.turn_n}${uncertain}: ${text}`;
  if (message.status === "queued") {
    const state = archived
      ? "not delivered; task is archived"
      : message.delivery_uncertain
        ? "queued for retry; prior delivery may have succeeded"
        : "queued for next turn";
    return `— ${state} [${message.id}]: ${text}`;
  }
  if (message.status === "cancelled" && message.delivery_uncertain) {
    return `— retry cancelled; prior delivery may have succeeded [${message.id}]: ${text}`;
  }
  return message.delivery === "started" && message.delivery_uncertain
    ? `— turn ${message.turn_n}${uncertain}: ${text}`
    : null;
}
