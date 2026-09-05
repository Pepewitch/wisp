import type { ActivityEvent, ActivityStatus, TurnStatus } from "@/lib/types"

export interface TextActivityItem {
  kind: "text"
  id: string
  text: string
}

export interface ThinkingActivityItem {
  kind: "thinking"
  id: string
  text: string | null
}

export interface ToolActivityItem {
  kind: "tool"
  id: string
  name: string
  input: unknown
  output: string | null
  error: string | null
  status: "running" | "completed" | "failed"
}

export interface SubagentActivityItem {
  kind: "subagent"
  id: string
  /** Later child identity, when the harness reports one distinct from the call id. */
  agentId: string | null
  title: string
  agentType: string | null
  model: string | null
  effort: string | null
  prompt: string | null
  result: string | null
  error: string | null
  status: ActivityStatus
  startedAt: string | number | null
  endedAt: string | number | null
  durationMs: number | null
  background: boolean
  items: ActivityItem[]
}

export type ActivityItem = TextActivityItem | ThinkingActivityItem | ToolActivityItem | SubagentActivityItem

export type StreamBlock =
  | { kind: "separator"; turn: number; end: TurnStatus | null }
  | { kind: "you"; prompt: string }
  | { kind: "activity"; items: ActivityItem[] }
  | { kind: "raw"; text: string }

export interface StreamState {
  blocks: StreamBlock[]
  /** the turn currently being rendered; 0 = none */
  currentTurn: number
  note: string | null
}

export const initialStreamState: StreamState = { blocks: [], currentTurn: 0, note: null }

export type StreamAction =
  | { type: "reset"; note: string | null }
  | { type: "backlog"; turn: number; prompt: string | null; activity: ActivityEvent[] }
  | { type: "append"; turn: number; activity: ActivityEvent[] }
  | { type: "raw-backlog"; turn: number; prompt: string | null; text: string }
  | { type: "raw-append"; turn: number; text: string }
  | { type: "turn-end"; turn: number; status: TurnStatus }

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case "reset":
      return { blocks: [], currentTurn: 0, note: action.note }
    case "backlog": {
      const next = action.turn !== state.currentTurn ? openTurn(state, action.turn, action.prompt) : state
      return appendActivity(next, action.activity)
    }
    case "append": {
      const next = action.turn !== state.currentTurn ? openTurn(state, action.turn, null) : state
      return appendActivity(next, action.activity)
    }
    case "raw-backlog": {
      const next = action.turn !== state.currentTurn ? openTurn(state, action.turn, action.prompt) : state
      return appendRaw(next, action.text)
    }
    case "raw-append": {
      const next = action.turn !== state.currentTurn ? openTurn(state, action.turn, null) : state
      return appendRaw(next, action.text)
    }
    case "turn-end": {
      const start = state.blocks.findLastIndex(
        (block) => block.kind === "separator" && block.turn === action.turn && block.end === null,
      )
      const segment = start >= 0 ? state.blocks.slice(start) : []
      // Structured activity is only the live turn cache. Once settled, the
      // task detail row owns its conclusion and history reloads on demand.
      if (!segment.some((block) => block.kind === "raw")) {
        return { blocks: start >= 0 ? state.blocks.slice(0, start) : state.blocks, currentTurn: 0, note: null }
      }
      return {
        blocks: [...state.blocks, { kind: "separator", turn: action.turn, end: action.status }],
        currentTurn: 0,
        note: null,
      }
    }
  }
}

function openTurn(state: StreamState, turn: number, prompt: string | null): StreamState {
  const blocks: StreamBlock[] = [...state.blocks, { kind: "separator", turn, end: null }]
  if (prompt) blocks.push({ kind: "you", prompt })
  return { blocks, currentTurn: turn, note: state.note }
}

function appendActivity(state: StreamState, events: ActivityEvent[]): StreamState {
  if (events.length === 0) return state
  const blocks = state.blocks.slice()
  const last = blocks.at(-1)
  if (last?.kind === "activity") {
    const items = reduceActivity(last.items, events)
    if (items === last.items) return state
    blocks[blocks.length - 1] = { kind: "activity", items }
  } else {
    blocks.push({ kind: "activity", items: reduceActivity([], events) })
  }
  return { blocks, currentTurn: state.currentTurn, note: null }
}

