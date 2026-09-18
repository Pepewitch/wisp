import type { QuestionPrompt } from "./types";

/**
 * Droid poses a questionnaire twice: as the plain text of the AskUser tool
 * call, and as the structured `droid.ask_user` request it then blocks on. The
 * structured one is authoritative — it is what the answer is matched against —
 * but only a live turn ever sees it, so the text is what a reloaded transcript,
 * a resumed session and a Droid too old to send the request are left with.
 *
 * The format, from Droid 0.193.0's own tool description:
 *
 *     1. [question] Which features do you want to enable? (multi)
 *     [topic] Features
 *     [option] Auth handling
 *     [option] Login Page
 *
 * 1–4 questions, `(multi)` marking multi-select. An own answer is never
 * listed: every interface offers it.
 */
export function parseQuestionnaire(text: string): QuestionPrompt[] {
  const questions: QuestionPrompt[] = [];
  let current: QuestionPrompt | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const question = line.match(/^(?:\d+\s*[.)]\s*)?\[question\]\s*(.+)$/i);
    if (question) {
      const label = question[1]!.trim();
      const multiSelect = /\(multi\)\s*$/i.test(label);
      current = {
        // Position, never the number in the text. Droid assigns indices
        // sequentially and matches an answer on ITS index, so honouring a
        // model's "3." here would build a card whose answers it then rejects.
        index: questions.length + 1,
        topic: null,
        question: multiSelect ? label.replace(/\s*\(multi\)\s*$/i, "").trim() : label,
        multiSelect,
        options: [],
      };
      questions.push(current);
      continue;
    }
    // A [topic] or [option] before any [question] has nothing to attach to.
    if (!current) continue;
    const topic = line.match(/^\[topic\]\s*(.+)$/i);
    if (topic) {
      current.topic = topic[1]!.trim();
      continue;
    }
    const option = line.match(/^\[option\]\s*(.+)$/i);
    if (option) current.options.push(option[1]!.trim());
  }
  // A question with nothing to click is not a questionnaire; the raw tool row
  // says more than an empty card would.
  return questions.filter((entry) => entry.question && entry.options.length > 0);
}
