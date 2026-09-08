import { defaultFilter } from "cmdk";

import type {
  ApiTask,
  HarnessCompact,
  ProbeCommandName,
  SkillEntry,
  StatusEntry,
} from "@/lib/types";

/**
 * The `/` palette's THREE tiers (v0.3 A2, decision Q6). The tier is not
 * decoration: it says whether picking the item spends tokens and re-arms a
 * settled task.
 *
 *   Tier 1 "Wisp"   — pure daemon API calls, identical for every task, never
 *                     a model turn (this file's TIER1_ENTRIES);
 *   Tier 2 (reads)  — a harness command that returns a report (`/context`,
 *                     the harness's own `/usage`), run out-of-band through
 *                     POST /api/tasks/:id/probe (A3). Free, keyed to the
 *                     task's harness, and headed by the harness's own name —
 *                     these are claims Wisp is RELAYING, not facts it
 *                     recorded. Wisp's own per-turn telemetry is `/tokens`
 *                     in Tier 1, so `/usage` keeps the harness meaning users
 *                     already know.
 *   Tier 3 "Skills" — the harness's OWN registry, enumerated by the daemon
 *                     (A4: claude's init event ∪ the frontmatter scan, droid's
 *                     list_skills, codex's skills/list), never a hardcoded
 *                     list that rots. Picking one only PRE-FILLS the draft —
 *                     `/name` where the harness runs skills headless by slash,
 *                     a plain-text ask on codex, which has no headless slash
 *                     surface (SP2) — so the user reviews what costs a turn.
 *
 * Q6 also settles the marking: only Tier 3 carries a label, because it is the
 * only tier that costs something, and §5c's "only what is news is marked" ban
 * three badges in a list whose whole job is to be scanned.
 *
 * Two Tier-1 changes worth naming, both made in slice 4:
 *
 *   - `/diff` is CUT. The right column's Changes pane IS the diff and is always
 *     visible, so there was no hidden pane for the command to reveal — it moved
 *     a tab that no longer exists.
 *   - `/log` no longer "jumps to the stream pane" (§5 deleted that pane): it
 *     pins the ONE conversation scroller back to the live tail, which is the
 *     thing a person actually wanted from it.
 *
 * `/tokens` arrived with Theme B: the turns now carry the harness's own usage
 * numbers (normalized at the API), so the entry has something honest to show
 * without overloading the harness's `/usage` command.
 *
 * A5 added `compact` beside Tier 2, in the harness's own group, because it
 * is a harness capability rather than a Wisp one. It is the exception Q6's
 * marking law has to name: a free-reads group entry that COSTS, so it
 * carries its own label — "runs a turn" where that is literally true (codex
 * records it in its thread; claude's is an ordinary turn via prefill),
 * "costs tokens" where it isn't (droid summarizes without recording a turn).
 * A failure does Q7's job one layer lower: the note names what failed and
 * points at /fresh, which is the lever that always works.
 */
export interface SlashEntry {
  /** the command name without the slash — the harness's own name for Tier 2 */
  name: string;
  /** one quiet line beside the command */
  hint: string;
  /** cmdk filter keywords beyond the name */
  keywords: string[];
  /**
   * Tier-2 identity: picking this entry runs the named probe instead of a
   * Tier-1 dispatch or a Tier-3 prefill. The probe prefix keeps this identity
   * distinct if a future native command ever shares the harness's name.
   */
  probe?: ProbeCommandName;
  /**
   * Tier-3 identity: the exact text a pick writes into the draft. `/name`
   * where the harness runs skills headless by slash (claude/droid); a
   * plain-text ask on codex, which has no headless slash surface (SP2) —
   * prefilling `/name` there would imply an invocation that does not exist.
   */
  prefill?: string;
  /**
   * A5 identity: picking this entry posts to /compact instead of a Tier-1
   * dispatch or a Tier-3 prefill — an out-of-turn ACTION (it summarizes, so
   * it costs tokens), confirmed in the note row with what the harness
   * honestly reported (removedCount, a replaced session, codex's turn).
   */
  compact?: boolean;
  /**
   * A5/Q6: the cost marker, overriding the group's `costsTurn` marker. The
   * harness group is free reads EXCEPT compact, so the one costing entry
   * carries its own label — "runs a turn" only where that is literally true.
   */
  costLabel?: string;
}