function appendRaw(state: StreamState, text: string): StreamState {
  if (!text) return state
  const blocks = state.blocks.slice()
  const last = blocks.at(-1)
  if (last?.kind === "raw") blocks[blocks.length - 1] = { kind: "raw", text: last.text + text }
  else blocks.push({ kind: "raw", text })
  return { blocks, currentTurn: state.currentTurn, note: null }
}

/** Apply canonical events to one ordered, recursive activity tree. */
export function reduceActivity(items: ActivityItem[], events: ActivityEvent[]): ActivityItem[] {
  if (events.length === 0) return items
  const draft = new ActivityDraft(items)
  for (const event of events) draft.apply(event)
  return draft.changed ? draft.items : items
}

interface Slot<T extends ActivityItem> {
  container: ActivityItem[]
  index: number
  item: T
}

function firstValue<T>(first: T | null | undefined, second: T | null | undefined): T | null {
  return first ?? second ?? null
}

function firstValueOr<T>(
  fallback: T,
  first: T | null | undefined,
  second?: T | null | undefined,
): T {
  return first ?? second ?? fallback
}

function subagentEndedAt(
  event: Extract<ActivityEvent, { kind: "subagent" }>,
  prior: SubagentActivityItem | null,
  running: boolean,
): string | number | null {
  if (running) return null
  if (event.phase !== "completed") return prior?.endedAt ?? null
  return firstValue(event.timestamp, prior?.endedAt)
}

/**
 * One indexed mutable draft per SSE frame. Existing recursive arrays are
 * cloned once, then every event lookup is O(1); the previous reducer scanned
 * and copied the whole accumulated tree for every backlog event.
 */
class ActivityDraft {
  readonly items: ActivityItem[]
  changed = false
  private readonly tools = new Map<string, Slot<ToolActivityItem>>()
  private readonly thoughts = new Map<string, Slot<ThinkingActivityItem>>()
  private readonly subagents = new Map<string, Slot<SubagentActivityItem>>()

  constructor(items: ActivityItem[]) {
    this.items = this.clone(items)
  }

  private clone(items: ActivityItem[]): ActivityItem[] {
    const next: ActivityItem[] = []
    for (const item of items) {
      if (item.kind === "subagent") {
        const copy: SubagentActivityItem = { ...item, items: [] }
        next.push(copy)
        this.registerSubagent({ container: next, index: next.length - 1, item: copy })
        copy.items = this.clone(item.items)
      } else {
        next.push(item)
        this.register({ container: next, index: next.length - 1, item })
      }
    }
    return next
  }

  private register(slot: Slot<ActivityItem>): void {
    if (slot.item.kind === "tool" && !this.tools.has(slot.item.id)) {
      this.tools.set(slot.item.id, slot as Slot<ToolActivityItem>)
    } else if (slot.item.kind === "thinking" && !this.thoughts.has(slot.item.id)) {
      this.thoughts.set(slot.item.id, slot as Slot<ThinkingActivityItem>)
    }
  }

  private registerSubagent(slot: Slot<SubagentActivityItem>, alias?: string): void {
    for (const id of [slot.item.id, slot.item.agentId, alias]) {
      if (id && !this.subagents.has(id)) this.subagents.set(id, slot)
    }
  }

  private target(parentId: string | null): ActivityItem[] {
    return (parentId ? this.subagents.get(parentId)?.item.items : null) ?? this.items
  }

  private applyText(event: Extract<ActivityEvent, { kind: "text" }>): void {
    const target = this.target(event.parentId)
    const last = target.at(-1)
    if (last?.kind === "text") {
      const separator = last.text.endsWith("\n") ? "" : "\n"
      target[target.length - 1] = { ...last, text: last.text + separator + event.text }
    } else {
      target.push({ kind: "text", id: event.id, text: event.text })
    }
    this.changed = true
  }

  private applyThinking(event: Extract<ActivityEvent, { kind: "thinking" }>): void {
    const existing = this.thoughts.get(event.id)
    if (existing) {
      if (existing.item.text === event.text) return
      const item: ThinkingActivityItem = { kind: "thinking", id: event.id, text: event.text }
      existing.container[existing.index] = item
      existing.item = item
    } else {
      const target = this.target(event.parentId)
      const item: ThinkingActivityItem = { kind: "thinking", id: event.id, text: event.text }
      const slot = { container: target, index: target.length, item }
      target.push(item)
      this.thoughts.set(event.id, slot)
    }
    this.changed = true
  }

