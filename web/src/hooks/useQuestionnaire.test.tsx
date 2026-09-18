import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ActivityList } from "@/components/activity-list"
import { QuestionnaireProvider } from "@/components/questionnaire-context"
import { useQuestionnaireController } from "@/hooks/useQuestionnaire"
import type { ConversationDetail } from "@/lib/types"
import type { QuestionActivityItem } from "@/stream/reducer"

/**
 * The submit path is exercised through a real mutation shim rather than a
 * `vi.fn()`: the lockouts and the refusal ARE the behaviour worth testing, and
 * a stubbed `mutate` proves none of them.
 */
const answer = vi.hoisted(() => ({
  calls: [] as { id: string; questionId: string }[],
  settle: null as null | ((outcome: { ok: true } | { error: Error }) => void),
}))

vi.mock("@/hooks/mutations", () => ({
  useAnswerQuestion: () => ({
    mutate: (
      variables: { id: string; questionId: string },
      handlers: { onSuccess: () => void; onError: (e: unknown) => void },
    ) => {
      answer.calls.push(variables)
      answer.settle = (outcome) =>
        "ok" in outcome ? handlers.onSuccess() : handlers.onError(outcome.error)
    },
  }),
}))
vi.mock("@/lib/runtime", () => ({ useDaemonRuntime: () => ({ connectionId: "local" }) }))
vi.mock("@/lib/api", () => ({ failureReason: (e: unknown) => (e as Error).message }))

beforeEach(() => {
  answer.calls = []
  answer.settle = null
})

function question(id: string, status: QuestionActivityItem["status"] = "asked"): QuestionActivityItem {
  return {
    kind: "question",
    id,
    status,
    reason: null,
    answers: status === "answered" ? [{ index: 1, answer: "Japan" }] : null,
    questions: [
      { index: 1, topic: "Travel", question: `Where to, ${id}?`, multiSelect: false, options: ["Japan", "Italy"] },
    ],
  }
}

function task(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    id: "t1",
    harness: "droid",
    state: "needs-input",
    pending_question_id: null,
    turns: [{ n: 1, status: "running" }],
    ...overrides,
  } as unknown as ConversationDetail
}

function Harness({ detail, items }: { detail: ConversationDetail; items: QuestionActivityItem[] }) {
  const questionnaire = useQuestionnaireController(detail, false)
  return (
    <QuestionnaireProvider value={questionnaire}>
      <ActivityList items={items} onBeforeToggle={() => {}} />
    </QuestionnaireProvider>
  )
}

describe("which questionnaire may be answered", () => {
  it("only the one the daemon names, once it has named one", () => {
    // An older harness can leave a question `asked` in the log with nothing
    // behind it. Both are open as far as the log knows; only one is answerable.
    render(<Harness detail={task({ pending_question_id: "ask-2" })} items={[question("ask-1"), question("ask-2")]} />)

    expect(screen.getAllByTestId("questionnaire-card").map((c) => c.dataset.state)).toEqual([
      "expired",
      "pending",
    ])
    expect(screen.getByText("this question expired — answer in a message")).toBeInTheDocument()
    expect(screen.getAllByRole("radio")).toHaveLength(3) // 2 options + the own-answer row
  })

  it("stays answerable while the daemon's answer is still in flight", () => {
    // The log delivers the question at once; `pending_question_id` arrives a
    // refetch later (400ms debounce). Defaulting to "expired" in that window
    // would tell the reader a live question is dead — the one lie that sends
    // them somewhere else entirely.
    render(<Harness detail={task({ pending_question_id: null })} items={[question("ask-1")]} />)
    expect(screen.getByTestId("questionnaire-card").dataset.state).toBe("pending")
  })

  it("is expired once the turn behind it is gone", () => {
    const settled = task({ pending_question_id: null, turns: [{ n: 1, status: "done" }] as never })
    render(<Harness detail={settled} items={[question("ask-1")]} />)
    expect(screen.getByTestId("questionnaire-card").dataset.state).toBe("expired")
    expect(screen.queryByRole("button", { name: /Send/ })).not.toBeInTheDocument()
  })

  it("an answered question renders its record, not a form, on the way back to the task", () => {
    // Switching away and back replays the same log bytes; the answered phase
    // is in them, so the card rebuilds settled rather than asking again.
    render(<Harness detail={task({ pending_question_id: "ask-1" })} items={[question("ask-1", "answered")]} />)
    expect(screen.getByText("You answered")).toBeInTheDocument()
    expect(screen.getByText("Japan")).toBeInTheDocument()
    expect(screen.queryByRole("radio")).not.toBeInTheDocument()
  })
})

describe("submitting", () => {
  function pending() {
    return render(<Harness detail={task({ pending_question_id: "ask-1" })} items={[question("ask-1")]} />)
  }

  it("stays locked after a success, so a second click cannot refuse an answer that worked", async () => {
    pending()
    fireEvent.click(screen.getByRole("radio", { name: "Japan" }))
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }))
    expect(answer.calls).toHaveLength(1)

    answer.settle!({ ok: true })
    // The daemon's `question` event settles the card for good; until it lands
    // the card must not re-offer Send for an answer already accepted.
    await waitFor(() => expect(screen.getByTestId("questionnaire-card").dataset.state).toBe("submitting"))
    fireEvent.click(screen.getByRole("button", { name: "Sending…" }))
    expect(answer.calls).toHaveLength(1)
  })

  it("a refusal unlocks the card and says so on the card itself", async () => {
    pending()
    fireEvent.click(screen.getByRole("radio", { name: "Japan" }))
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }))

    answer.settle!({ error: new Error("no longer waiting for an answer") })
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("no longer waiting for an answer"))
    // The answer demonstrably did not land, so the picks and Send come back.
    expect(screen.getByRole("button", { name: "Send answer" })).toBeEnabled()
  })

  it("keeps picks across a remount — a reconnect must not empty a half-filled card", () => {
    const detail = task({ pending_question_id: "ask-1" })
    const { rerender } = render(<Harness detail={detail} items={[question("ask-1")]} />)
    fireEvent.click(screen.getByRole("radio", { name: "Japan" }))
    expect(screen.getByText("1 of 1 answered")).toBeInTheDocument()

    // A stream reset empties the blocks before replaying them, so the card
    // really does unmount and remount underneath the reader.
    rerender(<Harness detail={detail} items={[]} />)
    rerender(<Harness detail={detail} items={[question("ask-1")]} />)
    expect(screen.getByText("1 of 1 answered")).toBeInTheDocument()
  })

  it("drops everything belonging to the previous task", () => {
    const { rerender } = render(
      <Harness detail={task({ pending_question_id: "ask-1" })} items={[question("ask-1")]} />,
    )
    fireEvent.click(screen.getByRole("radio", { name: "Japan" }))
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }))

    // Task B, its own question, while A's submit is still in flight. Without
    // the reset that stale `sending` swallows the first click here in silence.
    rerender(
      <Harness
        detail={task({ id: "t2", pending_question_id: "ask-9" }) as ConversationDetail}
        items={[question("ask-9")]}
      />,
    )
    expect(screen.getByText("0 of 1 answered")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("radio", { name: "Japan" }))
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }))
    expect(answer.calls.map((call) => call.questionId)).toEqual(["ask-1", "ask-9"])
  })
})
