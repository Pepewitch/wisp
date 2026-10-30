import { randomUUID } from "node:crypto";
import type { StagedAttachmentPayload } from "./attachments";
import {
  discardAttachmentPayloads,
  type AttachmentFlags,
} from "./cli-attach";
import type { Flags } from "./cli-args";
import { print, printError } from "./cli-print";
import type { ApiTaskMessage, SendResponse, SendWhen } from "./types";

interface SendCommandOptions {
  positional: string[];
  attachmentFlags: AttachmentFlags;
  commandName: string;
  readAttachments: (flags: AttachmentFlags) => Promise<StagedAttachmentPayload[] | undefined>;
  discardAttachment: (uploadId: string) => Promise<unknown>;
  requestError: (error: unknown) => never;
  request: (path: string, method: string, body: unknown) => Promise<unknown>;
}

const USAGE = (command: string): string =>
  `usage: ${command} send <task> "message" [--model <m>] [--effort <level>] [--harness <h> --fresh-context] [--when now|next-turn] [--attach <path>]…`;

/** The agent fields of a send: what `POST /api/tasks/:id/send` takes beside the message. */
export interface SendAgentFields {
  harness?: string;
  model?: string;
  effort?: string;
  startFreshContext?: true;
  when?: SendWhen;
}

/**
 * `--model`, `--effort`, `--harness`, `--fresh-context` and `--when`, mapped
 * onto the API's own fields. The harness rules stay the API's (400 without a
 * model, 409 without a fresh context), so the CLI says exactly what the
 * composer would; only the shape of each flag is checked here.
 */
export function sendAgentFields(flags: Flags): SendAgentFields | string {
  const fields: SendAgentFields = {};
  for (const flag of ["harness", "model", "effort"] as const) {
    const value = flags[flag];
    if (value === undefined) continue;
    if (typeof value !== "string" || value === "") return `--${flag} requires a value`;
    fields[flag] = value;
  }
  if (flags["fresh-context"] === true) fields.startFreshContext = true;
  const when = flags.when;
  if (when !== undefined) {
    if (when !== "now" && when !== "next-turn") return "--when must be now or next-turn";
    fields.when = when;
  }
  return fields;
}

interface HarnessOffer {
  name: string;
  models?: string[];
  effortLevels?: string[];
}

/**
 * A model or effort the target harness does not offer is refused before the
 * send, from the daemon's cached harness list (never a CLI probe). A harness
 * whose list is not known yet (an empty one) is not second-guessed.
 */
export function agentOfferError(fields: SendAgentFields, taskHarness: string, harnesses: HarnessOffer[]): string | null {
  const name = fields.harness ?? taskHarness;
  const harness = harnesses.find((h) => h.name === name);
  if (!harness) return null; // the API names an unknown harness itself
  const models = harness.models ?? [];
  if (fields.model !== undefined && models.length > 0 && !models.includes(fields.model)) {
    return `${name} does not offer model ${fields.model} (offered: ${models.join(", ")}; a hidden model must be shown again first)`;
  }
  const levels = harness.effortLevels ?? [];
  if (fields.effort !== undefined && levels.length > 0 && !levels.includes(fields.effort)) {
    return `${name} has no effort level ${fields.effort} (levels: ${levels.join(", ")})`;
  }
  return null;
}

/** The durable-send CLI branch, split out so the top-level dispatcher stays flat. */
export async function sendCommand(options: SendCommandOptions): Promise<void> {
  const [id, ...message] = options.positional;
  if (!id || message.length === 0) {
    printError(USAGE(options.commandName));
    process.exit(1);
  }
  const agent = sendAgentFields(options.attachmentFlags as Flags);
  if (typeof agent === "string") {
    printError(`${agent}\n${USAGE(options.commandName)}`);
    process.exit(1);
  }
  const switching = agent.model !== undefined || agent.effort !== undefined || agent.harness !== undefined;
  if (agent.model !== undefined || agent.effort !== undefined) {
    let offerError: string | null = null;
    try {
      const task = (await options.request(`/api/tasks/${id}`, "GET", undefined)) as { harness: string };
      const { harnesses } = (await options.request("/api/harnesses", "GET", undefined)) as { harnesses: HarnessOffer[] };
      offerError = agentOfferError(agent, task.harness, harnesses);
    } catch (error) {
      options.requestError(error);
    }
    if (offerError) {
      printError(offerError);
      process.exit(1);
    }
  }
  let attachments: StagedAttachmentPayload[] | undefined;
  try {
    attachments = await options.readAttachments(options.attachmentFlags);
  } catch (error) {
    options.requestError(error);
  }
  let result: SendResponse;
  try {
    result = (await options.request(`/api/tasks/${id}/send`, "POST", {
      message: message.join(" "),
      clientMessageId: randomUUID(),
      attachments,
      ...agent,
    })) as SendResponse;
  } catch (error) {
    if (attachments) await discardAttachmentPayloads(attachments, options.discardAttachment);
    options.requestError(error);
  }
  const uncertain = result.message.delivery_uncertain
    ? " (prior delivery may already have succeeded)"
    : "";
  if (result.disposition === "steered") {
    print(`${result.id} message ${result.message.id} sent to running turn ${result.message.turn_n}${uncertain}`);
  } else if (result.disposition === "queued-next") {
    print(`${result.id} message ${result.message.id} queued for the next turn${uncertain}`);
  } else {
    print(`${result.id} turn ${result.message.turn_n ?? result.turn_count} running${uncertain}`);
  }
  if (switching) {
    const effort = result.effort ? `, effort ${result.effort}` : "";
    print(`${result.id} runs on ${result.harness}${result.model ? ` ${result.model}` : ""}${effort} from that turn`);
  }
}

/** One durable-message line for `wisp show`; started messages otherwise live in their turn row. */
export function taskMessageSummary(
  message: Pick<ApiTaskMessage, "id" | "text" | "status" | "delivery" | "turn_n" | "delivery_uncertain">,
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