  private applyTool(event: Extract<ActivityEvent, { kind: "tool" }>): void {
    const previous = this.tools.get(event.id)
    const item: ToolActivityItem = {
      kind: "tool",
      id: event.id,
      name: event.name === "tool" && previous ? previous.item.name : event.name,
      input: event.input === undefined && previous ? previous.item.input : (event.input ?? null),
      output: event.output === undefined && previous ? previous.item.output : (event.output ?? null),
      error: event.error === undefined && previous ? previous.item.error : (event.error ?? null),
      status: event.phase === "started" ? "running" : event.error ? "failed" : "completed",
    }
    if (previous) {
      if (sameTool(previous.item, item)) return
      previous.container[previous.index] = item
      previous.item = item
    } else {
      const target = this.target(event.parentId)
      const slot = { container: target, index: target.length, item }
      target.push(item)
      this.tools.set(event.id, slot)
    }
    this.changed = true
  }

  private applySubagent(event: Extract<ActivityEvent, { kind: "subagent" }>): void {
    const agentId = event.agentId ?? null
    const previous = this.subagents.get(event.id) ?? (agentId ? this.subagents.get(agentId) : undefined)
    const prior = previous?.item ?? null
    const running = event.status === "running"
    const item: SubagentActivityItem = {
      kind: "subagent",
      id: firstValueOr(event.id, prior?.id),
      agentId: firstValue(event.agentId, prior?.agentId),
      title: firstValueOr("Subagent activity", event.title, prior?.title),
      agentType: firstValue(event.agentType, prior?.agentType),
      model: firstValue(event.model, prior?.model),
      effort: firstValue(event.effort, prior?.effort),
      prompt: firstValue(event.prompt, prior?.prompt),
      result: running ? null : firstValue(event.result, prior?.result),
      error: running ? null : firstValue(event.error, prior?.error),
      status: event.status,
      // Completion timestamps must not backfill startedAt. Claude's Bash
      // `task_*` events and some child-agent results only carry a time on the
      // terminal event; using it as both ends renders a finished card as 0s.
      startedAt: firstValue(prior?.startedAt, running ? event.timestamp : null),
      endedAt: subagentEndedAt(event, prior, running),
      durationMs: running ? null : firstValue(event.durationMs, prior?.durationMs),
      background: firstValueOr(false, event.background, prior?.background),
      items: prior?.items ?? [],
    }
    if (previous) {
      if (sameSubagent(previous.item, item)) {
        this.registerSubagent(previous, event.id)
        return
      }
      Object.assign(previous.item, item)
      this.registerSubagent(previous, event.id)
    } else {
      const target = this.target(event.parentId)
      const slot = { container: target, index: target.length, item }
      target.push(item)
      this.registerSubagent(slot, event.id)
    }
    this.changed = true
  }

  apply(event: ActivityEvent): void {
    switch (event.kind) {
      case "text":
        this.applyText(event)
        break
      case "thinking":
        this.applyThinking(event)
        break
      case "tool":
        this.applyTool(event)
        break
      case "subagent":
        this.applySubagent(event)
        break
    }
  }
}

function sameTool(left: ToolActivityItem, right: ToolActivityItem): boolean {
  return left.name === right.name &&
    left.input === right.input &&
    left.output === right.output &&
    left.error === right.error &&
    left.status === right.status
}

function sameSubagent(left: SubagentActivityItem, right: SubagentActivityItem): boolean {
  return left.id === right.id &&
    left.agentId === right.agentId &&
    left.title === right.title &&
    left.agentType === right.agentType &&
    left.model === right.model &&
    left.effort === right.effort &&
    left.prompt === right.prompt &&
    left.result === right.result &&
    left.error === right.error &&
    left.status === right.status &&
    left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt &&
    left.durationMs === right.durationMs &&
    left.background === right.background
}

/**
 * The "you" block collapse rule from the classic web app.
 */
export function youBlockDisplay(prompt: string): { collapsible: boolean; summary: string } {
  const firstLine = prompt.split("\n").find((line) => line.trim() !== "") ?? ""
  const collapsible = prompt.length > 500 || prompt.includes("\n\n")
  const summary = `you: ${firstLine.slice(0, 120)}${firstLine.length > 120 || prompt.length > 500 ? "…" : ""}`
  return { collapsible, summary }
}