/**
 * Keep a harness probe's identity distinct from a Wisp-native command while
 * preserving the harness's own command name in the row.
 */
const PROBE_VALUE_PREFIX = "probe:";

export function slashValue(entry: SlashEntry): string {
  return entry.probe ? `${PROBE_VALUE_PREFIX}${entry.probe}` : entry.name;
}

/**
 * The command NAME behind a row's unique value — what the person is actually
 * typing. `probe:context` is bookkeeping; `context` is the command.
 */
export function slashName(value: string): string {
  return value.startsWith(PROBE_VALUE_PREFIX)
    ? value.slice(PROBE_VALUE_PREFIX.length)
    : value;
}

/**
 * cmdk gives extremely weak subsequence matches a positive score (`status`
 * matches `usage` at ~0.004). Anything under this is noise.
 */
const FUZZY_FLOOR = 0.05;

/**
 * How well one palette row answers what the person typed.
 *
 * cmdk's own scorer cannot do this job, because it knows nothing about which
 * part of a row is its NAME. Ask it to rank `context` and it returns **0.891
 * for every one** of `/context`, `/compact` and `/fresh` — the last two only
 * because they carry `context` as an alias, and `/context` no better because
 * its value is the disambiguating `probe:context` rather than its own name.
 * Equal scores fall back to list order, so the row under the cursor was
 * whichever happened to be first, and Enter ran a command nobody asked for.
 *
 * So the rank is banded, and the bands say what a `/` palette is for: you are
 * typing a command's NAME. An alias is how you FIND a name you did not know;
 * it never outranks the name itself.
 *
 *   1          the name is exactly what you typed
 *   0.7-0.9    the name starts with it, shortest completion first
 *   0.6        an alias is exactly what you typed
 *   0.5        an alias starts with it
 *   0.15-0.4   cmdk's fuzzy score over the NAME  (`ctx` -> `context`)
 *   0.05-0.14  cmdk's fuzzy score over the aliases
 *   0          no match
 */
export function slashScore(
  value: string,
  search: string,
  keywords: readonly string[] = [],
): number {
  const query = search.trim().toLowerCase();
  if (!query) return 1;

  const name = slashName(value).toLowerCase();
  const aliases = keywords.map((keyword) => keyword.toLowerCase());

  if (name === query) return 1;
  // a shorter completion is the likelier one: `co` means `/context` before it
  // means `/contextualize`
  if (name.startsWith(query)) return 0.7 + 0.2 * (query.length / name.length);
  if (aliases.includes(query)) return 0.6;
  if (aliases.some((alias) => alias.startsWith(query))) return 0.5;

  const byName = defaultFilter(name, query);
  if (byName >= FUZZY_FLOOR) return 0.15 + 0.25 * byName;

  const byAlias = defaultFilter(name, query, [...keywords]);
  return byAlias >= FUZZY_FLOOR ? 0.05 + 0.09 * byAlias : 0;
}

/** One tier as the palette renders it: a heading, its entries, and its cost. */
export interface SlashGroup {
  /** the `Eyebrow` over the group — "Wisp", the harness's name, "Skills" */
  label: string;
  entries: SlashEntry[];
  /** Q6: the only tier that costs a turn is the only tier that says so */
  costsTurn?: boolean;
  /**
   * A4 honesty row, muted and non-selectable, after the entries: codex's
   * malformed-skill reports ("N skills skipped by the harness") or claude's
   * pre-first-turn partial note. Absent when there is nothing to confess.
   */
  footer?: string;
  /** the footer's hover text — the skipped skills' own error messages */
  footerTitle?: string;
}

export type Tier1CommandName =
  | "status"
  | "log"
  | "interrupt"
  | "archive"
  | "push"
  | "attach"
  | "fresh"
  | "tokens";

