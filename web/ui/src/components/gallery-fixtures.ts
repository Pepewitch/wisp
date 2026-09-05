import { compactEntry, TIER1_ENTRIES, tier2Entries, tier3Entries, type SlashGroup } from "@/lib/slash"
import type {
  ProbeAnswer,
  PullRequestInfo,
  PullRequestOverviewEntry,
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

export const SURFACES = [
  { name: "Void", token: "--background", hex: "#0D0D10", note: "Reading column, stream, diff body" },
  { name: "Surface", token: "--surface", hex: "#0F0F12", note: "Sidebar, right pane, top bar, inputs" },
  { name: "Popover", token: "--popover", hex: "#131317", note: "Hover cards, menus, palette" },
  { name: "Card", token: "--card", hex: "#15151A", note: "Prompt bubbles, code blocks" },
  { name: "Hover", token: "--hover", hex: "#1A1A20", note: "Row hover — never a resting state" },
  { name: "Selected", token: "--accent", hex: "#1F1F26", note: "Background alone. No rail, no hue" },
  { name: "Border", token: "--border", hex: "#212128", note: "Pane dividers, hairlines" },
  { name: "Border strong", token: "--border-strong", hex: "#2B2B34", note: "Input edges, drag grips" },
] as const
