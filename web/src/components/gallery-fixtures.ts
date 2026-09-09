import { compactEntry, TIER1_ENTRIES, tier2Entries, tier3Entries, type SlashGroup } from "@/lib/slash"
import type {
  ProbeAnswer,
  SearchTaskHit,
  PullRequestInfo,
  PullRequestOverviewEntry,
  UpdateStatus,
} from "@/lib/types"
import type { ActivityItem } from "@/stream/reducer"

export const PR_SPECIMEN: PullRequestInfo = {
  number: 42,
  url: "https://github.com/acme/widgets/pull/42",
  title: "Show pull request status",
  lifecycle: "open",
  checks: "passed",
  review: "approved",
  mergeState: "ready",
  updatedAt: "2026-09-04T12:00:00Z",
}

export const UPDATE_SPECIMEN: UpdateStatus = {
  currentVersion: "0.4.0-alpha.6",
  latestVersion: "0.4.0-alpha.8",
  currentApiProtocolVersion: 1,
  latestApiProtocolVersion: 1,
  state: "available",
  installMethod: "homebrew",
  canAutoUpdate: true,
  message: null,
  checkedAt: "2026-09-05T12:00:00.000Z",
}

export const ROW_PR_SPECIMENS: Array<PullRequestOverviewEntry | undefined> = [
  {
    status: { kind: "found", provider: "github", pullRequest: PR_SPECIMEN },
    checkedAt: "2026-09-05T08:00:00Z",
    stale: false,
  },
  {
    status: {
      kind: "found",
      provider: "github",
      pullRequest: {
        ...PR_SPECIMEN,
        number: 43,
        review: "required",
        mergeState: "blocked",
      },
    },
    checkedAt: "2026-09-05T08:00:00Z",
    stale: false,
  },
  {
    status: {
      kind: "found",
      provider: "github",
      pullRequest: {
        ...PR_SPECIMEN,
        number: 44,
        lifecycle: "merged",
        mergeState: "unknown",
      },
    },
    checkedAt: "2026-09-05T08:00:00Z",
    stale: false,
  },
  undefined,
]

/** The palette as a claude task sees it: all three tiers (A3 Tier 2, A4 Tier 3, A5 compact). */
export const PALETTE_GROUPS: SlashGroup[] = [
  { label: "Wisp", entries: TIER1_ENTRIES },
  {
    label: "claude",
    entries: [...tier2Entries(["context", "usage"]), ...compactEntry({ kind: "prompt", prompt: "/compact" })],
  },
  {
    label: "Skills",
    entries: tier3Entries(
      [
        { name: "code-review", description: "Review code changes and find high-confidence bugs" },
        { name: "simplify", description: "Review the change for reuse, quality, and efficiency" },
        { name: "nameless", description: null },
      ],
      "slash",
    ),
    costsTurn: true,
  },
]

/** The probe panel with a structured answer, droid's context breakdown (A3). */
export const PROBE_CONTEXT_ANSWER: ProbeAnswer = {
  command: "context",
  probedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  cached: true,
  report: {
    format: "context",
    context: {
      model: "Opus 5",
      budgetTokens: 250000,
      usedTokens: 11981,
      freeTokens: 238019,
      categories: [
        { name: "System prompt", tokens: 1330 },
        { name: "Messages", tokens: 10280 },
      ],
      skills: [{ name: "find-skills", tokens: 79 }],
      mcpServers: [{ name: "linear", toolCount: 62, tokens: 371 }],
    },
  },
}

export const SUBAGENT_SPECIMEN: ActivityItem[] = [
  {
    kind: "subagent",
    id: "agent-trace",
    agentId: "session-explorer",
    title: "Trace subagent event flow",
    agentType: "explorer",
    model: null,
    effort: "medium",
    prompt: "Follow subagent lifecycle events from the harness stream into the conversation UI.",
    result: null,
    error: null,
    status: "running",
    startedAt: "2026-09-01T12:00:00.000Z",
    endedAt: null,
    durationMs: null,
    background: false,
    items: [
      { kind: "thinking", id: "agent-trace-thinking", text: "I’ll inspect the adapter boundary before the UI." },
      {
        kind: "tool",
        id: "agent-trace-read",
        name: "Read",
        input: { file_path: "src/adapters/activity.ts" },
        output: null,
        error: null,
        status: "running",
      },
    ],
  },
  {
    kind: "subagent",
    id: "agent-tests",
    agentId: "session-worker",
    title: "Verify parallel lifecycle handling",
    agentType: "worker",
    model: null,
    effort: "medium",
    prompt: "Run the adapter and reducer tests for parallel subagents.",
    result: null,
    error: "The child process exited before emitting its final result.",
    status: "failed",
    startedAt: "2026-09-01T12:00:02.000Z",
    endedAt: "2026-09-01T12:00:09.000Z",
    durationMs: 7_000,
    background: true,
    items: [
      {
        kind: "tool",
        id: "agent-tests-run",
        name: "Execute",
        input: { command: "bun test tests/activity.test.ts" },
        output: null,
        error: "Exited 1",
        status: "failed",
      },
    ],
  },
]

