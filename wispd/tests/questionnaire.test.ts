import { describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS, createActivityFormatter } from "../src/adapters";
import { formatAnswerMessage, parseQuestionnaire } from "../src/adapters/questionnaire";

/**
 * The plain-text half of AskUser. Verified against Droid 0.193.0's own tool
 * description, which is the only specification of this format there is.
 */
describe("parseQuestionnaire", () => {
  test("reads the documented shape, including (multi) and topics", () => {
    expect(
      parseQuestionnaire(
        [
          "1. [question] Which features do you want to enable? (multi)",
          "[topic] Features",
          "[option] Auth handling",
          "[option] Login Page",
          "",
          "2. [question] Which library should we use for date formatting?",
          "[topic] Library",
          "[option] Library ABC",
          "[option] Library BlaBla",
        ].join("\n"),
      ),
    ).toEqual([
      {
        index: 1,
        topic: "Features",
        question: "Which features do you want to enable?",
        multiSelect: true,
        options: ["Auth handling", "Login Page"],
      },
      {
        index: 2,
        topic: "Library",
        question: "Which library should we use for date formatting?",
        multiSelect: false,
        options: ["Library ABC", "Library BlaBla"],
      },
    ]);
  });

  test("(multi) is stripped from the label, not left in the question", () => {
    const [question] = parseQuestionnaire("1. [question] Toppings? (multi)\n[option] Olives\n[option] Basil");
    expect(question).toMatchObject({ question: "Toppings?", multiSelect: true });
  });

  test("survives the numbering and spacing a model actually emits", () => {
    expect(
      parseQuestionnaire("[question] Only one?\n[option]   Yes  \n[option] No"),
    ).toEqual([{ index: 1, topic: null, question: "Only one?", multiSelect: false, options: ["Yes", "No"] }]);
    expect(parseQuestionnaire("2) [question] Numbered with a paren\n[option] A\n[option] B")).toMatchObject([
      { index: 2, options: ["A", "B"] },
    ]);
  });

  test("a question with nothing to click is dropped rather than shown empty", () => {
    expect(parseQuestionnaire("1. [question] No options here")).toEqual([]);
    expect(parseQuestionnaire("[topic] Orphan\n[option] Stray")).toEqual([]);
    expect(parseQuestionnaire("")).toEqual([]);
    expect(parseQuestionnaire("just some prose")).toEqual([]);
  });
});

describe("formatAnswerMessage", () => {
  test("keeps the question text, because the tool call never got a result", () => {
    const questions = parseQuestionnaire(
      "1. [question] Where to?\n[option] Japan\n[option] Italy\n\n2. [question] Toppings? (multi)\n[option] Olives\n[option] Basil",
    );
    expect(
      formatAnswerMessage(questions, [
        { index: 1, answer: "Japan" },
        { index: 2, answer: "Olives, Basil" },
      ]),
    ).toBe("1. Where to? → Japan\n2. Toppings? → Olives, Basil");
  });
});

describe("Droid activity: questionnaires are a card, not a tool row", () => {
  function formatter() {
    return createActivityFormatter(BUILTIN_ADAPTERS.droid!);
  }
  function line(value: unknown): string {
    return JSON.stringify(value);
  }

  test("the AskUser tool call becomes a question, parsed from its own text", () => {
    const format = formatter();
    const events = format(
      line({
        type: "tool_call",
        id: "ask-1",
        toolName: "AskUser",
        parameters: { questionnaire: "1. [question] Where to?\n[topic] Travel\n[option] Japan\n[option] Italy" },
      }),
    );
    expect(events).toEqual([
      {
        kind: "question",
        id: "ask-1",
        parentId: null,
        timestamp: null,
        phase: "asked",
        questions: [
          { index: 1, topic: "Travel", question: "Where to?", multiSelect: false, options: ["Japan", "Italy"] },
        ],
      },
    ]);
  });

  test("its tool result is swallowed — the card already shows the answers", () => {
    const format = formatter();
    format(
      line({
        type: "tool_call",
        id: "ask-1",
        toolName: "AskUser",
        parameters: { questionnaire: "1. [question] Where to?\n[option] Japan\n[option] Italy" },
      }),
    );
    expect(format(line({ type: "tool_result", id: "ask-1", value: "1. Where to? → Japan" }))).toEqual([]);
  });

  test("the structured question event carries phases, answers and a cancel reason", () => {
    const format = formatter();
    expect(
      format(line({ type: "question", phase: "answered", id: "ask-1", answers: [{ index: 1, answer: "Japan" }] })),
    ).toMatchObject([{ kind: "question", id: "ask-1", phase: "answered", answers: [{ index: 1, answer: "Japan" }] }]);
    expect(
      format(line({ type: "question", phase: "cancelled", reason: "superseded", id: "ask-2" })),
    ).toMatchObject([{ kind: "question", id: "ask-2", phase: "cancelled", reason: "superseded" }]);
    // An unknown reason is not invented into the record.
    expect(format(line({ type: "question", phase: "cancelled", reason: "whatever", id: "ask-3" }))[0]).not.toHaveProperty(
      "reason",
    );
  });

  test("an unparseable AskUser stays a plain tool row rather than an empty card", () => {
    const format = formatter();
    expect(
      format(line({ type: "tool_call", id: "ask-1", toolName: "AskUser", parameters: { questionnaire: "???" } })),
    ).toMatchObject([{ kind: "tool", id: "ask-1", name: "AskUser", phase: "started" }]);
  });
});
