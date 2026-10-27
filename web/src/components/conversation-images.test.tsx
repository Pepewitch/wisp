import { render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { outputImageNote, type OutputImage } from "../../../shared/api/outputs"
import { clearAssetCache } from "@/lib/asset-src"
import type { ActivityEvent, ConversationDetail, Turn } from "@/lib/types"
import { sameOriginWebTransport } from "@/lib/web-transport"
import { initialStreamState, streamReducer, type StreamState } from "@/stream/reducer"
import { runtimeWrapper } from "@/test/runtime"
import { Conversation } from "./conversation"

const image = (n: number, name: string, source: OutputImage["source"], step?: OutputImage["step"]): OutputImage => ({
  id: String(n).repeat(64), name, size: 489, mediaType: "image/png", source, ...(step ? { step } : {}),
})

const looked = image(1, "clip-ours.png", "native", { id: "toolu_read", label: "Read /work/clip-ours.png" })
const shared = image(2, "before.png", "published", { id: "toolu_bash", label: "wisp output add before.png" })
const loose = image(3, "loose.png", "native")
const elsewhere = image(4, "elsewhere.png", "native", { id: "not-in-this-timeline", label: "Read elsewhere.png" })

function task(turn: Partial<Turn>): ConversationDetail {
  return {
    id: "timages", title: "Images in their steps", repo_path: "/synthetic/repo",
    worktree_path: "/synthetic/worktree", branch: "wisp/timages", base_commit: null, harness: "fake", model: null,
    effort: null, slot: 1, state: "done", state_detail: null, session_id: null,
    seq: 1, turn_count: 1, archived: false, mode: "worktree",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
    messages: [],
    turns: [{
      id: 1, task_id: "timages", n: 1, prompt: "Compare the screens", result: "They match.", status: "done",
      model: null, usage: null, attachments: [], log_file: "/synthetic/log",
      started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:01:00Z", ...turn,
    }],
  } as ConversationDetail
}

const live = (activity: ActivityEvent[]): StreamState =>
  streamReducer(initialStreamState, { type: "backlog", turn: 1, prompt: "Compare the screens", activity })

const steps: ActivityEvent[] = [
  { kind: "tool", id: "toolu_read", parentId: null, phase: "started", name: "Read", input: { file_path: "/work/clip-ours.png" } },
  { kind: "tool", id: "toolu_read", parentId: null, phase: "completed", name: "tool", output: "ok" },
  { kind: "tool", id: "toolu_bash", parentId: null, phase: "started", name: "Bash", input: { command: "wisp output add before.png" } },
]

const draw = (detail: ConversationDetail, stream: StreamState = initialStreamState) =>
  render(<Conversation task={detail} stream={stream} />, { wrapper: runtimeWrapper(sameOriginWebTransport) })

const names = (node: Element | null) => [...(node?.querySelectorAll("img") ?? [])].map((img) => img.getAttribute("alt"))

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("png", { headers: { "content-type": "image/png" } }))
})
afterEach(() => { clearAssetCache(); vi.restoreAllMocks() })

describe("a turn's images", () => {
  it("render under the step that produced them while the steps are open", () => {
    draw(task({ status: "running", result: null, ended_at: null, outputs: [looked, shared, loose, elsewhere] }), live(steps))
    const article = screen.getByTestId("conversation-viewport").querySelector("[data-turn='1']")!
    const underRead = article.querySelector("[data-step-images='toolu_read']")
    expect(names(underRead)).toEqual(["clip-ours.png"])
    expect(names(article.querySelector("[data-step-images='toolu_bash']"))).toEqual(["before.png"])
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(screen.getByText("/work/clip-ours.png"), underRead!)).toBe(true)
    expect(follows(underRead!, screen.getByText("wisp output add before.png"))).toBe(true)
  })

  it("drop the transcript note of an image drawn under its step, keeping other notes and text", () => {
    const notes: ActivityEvent[] = [
      steps[0]!,
      { kind: "text", id: "n1", parentId: null, text: `· ${outputImageNote(looked)}` },
      { kind: "text", id: "n2", parentId: null, text: "Ours has one more row." },
      { kind: "text", id: "n3", parentId: null, text: `· ${outputImageNote(loose)}` },
      steps[1]!,
      { kind: "text", id: "n4", parentId: null, text: `· ${outputImageNote(looked)}` },
      steps[2]!,
    ]
    draw(task({ status: "running", result: null, ended_at: null, outputs: [looked, loose] }), live(notes))
    const activity = screen.getByTestId("conversation-viewport").querySelector("[data-activity='open']")!
    const text = activity.textContent ?? ""
    expect(names(activity.querySelector("[data-step-images='toolu_read']"))).toEqual(["clip-ours.png"])
    expect(text).not.toContain(looked.id)
    expect(text).toContain("Ours has one more row.")
    expect(text).toContain(`Image output: loose.png (489 bytes; ${loose.id})`)
  })

  it("put images without a step, or with a step the timeline lacks, at the end of the steps", () => {
    draw(task({ status: "running", result: null, ended_at: null, outputs: [looked, loose, elsewhere] }), live(steps))
    const activity = screen.getByTestId("conversation-viewport").querySelector("[data-activity='open']")!
    const tail = activity.querySelector("[data-step-images='']")
    expect(names(tail)).toEqual(["loose.png", "elsewhere.png"])
    expect(activity.lastElementChild).toBe(tail)
  })

  it("follow the answer only when the agent shared them, captioned with the sharing step", () => {
    draw(task({ outputs: [looked, shared, loose] }))
    const after = screen.getByLabelText("Agent output images")
    expect(names(after)).toEqual(["before.png"])
    expect(within(after).getByText("from: wisp output add before.png")).toBeInTheDocument()
    expect(screen.queryByRole("img", { name: "clip-ours.png" })).not.toBeInTheDocument()
    const article = screen.getByTestId("conversation-viewport").querySelector("[data-turn='1']")!
    const text = article.textContent ?? ""
    expect(text.indexOf("They match.")).toBeLessThan(text.indexOf("before.png"))
  })

  it("count on the collapsed steps row what the agent looked at, and show no pile after the answer", () => {
    draw(task({ outputs: [looked, loose] }))
    expect(screen.getByRole("button", { name: /Show activity/ })).toHaveTextContent("Show activity· looked at 2 images")
    expect(screen.queryByLabelText("Agent output images")).not.toBeInTheDocument()
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })

  it("say one image in the singular, and nothing when the agent only shared", () => {
    const view = draw(task({ outputs: [looked, shared] }))
    expect(screen.getByRole("button", { name: /Show activity/ })).toHaveTextContent("looked at 1 image")
    view.unmount()
    draw(task({ outputs: [shared] }))
    expect(screen.getByRole("button", { name: /Show activity/ })).not.toHaveTextContent("looked at")
  })
})
