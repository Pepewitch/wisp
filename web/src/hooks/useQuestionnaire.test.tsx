import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ActivityList } from "@/components/activity-list"
import { QuestionnaireProvider } from "@/components/questionnaire-context"
import { useQuestionnaireController } from "@/hooks/useQuestionnaire"
import type { ConversationDetail } from "@/lib/types"
import type { QuestionActivityItem } from "@/stream/reducer"

vi.mock("@/hooks/mutations", () => ({ useAnswerQuestion: () => ({ mutate: vi.fn() }) }))
vi.mock("@/lib/runtime", () => ({ useDaemonRuntime: () => ({ connectionId: "local" }) }))

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

function task(pendingQuestionId: string | null): ConversationDetail {
  return {
    id: "t1",
    harness: "droid",
    state: "needs-input",
    pending_question_id: pendingQuestionId,
    turns: [{ n: 1, status: "running" }],
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
  it("only the one the daemon names, even when the task is waiting", () => {
    // An older harness can leave a question `asked` in the log with nothing
    // behind it. Both are open as far as the log knows; only one is answerable.
    render(<Harness detail={task("ask-2")} items={[question("ask-1"), question("ask-2")]} />)

    const cards = screen.getAllByTestId("questionnaire-card")
    expect(cards.map((card) => card.dataset.state)).toEqual(["expired", "pending"])
    expect(screen.getByText("this question expired — answer in a message")).toBeInTheDocument()
    expect(screen.getAllByRole("radio")).toHaveLength(2) // the pending card's, and only its
  })

  it("names none once the daemon has released it, whatever the task state says", () => {
    render(<Harness detail={task(null)} items={[question("ask-1")]} />)
    expect(screen.getByTestId("questionnaire-card").dataset.state).toBe("expired")
    expect(screen.queryByRole("radio")).not.toBeInTheDocument()
  })

  it("an answered question renders its record, not a form, on the way back to the task", () => {
    // Switching away and back replays the same log bytes; the answered phase
    // is in them, so the card rebuilds settled rather than asking again.
    render(<Harness detail={task("ask-1")} items={[question("ask-1", "answered")]} />)
    expect(screen.getByText("You answered")).toBeInTheDocument()
    expect(screen.getByText("Japan")).toBeInTheDocument()
    expect(screen.queryByRole("radio")).not.toBeInTheDocument()
  })
})
