import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { FIND_REVEAL_EVENT } from "@/lib/find"
import type { ConversationDetail, TurnSource } from "@/lib/types"
import { initialStreamState } from "@/stream/reducer"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { Conversation } from "./conversation"

vi.mock("@/lib/clipboard", () => ({ writeClipboardText: vi.fn(() => Promise.resolve()) }))

/**
 * A turn input nobody typed (issue #442) wears the system frame, labelled
 * from the source the daemon stored with it; the person's own words, and
 * any turn without a source this client can name, keep the person's bubble.
 */
const at = new Date(Date.now() - 5.5 * 60_000).toISOString()

function turn(n: number, prompt: string, source?: TurnSource | null, origin: "background" | null = null) {
  // a settled turn with a result: nothing loads its timeline unasked
  return {
    id: n, task_id: "tsys", n, prompt, origin, result: `answer ${n}`, status: "done", model: "fake-model", usage: null,
    attachments: [], log_file: "/tmp/turn.log", started_at: at, ended_at: at, ...(source === undefined ? {} : { source }),
  }
}

function show(...turns: ReturnType<typeof turn>[]) {
  const task = {
    id: "tsys", title: "System turns", repo_path: "/tmp/repo", worktree_path: "/tmp/worktree", branch: "wisp/tsys",
    base_commit: "abc123", harness: "claude", model: "fake-model", effort: null, slot: 0, state: "done", state_detail: null,
    session_id: "session-1", seq: 2, turn_count: turns.length, archived: false, mode: "worktree", created_at: at, updated_at: at,
    turns, messages: [],
  } as unknown as ConversationDetail
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<Conversation task={task} stream={initialStreamState} />, { wrapper: runtimeWrapper(fakeDaemonTransport(), client) })
  return screen.getByTestId("conversation-viewport")
}

const block = (viewport: HTMLElement, n: number) => viewport.querySelector(`[data-turn="${n}"] [data-system-turn]`)
const bubbles = (viewport: HTMLElement) => viewport.querySelectorAll("[data-turn-prompt]").length

const FIX = "[Wisp auto-fix · PR #1176 · round 2 of 5 · head b6111e3]\nThe PR conflicts with main. Read PR-FEEDBACK.md; it lists what to address."

describe("a turn Wisp or the harness started", () => {
  it("an auto-fix round is Wisp's, named by its kind, PR and round", () => {
    const viewport = show(turn(1, FIX, { by: "autopilot", kind: "auto-fix", pr: 1176, round: 2, rounds: 5 }))
    const head = block(viewport, 1)!
    expect(head).toHaveAttribute("data-system-turn", "autopilot")
    expect(head).toHaveTextContent("Wisp·auto-fix·PR #1176·round 2 of 5")
    expect(head).toHaveTextContent("The PR conflicts with main.")
    expect(bubbles(viewport)).toBe(0)
  })

  it("auto-review's findings and its verdict reminder say they are auto-review's", () => {
    const viewport = show(
      turn(1, "[Wisp auto-review · PR #7 · round 1 of 3 · head abcdef0]", { by: "autopilot", kind: "auto-review", pr: 7, round: 1, rounds: 3 }),
      turn(2, "Your review is still open.", { by: "autopilot", kind: "review-nudge", pr: 7, round: 1, rounds: null }),
      turn(3, "The network dropped; continue from where you stopped.", { by: "autopilot", kind: "network-resume", pr: null, round: null, rounds: null }),
    )
    expect(block(viewport, 1)).toHaveTextContent("Wisp·auto-review·PR #7·round 1 of 3")
    expect(block(viewport, 2)).toHaveTextContent("Wisp·auto-review·verdict reminder·PR #7·round 1")
    expect(block(viewport, 3)).toHaveTextContent("Wisp·autopilot·resumed after the network dropped")
  })

  it("a heartbeat wake is Wisp's workflow", () => {
    const viewport = show(turn(1, "[Wisp heartbeat w1]\nRead HEARTBEAT.md and follow its objective.", { by: "workflow", kind: "heartbeat" }))
    expect(block(viewport, 1)).toHaveAttribute("data-system-turn", "workflow")
    expect(block(viewport, 1)).toHaveTextContent("Wisp·workflow·heartbeat")
  })

  it("a background notice is the harness's, by its product's name, never Wisp's", () => {
    const viewport = show(turn(1, 'Background update: Background command "sleeper" completed (exit code 0)',
      { by: "harness", kind: "background-update", harness: "claude" }, "background"))
    const head = block(viewport, 1)!
    expect(head).toHaveAttribute("data-system-turn", "harness")
    expect(head).toHaveTextContent("Claude Code·background update")
    expect(head).not.toHaveTextContent("Wisp")
  })

  it("the person's words stay theirs: text that reads like Wisp's, an older turn, and a source this client cannot name", () => {
    const viewport = show(
      turn(1, "[Wisp auto-fix · PR #1 · round 1 of 5] — I typed this", null),
      turn(2, FIX),
      turn(3, "from a newer daemon", { by: "someone-new", kind: "x" } as unknown as TurnSource),
    )
    expect(viewport.querySelector("[data-system-turn]")).toBeNull()
    expect(bubbles(viewport)).toBe(3)
  })

  it("a long one opens on its first lines; Show all, copy and find reach all of it", async () => {
    const long = [FIX, ...Array.from({ length: 8 }, (_, index) => `- step ${index + 1}`), "the last line"].join("\n")
    const viewport = show(turn(1, long, { by: "autopilot", kind: "auto-fix", pr: 1176, round: 2, rounds: 5 }))
    const head = block(viewport, 1) as HTMLElement
    const text = head.querySelector("[data-system-text]")!
    expect(text).toHaveAttribute("data-system-text", "collapsed")
    expect(text).toHaveClass("line-clamp-4")
    // clipped, not cut: the whole text is in the page for find-in-task
    expect(text).toHaveTextContent("the last line")
    fireEvent.click(within(head).getByRole("button", { name: "Show all" }))
    expect(text).toHaveAttribute("data-system-text", "open")
    fireEvent.click(within(head).getByRole("button", { name: "Show less" }))
    expect(text).toHaveAttribute("data-system-text", "collapsed")

    // a find match inside opens it before it is scrolled to
    text.firstChild!.dispatchEvent(new Event(FIND_REVEAL_EVENT, { bubbles: true }))
    expect(text).toHaveAttribute("data-system-text", "open")

    const { writeClipboardText } = await import("@/lib/clipboard")
    fireEvent.click(within(head).getByRole("button", { name: "Copy the message", hidden: true }))
    expect(writeClipboardText).toHaveBeenCalledWith(long)
  })

  it("a short one has nothing to open", () => {
    const viewport = show(turn(1, "[Wisp heartbeat w1]", { by: "workflow", kind: "heartbeat" }))
    expect(block(viewport, 1)!.querySelector("[data-system-text]")).toHaveAttribute("data-system-text", "short")
    expect(within(block(viewport, 1) as HTMLElement).queryByRole("button", { name: "Show all" })).toBeNull()
  })
})