/**
 * Both scales, side by side, because the gallery is where a missing pair shows
 * up. The swatch itself is painted from the TOKEN, so it always tells the
 * truth about the theme on screen; the hex beside it is that theme's value.
 */
/**
 * Three hits for the search entry: two live and one archived, because the
 * archived section is exactly the part of the layout worth documenting. The
 * daemon located every match, so the offsets are its own.
 */
export const SEARCH_HITS: SearchTaskHit[] = [
  {
    id: "t5qmha",
    title: "Fix the steer box swallowing cmd-enter",
    repo_path: "/Users/dev/work/wisp",
    updated_at: new Date().toISOString(),
    state: "running",
    archived: false,
    matches: 3,
    snippets: [
      { kind: "prompt", turn: 2, text: "…the composer should vacuum its draft before…", offset: 22, length: 6 },
    ],
  },
  {
    id: "tppxvp",
    title: "Port the projects API to config write-back",
    repo_path: "/Users/dev/work/wisp",
    updated_at: new Date().toISOString(),
    state: "needs-input",
    archived: false,
    matches: 1,
    snippets: [{ kind: "result", turn: 1, text: "vacuum pass left 4 files changed", offset: 0, length: 6 }],
  },
  {
    id: "tk3wqa",
    title: "Vacuum the SSE bridge",
    repo_path: "/Users/dev/work/wisp",
    updated_at: new Date(Date.now() - 9 * 86_400_000).toISOString(),
    state: "done",
    archived: true,
    matches: 2,
    snippets: [{ kind: "message", turn: null, text: "also vacuum the reconnect path", offset: 5, length: 6 }],
  },
]

export const SURFACES = [
  { name: "Void", token: "--background", dark: "#141418", light: "#FBFBFD", note: "Reading column, stream, diff body" },
  { name: "Surface", token: "--surface", dark: "#19191D", light: "#F6F6F9", note: "Sidebar, right pane, top bar, inputs" },
  { name: "Code", token: "--code", dark: "#1B1B20", light: "#F1F1F5", note: "Code blocks — a step below the bubble" },
  { name: "Popover", token: "--popover", dark: "#1F1F25", light: "#FFFFFF", note: "Hover cards, menus, palette" },
  { name: "Card", token: "--card", dark: "#222228", light: "#EDEDF2", note: "Prompt bubbles, raised chrome" },
  { name: "Hover", token: "--hover", dark: "#292930", light: "#E9E9F0", note: "Row hover — never a resting state" },
  { name: "Selected", token: "--accent", dark: "#303038", light: "#E2E2EA", note: "Background alone. No rail, no hue" },
  { name: "Border", token: "--border", dark: "#2D2D35", light: "#E4E4EB", note: "Pane dividers, hairlines" },
  { name: "Border strong", token: "--border-strong", dark: "#3F3F48", light: "#CDCDD8", note: "Input edges, drag grips" },
] as const

/** The one hue, at the lightness each theme needs to keep it a word. */
export const ACCENTS = [
  { name: "Accent", cls: "bg-primary", dark: "oklch(.705 .155 300)", light: "oklch(.5 .19 300)" },
  { name: "Soft", cls: "bg-accent-soft", dark: "oklch(.79 .125 300)", light: "oklch(.55 .185 300)" },
  { name: "Dim", cls: "bg-accent-dim", dark: "oklch(.46 .105 300)", light: "oklch(.72 .13 300)" },
  { name: "Wash", cls: "bg-accent-wash", dark: "15% α", light: "14% α" },
] as const
