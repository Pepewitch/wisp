import { act, render } from "@testing-library/react"
import { useRef } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { TaskMessage } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"

import { useRevealMessage } from "./useRevealMessage"

const message = (over: Partial<TaskMessage>): TaskMessage => ({
  id: "m1", task_id: "t1", context_n: 1, harness: "codex", model: null, effort: null, fast: false,
  text: "Fix the lint failure\nin save-guard.ts", status: "delivered", delivery: "started", turn_n: 3,
  delivery_uncertain: false, deferred: false, attachments: [], created_at: "2026-09-30T09:00:00Z", updated_at: "2026-09-30T09:00:00Z",
  ...over,
} as TaskMessage)

function Transcript({ connection, messages, children }: { connection: string; messages: TaskMessage[]; children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  useRevealMessage(root, uiIntentsFor(connection), messages)
  return <div ref={root}>{children}</div>
}

afterEach(() => vi.restoreAllMocks())

describe("View message", () => {
  it("scrolls to a queued or steered message where it is, and to the turn a started message began", () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    const intents = uiIntentsFor("reveal-a")
    const { getByText } = render(
      <Transcript connection="reveal-a" messages={[message({ id: "m1" }), message({ id: "m2", status: "queued", delivery: null, turn_n: null })]}>
        <article data-turn="3">turn three</article>
        <article data-message="m2">queued</article>
      </Transcript>,
    )
    act(() => intents.revealMessage("m2"))
    expect(scrolled.mock.contexts.at(-1)).toBe(getByText("queued"))
    act(() => intents.revealMessage("m1"))
    expect(scrolled.mock.contexts.at(-1)).toBe(getByText("turn three"))
  })

  it("hands a turn that is not mounted yet to find-in-task, which loads pages until it is", () => {
    Element.prototype.scrollIntoView = vi.fn()
    const intents = uiIntentsFor("reveal-b")
    render(<Transcript connection="reveal-b" messages={[message({ id: "m1", turn_n: 1 })]}><article data-turn="9" /></Transcript>)
    act(() => intents.revealMessage("m1"))
    expect(intents.findRequest()).toMatchObject({ query: "Fix the lint failure", turn: 1 })
  })
})
