/**
 * `wisp report ack <subtask> --through-turn <n> [--json]`: a parent that has
 * read a subtask's result (turn n) marks its waiting `done` turn reports up
 * to n as handled, so the next delivery does not bring them as news (#527).
 */
import type { ReportAckResponse } from "../../shared/api/task";
import type { Flags } from "./cli-args";
import { print, printJson } from "./cli-print";
import { wispCommand } from "./command";

const COMMAND = wispCommand();

export const REPORT_USAGE = `usage: ${COMMAND} report ack <subtask> --through-turn <n> [--json]  (n: the turn whose result you read)`;

/** The request a `wisp report` asks for, or a usage error to print. */
export function parseReport(positional: string[], flags: Flags): { child: string; throughTurn: number } | string {
  const [verb, child, ...rest] = positional;
  if (verb !== "ack" || !child || rest.length > 0) return REPORT_USAGE;
  const raw = flags["through-turn"];
  // never "the latest": a turn finished after the read would be marked unread
  if (raw === undefined) return `--through-turn <n> is required: the turn whose result you read (\`${COMMAND} result ${child}\` names it)`;
  const n = Number(raw);
  if (typeof raw !== "string" || !Number.isInteger(n) || n < 1) return `--through-turn must be a turn number (got: ${String(raw)})`;
  return { child, throughTurn: n };
}

/** What a person or the parent agent reads back. Pure, so the wording is tested without a daemon. */
export function reportAckLine(child: string, ack: ReportAckResponse): string {
  if (ack.through === null) return `${child} has no finished turn yet; nothing to mark handled`;
  const handled = ack.handled === 0
    ? `no waiting report from ${child} through turn ${ack.through} to mark handled`
    : `${ack.handled} report${ack.handled === 1 ? "" : "s"} from ${child} through turn ${ack.through} marked handled`;
  const kept = ack.kept === 0
    ? ""
    : `; ${ack.kept} still waiting (failures, questions, PR events, later turns and reports already being delivered stay)`;
  return `${handled}${kept}`;
}

export async function reportCommand(
  positional: string[],
  flags: Flags,
  request: (path: string, method: string, body: unknown) => Promise<unknown>,
  fail: (message: string) => never,
): Promise<void> {
  const parsed = parseReport(positional, flags);
  if (typeof parsed === "string") fail(parsed);
  const { child, throughTurn } = parsed as { child: string; throughTurn: number };
  const ack = (await request(`/api/tasks/${child}/report-ack`, "POST", { throughTurn })) as ReportAckResponse;
  if (flags.json === true) printJson(ack);
  else print(reportAckLine(child, ack));
}
