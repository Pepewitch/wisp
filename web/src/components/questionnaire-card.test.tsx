import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { QuestionnaireCard } from "./questionnaire-card"
import type { QuestionActivityItem } from "@/stream/reducer"

function item(overrides: Partial<QuestionActivityItem> = {}): QuestionActivityItem {
  return {
    kind: "question",
    id: "ask-1",
    status: "asked",
    reason: null,
    answers: null,
    questions: [
      {
        index: 1,
        topic: "Travel",
        question: "Where to?",
        multiSelect: false,
        options: ["Japan", "Italy"],
      },
      {
        index: 2,
        topic: "Pizza",
        question: "Toppings?",
        multiSelect: true,
        options: ["Olives", "Basil"],
      },
    ],
    ...overrides,
  }
}

describe("QuestionnaireCard", () => {
  it("cannot be sent until every question has an answer", () => {
    const onSubmit = vi.fn()
    render(<QuestionnaireCard item={item()} state="pending" onSubmit={onSubmit} />)

    const send = screen.getByRole("button", { name: "Send answers" })
    expect(send).toBeDisabled()
    expect(screen.getByText("0 of 2 answered")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("radio", { name: /Japan/ }))
    expect(screen.getByText("1 of 2 answered")).toBeInTheDocument()
    expect(send).toBeDisabled()

    fireEvent.click(screen.getByRole("checkbox", { name: /Olives/ }))
    expect(send).toBeEnabled()
    fireEvent.click(send)
    expect(onSubmit).toHaveBeenCalledWith([
      { index: 1, answer: "Japan" },
      { index: 2, answer: "Olives" },
    ])
  })

  it("single choice replaces, multi choice accumulates in option order", () => {
    const onSubmit = vi.fn()
    render(<QuestionnaireCard item={item()} state="pending" onSubmit={onSubmit} />)

    fireEvent.click(screen.getByRole("radio", { name: /Japan/ }))
    fireEvent.click(screen.getByRole("radio", { name: /Italy/ }))
    // Clicked in the other order on purpose: the answer follows the harness's
    // option order so two people picking the same set send the same string.
    fireEvent.click(screen.getByRole("checkbox", { name: /Basil/ }))
    fireEvent.click(screen.getByRole("checkbox", { name: /Olives/ }))

    fireEvent.click(screen.getByRole("button", { name: "Send answers" }))
    expect(onSubmit).toHaveBeenCalledWith([
      { index: 1, answer: "Italy" },
      { index: 2, answer: "Olives, Basil" },
    ])
  })

  it("toggling a multi option off again removes it", () => {
    const onSubmit = vi.fn()
    render(<QuestionnaireCard item={item()} state="pending" onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole("radio", { name: /Japan/ }))
    fireEvent.click(screen.getByRole("checkbox", { name: /Olives/ }))
    fireEvent.click(screen.getByRole("checkbox", { name: /Olives/ }))
    expect(screen.getByText("1 of 2 answered")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled()
  })

  it("an own answer counts, and replaces the listed pick on a single-choice question", () => {
    const onSubmit = vi.fn()
    const single = item({
      questions: [
        { index: 1, topic: null, question: "Which library?", multiSelect: false, options: ["date-fns", "Day.js"] },
      ],
    })
    render(<QuestionnaireCard item={single} state="pending" onSubmit={onSubmit} />)

    fireEvent.click(screen.getByRole("radio", { name: /date-fns/ }))
    fireEvent.click(screen.getByRole("button", { name: /Or type your own answer/ }))
    fireEvent.change(screen.getByLabelText("Your own answer"), {
      target: { value: "Intl.DateTimeFormat" },
    })

    fireEvent.click(screen.getByRole("button", { name: "Send answer" }))
    expect(onSubmit).toHaveBeenCalledWith([{ index: 1, answer: "Intl.DateTimeFormat" }])
  })

  it("⌘↵ sends, and Escape hands focus back without discarding what is picked", () => {
    const onSubmit = vi.fn()
    const onFocusComposer = vi.fn()
    render(
      <QuestionnaireCard
        item={item()}
        state="pending"
        onSubmit={onSubmit}
        onFocusComposer={onFocusComposer}
      />,
    )
    const card = screen.getByTestId("questionnaire-card")

    fireEvent.keyDown(card, { key: "Escape" })
    expect(onFocusComposer).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("radio", { name: /Japan/ }))
    fireEvent.click(screen.getByRole("checkbox", { name: /Olives/ }))
    // The selections survived the Escape.
    expect(screen.getByText("2 of 2 answered")).toBeInTheDocument()

    fireEvent.keyDown(card, { key: "Enter", metaKey: true })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("an expired question offers no controls, whatever the caller passes", () => {
    const onSubmit = vi.fn()
    render(<QuestionnaireCard item={item()} state="expired" onSubmit={onSubmit} />)

    expect(screen.queryByRole("radio")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Send/ })).not.toBeInTheDocument()
    expect(screen.getByText("this question expired — answer in a message")).toBeInTheDocument()
    // The questions are still readable: they were really asked.
    expect(screen.getByText("Where to?")).toBeInTheDocument()
  })

  it("the log wins: a settled question never renders as pending", () => {
    const answered = item({
      status: "answered",
      answers: [{ index: 1, answer: "Japan" }, { index: 2, answer: "Olives, Basil" }],
    })
    render(<QuestionnaireCard item={answered} state="pending" onSubmit={vi.fn()} />)

    expect(screen.queryByRole("radio")).not.toBeInTheDocument()
    expect(screen.getByText("You answered")).toBeInTheDocument()
    expect(screen.getByText("Olives, Basil")).toBeInTheDocument()
  })

  it("names why it is read-only: superseded and stopped are different facts", () => {
    const { unmount } = render(
      <QuestionnaireCard item={item({ status: "cancelled", reason: "superseded" })} state="pending" />,
    )
    expect(screen.getByText("you replied in the message below")).toBeInTheDocument()
    unmount()

    render(<QuestionnaireCard item={item({ status: "cancelled", reason: "stopped" })} state="pending" />)
    expect(screen.getByText("the agent was stopped")).toBeInTheDocument()
  })

  it("locks while sending so one questionnaire is answered once", () => {
    const onSubmit = vi.fn()
    render(<QuestionnaireCard item={item()} state="submitting" onSubmit={onSubmit} />)
    const send = screen.getByRole("button", { name: "Sending…" })
    expect(send).toBeDisabled()
    fireEvent.click(send)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("shows the daemon's refusal on the card that failed", () => {
    render(
      <QuestionnaireCard
        item={item()}
        state="pending"
        error="this question is no longer waiting for an answer"
      />,
    )
    expect(screen.getByText("this question is no longer waiting for an answer")).toBeInTheDocument()
  })
})