export const TIER1_ENTRIES: SlashEntry[] = [
  { name: "status", hint: "state · turn · model · git", keywords: ["state", "git", "branch", "model"] },
  { name: "log", hint: "pin the conversation to the live tail", keywords: ["output", "stream", "tail", "focus"] },
  { name: "interrupt", hint: "kill the running turn", keywords: ["stop", "kill", "cancel"] },
  { name: "archive", hint: "archive the task (refuses on dirty/unpushed)", keywords: ["close", "finish", "done"] },
  { name: "push", hint: "push the task branch", keywords: ["git", "origin", "remote"] },
  { name: "attach", hint: "the interactive attach command, copyable", keywords: ["terminal", "session", "escape"] },
  {
    name: "fresh",
    hint: "next turn starts a fresh harness session",
    keywords: ["reset", "session", "context", "compact", "clear"],
  },
  {
    name: "tokens",
    hint: "task token totals by reported turn",
    // Deliberately no "usage" alias: /usage belongs to the harness, and an
    // unsupported harness must not silently fall through to a different report.
    keywords: ["turns", "reported", "total", "telemetry"],
  },
];

export function isTier1Command(name: string): name is Tier1CommandName {
  return TIER1_ENTRIES.some((entry) => entry.name === name);
}

/**
 * Tier 2 (A3): the harness's own out-of-turn reads, built from the adapter's
 * declared `probeCommands` — never hardcoded per harness in the UI, because
 * SP1 found availability is uneven (claude: both; droid: context only; codex:
 * usage only) and a hardcoded row would be a promise the harness can't keep.
 * The entry carries the harness's own command name: `/usage` means plan and
 * limits wherever the harness exposes it, while Wisp's task telemetry remains
 * available under the unambiguous Tier-1 `/tokens`.
 */
const TIER2_READS: Record<ProbeCommandName, { hint: string; keywords: string[] }> = {
  context: {
    hint: "the harness's own context report",
    keywords: ["context", "tokens", "window", "budget", "breakdown"],
  },
  usage: {
    hint: "the harness's own plan and limits report",
    keywords: ["usage", "limits", "plan", "quota", "credits", "rate"],
  },
};

export function tier2Entries(commands: ProbeCommandName[] | undefined): SlashEntry[] {
  return (commands ?? []).map((name) => ({ name, probe: name, ...TIER2_READS[name] }));
}

/**
 * A5: the harness's compaction, one entry in its own group. "prompt" prefills
 * the harness's own command (claude's /compact — an ordinary recorded turn);
 * "action" dispatches the daemon's out-of-band strategy, and `recordsTurn`
 * (codex's truth, SP1) decides whether the label says "runs a turn" or only
 * "costs tokens". null means compaction is honestly absent — no entry.
 */
export function compactEntry(compact: HarnessCompact | null | undefined): SlashEntry[] {
  if (!compact) return [];
  if (compact.kind === "prompt") {
    return [
      {
        name: "compact",
        hint: "summarize the session to shrink its context",
        keywords: ["compact", "context", "summarize", "shrink"],
        prefill: compact.prompt,
        costLabel: "runs a turn",
      },
    ];
  }
  return [
    {
      name: "compact",
      hint: compact.recordsTurn
        ? "summarize the session — the harness records it as a turn in its own history"
        : "summarize the session to shrink its context",
      keywords: ["compact", "context", "summarize", "shrink"],
      compact: true,
      costLabel: compact.recordsTurn ? "runs a turn" : "costs tokens",
    },
  ];
}

/**
 * Tier 3 (A4): the harness's own skills, as discovered by the daemon — the
 * hardcoded per-harness lists slice 4 shipped are deleted, because droid's
 * was stale within one release, which is the rot SP2 predicted. A name-only
 * skill (droid allows no description) renders a name-only row; the hint is
 * empty rather than invented. `invoke` comes from the harness's strategy:
 * "slash" prefills `/name`, "prompt" writes a plain-text ask.
 */
