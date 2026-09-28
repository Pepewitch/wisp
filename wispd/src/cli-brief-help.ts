/**
 * `wisp brief --help` and `wisp brief set --help`: what an agent reads the
 * first time a turn asks it for a brief, and again only after it lost track.
 *
 * PURE ON PURPOSE. index.ts prints these before anything imports config.ts,
 * which creates the Wisp home at import time — so the help works with no
 * daemon, no credentials, and a home that does not exist or cannot be written.
 * Import nothing here but the command name.
 *
 * The primary help is held to 300 words (tests/cli-brief.test.ts counts them),
 * because every word is model context spent on each reading. The decision
 * reference lives under `set --help` and is never fetched automatically.
 * Management verbs (enable, disable, show) are for people and appear in
 * `wisp help`, never here: an agent is never told to switch briefs on.
 */
import { wispCommand } from "./command"

export function briefHelp(): string {
  const cmd = wispCommand()
  return `${cmd} brief — a short report on this task for whoever returns to it.

When: once, at the end of your useful work in a turn, before your final reply,
only when Wisp's instruction for this turn asks. Reread only when
unfamiliar. It is best effort: if saving fails, finish normally — never
retry in a loop or start another turn just to fix a brief.

  ${cmd} brief set --stdin <<'JSON'
  {
    "version": 1,
    "goal": "Prevent duplicate saves without changing normal save behavior.",
    "outcome": "The duplicate-save bug is fixed; the regression test passes.",
    "remaining": ["Verify the behavior in the browser."]
  }
  JSON

Fields (every string needs real text):
  version      1
  outcome      required, ≤600 chars: the result or current blocker, in one or
               two plain sentences. Current state, not a command log.
  remaining    required: known gaps against the goal, ≤5 items of ≤240 chars.
               Group related gaps; say so if more remain than fit.
               [] = none known (not "goal complete"); null = you cannot say.
  goal         ≤240 chars: the task's overall purpose as you read it, not
               only this turn's request. Include it whenever known, even if
               unchanged.
  scopeChange  ≤400 chars, only if the work went beyond or away from what was
               asked: what and why — a needed repair, a user request, or an
               optional improvement. Not a work summary.
  decision     only when a choice changes the person's next step:
               see \`${cmd} brief set --help\`.

Each save replaces the whole brief; omitted fields are cleared. Write
"Not assessed" rather than guessing, name verification you did not do, and never
research just to fill a field. Publish it yourself, not from a subagent.
Skipped or unchanged saves exit 0; do not retry them. A field error exits 1:
fix it once. To revise this turn's brief deliberately: --replace <revision>.
`
}

export function briefSetHelp(): string {
  const cmd = wispCommand()
  return `${briefHelp()}
decision — include it only when a choice affects what the person does next:
  "decision": {
    "question": "Where should the duplicate-save guard live?",
    "recommendation": "In the document store, so every save path gets it.",
    "options": [
      { "label": "In the document store",
        "gain": "Covers the button, the shortcut and autosave in one place.",
        "downside": "Touches a shared module; needs the full editor test run.",
        "impact": "All editors. No API or file-format change.",
        "effort": "Small — about the size of the current fix." },
      { "label": "In the save button only",
        "gain": "Smallest change; already on the branch.",
        "downside": "Autosave can still write twice.",
        "impact": "Only the toolbar path; autosave users keep the bug.",
        "effort": null }
    ],
    "unknowns": ["Whether the offline queue replays saves — not assessed."]
  }

  question, recommendation (or null), and 1 to 3 options are required; every
  string is ≤240 chars; at most 3 unknowns. With a single option, add
  "alternativesNote" saying what else was considered, or that nothing was.
  impact names who or what behaviour changes and any compatibility concern —
  "low risk" alone says nothing. effort is relative, never a date; null when
  not assessed. Include the strongest real alternative, and never invent an
  option you did not consider. An obvious fix needs no decision at all.

Replacing: a save prints its revision. To replace this turn's brief on
purpose, run ${cmd} brief set --stdin --replace <that revision>.
`
}

/** The one-line hint for a `set` that would otherwise sit waiting on a terminal. */
export function briefSetUsage(): string {
  return `usage: ${wispCommand()} brief set --stdin [--replace <revision>]   (pipe the JSON brief on stdin; help: ${wispCommand()} brief --help)`
}

/**
 * Whether `args` (everything after `brief`) asks only for help — answered
 * before config loads. `set` with no `--stdin` is answered here too, with its
 * usage line, so it can never hang reading a terminal.
 */
export function briefOfflineAnswer(args: string[]): { text: string; exit: 0 | 2; stream: "out" | "err" } | null {
  const [sub, ...rest] = args
  const help = (list: string[]) => list.includes("--help") || list.includes("-h") || list.includes("help")
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") return { text: briefHelp(), exit: 0, stream: "out" }
  if (sub === "set" && help(rest)) return { text: briefSetHelp(), exit: 0, stream: "out" }
  if (sub === "set" && !rest.includes("--stdin")) return { text: briefSetUsage(), exit: 2, stream: "err" }
  return null
}
