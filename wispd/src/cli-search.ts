import { wispCommand } from "./command";
import {
  STATE_ICON,
  type SearchResponse,
  type SearchSnippet,
  type SearchTaskHit,
} from "./types";

/**
 * `wisp search <text>` — the CLI half of the app's ⌘⇧F.
 *
 * It asks the same `GET /api/search` the sidebar does, so scope, caps,
 * snippets and refusals are the daemon's and there is no second copy of any of
 * them here. This file owns exactly one thing: what the answer looks like in a
 * terminal.
 *
 * Archived tasks are searched by the daemon and hidden here unless `-a`, which
 * is `wisp ls`'s rule and the web sidebar's Show-archived switch — and, like
 * both, it says how many it is holding back instead of implying none matched.
 */

/**
 * What answered, in one word. `queued` reads better than `message` on a line
 * that already says `turn 2`, and `said` is the agent's own prose from inside
 * the turn — distinct from `result`, which is how it concluded.
 */
const WHERE: Record<SearchSnippet["kind"], string> = {
  title: "title",
  prompt: "prompt",
  result: "result",
  message: "queued",
  prose: "said",
};

/** The last path segment — a project name in the width a terminal can spare. */
function projectName(repoPath: string): string {
  const segments = repoPath.replace(/\/+$/, "").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? repoPath;
}

function hitLines(hit: SearchTaskHit): string[] {
  const icon = STATE_ICON[hit.state] ?? "·";
  const count = hit.matches > 1 ? `  ${hit.matches} matches` : "";
  const lines = [
    `${hit.id}  ${icon} ${hit.state.padEnd(11)} ${projectName(hit.repo_path).slice(0, 14).padEnd(14)} ${hit.title.slice(0, 60)}${count}`,
  ];
  for (const snippet of hit.snippets) {
    const where = `${WHERE[snippet.kind]}${snippet.turn === null ? "" : ` ${snippet.turn}`}`;
    lines.push(`        ${where.padEnd(9)} ${snippet.text}`);
  }
  return lines;
}

/**
 * The whole printed answer, as lines. Pure, so the shape is tested without a
 * daemon and the command below stays a request plus a println.
 */
export function searchLines(response: SearchResponse, options: { all: boolean }): string[] {
  const live = response.tasks.filter((hit) => !hit.archived);
  const archived = response.tasks.filter((hit) => hit.archived);
  const shown = options.all ? [...live, ...archived] : live;
  if (shown.length === 0) {
    const nothing = [`no match for '${response.query}'`];
    if (archived.length > 0) {
      nothing.push(
        `${archived.length} archived ${archived.length === 1 ? "task matches" : "tasks match"} — add -a to include ${archived.length === 1 ? "it" : "them"}`,
      );
    }
    if (response.indexing !== undefined) {
      const turns = response.indexing.remainingTurns;
      nothing.push(
        `still indexing what the agent said in ${turns} older ${turns === 1 ? "turn" : "turns"} — try again shortly`,
      );
    }
    return nothing;
  }

  const lines = live.flatMap(hitLines);
  if (options.all && archived.length > 0) {
    // A heading, because an archived task is not a live one and a flat list
    // would have you acting on a task whose worktree is gone.
    lines.push("", "archived");
    lines.push(...archived.flatMap(hitLines));
  } else if (archived.length > 0) {
    lines.push(`${archived.length} archived ${archived.length === 1 ? "task" : "tasks"} hidden — add -a to include ${archived.length === 1 ? "it" : "them"}`);
  }
  if (response.truncated) lines.push("showing the most recent matches");
  if (response.indexing !== undefined) {
    // Same honesty as the sidebar's muted line: during catch-up an answer is
    // provisional, and a miss is not yet a miss.
    const turns = response.indexing.remainingTurns;
    lines.push(`still indexing what the agent said in ${turns} older ${turns === 1 ? "turn" : "turns"}`);
  }
  return lines;
}

export async function searchCommand(
  positional: string[],
  flags: Record<string, unknown>,
  request: (path: string) => Promise<unknown>,
): Promise<void> {
  const command = wispCommand();
  // Every word is part of the needle: `wisp search steer box` searches for
  // "steer box", because quoting a phrase is not something a person should
  // have to remember for the obvious case.
  const query = positional.join(" ").trim();
  if (query === "") throw new Error(`usage: ${command} search <text> [-a] [--json]`);
  const response = (await request(`/api/search?q=${encodeURIComponent(query)}`)) as SearchResponse;
  if (flags.json === true) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  for (const line of searchLines(response, { all: flags.all === true || flags.a === true })) {
    console.log(line);
  }
}