export function tier3Entries(
  skills: SkillEntry[] | undefined,
  invoke: "slash" | "prompt" | null | undefined,
): SlashEntry[] {
  return (skills ?? []).map((s) => ({
    name: s.name,
    hint: s.description ?? "",
    keywords: ["skill"],
    prefill: invoke === "prompt" ? `use the ${s.name} skill: ` : `/${s.name}`,
  }));
}

/**
 * The palette in the order it should be read: best row first, and the group
 * holding it first.
 *
 * cmdk re-sorts its own DOM by score, but it does that by moving nodes React
 * owns, and it never reached these rows — the list stayed in tier order no
 * matter what anything scored. cmdk then selects the FIRST row it finds, so
 * the order is not decoration: it is what Enter runs. Rank here, in the render
 * that produces the DOM, and cmdk's own pass becomes a no-op over an already
 * sorted list rather than the thing the answer depends on.
 *
 * Rows that score 0 are left in place at the end; cmdk unmounts them, and
 * dropping them here would take `CommandEmpty`'s count with them.
 */
export function rankSlashGroups(
  groups: SlashGroup[],
  query: string,
): SlashGroup[] {
  if (!query.trim()) return groups;
  const scored = groups.map((group) => {
    const rows = group.entries
      .map((entry) => ({
        entry,
        score: slashScore(slashValue(entry), query, entry.keywords),
      }))
      // stable, so an exact tie keeps the order the tier declared
      .sort((a, b) => b.score - a.score);
    return {
      group: { ...group, entries: rows.map((row) => row.entry) },
      best: rows[0]?.score ?? 0,
    };
  });
  return scored.sort((a, b) => b.best - a.best).map((row) => row.group);
}

/** The slash token the palette is bound to: `/` through the next whitespace. */
export interface SlashToken {
  /** index of the `/` in the draft */
  start: number;
  /** one past the token's last character */
  end: number;
  /** everything after the `/` — cmdk's filter query */
  query: string;
}

/**
 * The trigger and dismiss rule in one function: a `/` token counts only when
 * the draft is empty or the character before it is whitespace, and the caret
 * has to sit inside it. `hello/st` is a word, not a command; `hello /st` is a
 * command; moving the caret out of the token means there is no token under it,
 * which is how the palette knows to close.
 */
export function slashTokenAt(value: string, caret: number): SlashToken | null {
  if (caret < 0 || caret > value.length) return null;
  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1]!)) start -= 1;
  // start === caret means the caret sits BEFORE the slash — outside the token
  if (start === caret || value[start] !== "/") return null;
  let end = caret;
  while (end < value.length && !/\s/.test(value[end]!)) end += 1;
  return { start, end, query: value.slice(start + 1, end) };
}

/**
 * The /status inline note: `done · turn 3 · claude · sonnet (actual: xyz) ·
 * wisp/x · 2 dirty ↑1 unpushed`. Model is actual-vs-requested: the requested
 * model, with the harness-reported actual in parens when they differ.
 */
export function statusNote(task: ApiTask, status: StatusEntry | undefined): string {
  const parts: string[] = [task.state, `turn ${task.turn_count}`, task.harness];
  const requested = task.model ?? "no model";
  const actual = task.latest_turn_model ?? null;
  parts.push(actual && actual !== requested ? `${requested} (actual: ${actual})` : requested);
  if (status && status.worktreeReason === null) {
    const git: string[] = [];
    if (status.dirtyFiles > 0) git.push(`${status.dirtyFiles} dirty`);
    if (status.ahead > 0) git.push(`↑${status.ahead}`);
    if (status.unpushed) git.push("unpushed");
    parts.push(status.branch);
    parts.push(git.length > 0 ? git.join(" ") : "clean");
  } else if (status) {
    // never "clean" for a worktree git cannot read — that is the reported lie
    parts.push(status.branch);
    parts.push("no worktree to read");
  } else {
    parts.push("no git marks");
  }
  return parts.join(" · ");
}
