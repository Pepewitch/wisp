import type { LimitWindow } from "./adapters";
import type { HarnessLimitsEntry } from "./harness-limits";

/**
 * `wisp limits` — the CLI half of the top bar's usage popover. It asks the
 * same `GET /api/harness-limits`, so every read, cache and refusal is the
 * daemon's; this file owns only what the answer looks like in a terminal.
 */

export interface HarnessLimitsResponse {
  harnesses: HarnessLimitsEntry[];
}

const BAR_CELLS = 10;

function bar(usedPercent: number): string {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(usedPercent / (100 / BAR_CELLS))));
  return "█".repeat(filled) + "░".repeat(BAR_CELLS - filled);
}

/** `in 2h 14m`, `in 3d 4h`, `in 12m`. Floors, like the web's relative clock, so 90 minutes never reads as 2h. */
export function resetsIn(iso: string | null, now: Date): string {
  if (iso === null) return "";
  const ms = Date.parse(iso) - now.getTime();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "resets now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `resets in ${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function windowLine(window: LimitWindow, indent: string, now: Date): string {
  const percent = `${Math.round(window.usedPercent)}%`.padStart(4);
  const reset = resetsIn(window.resetsAt, now);
  return `${indent}${window.label.padEnd(10)} ${bar(window.usedPercent)} ${percent} used${reset ? `  ${reset}` : ""}`.trimEnd();
}

/** The whole printed answer, as lines. Pure, so the shape is tested without a daemon. */
export function limitsLines(response: HarnessLimitsResponse, now: Date): string[] {
  if (response.harnesses.length === 0) return ["no loaded harness reports plan limits"];
  const lines: string[] = [];
  for (const entry of response.harnesses) {
    if (entry.status !== "ok" || !entry.limits) {
      lines.push(`${entry.name}  ${entry.message ?? entry.status}`);
      continue;
    }
    lines.push(entry.limits.plan ? `${entry.name}  (${entry.limits.plan})` : entry.name);
    const pools = [...new Set(entry.limits.windows.map((w) => w.pool))];
    // one pool needs no heading; droid's standard/core does
    const headed = pools.length > 1 || pools[0] !== null;
    for (const pool of pools) {
      if (headed) lines.push(`  ${pool ?? "default"}`);
      for (const window of entry.limits.windows.filter((w) => w.pool === pool)) {
        lines.push(windowLine(window, headed ? "    " : "  ", now));
      }
    }
    if (entry.limits.account === "unchecked") lines.push("  not checked against droid's login");
  }
  return lines;
}

export async function limitsCommand(
  flags: Record<string, unknown>,
  request: (path: string) => Promise<unknown>,
): Promise<void> {
  const response = (await request(`/api/harness-limits${flags.refresh === true ? "?refresh=1" : ""}`)) as HarnessLimitsResponse;
  if (flags.json === true) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  for (const line of limitsLines(response, new Date())) console.log(line);
}
