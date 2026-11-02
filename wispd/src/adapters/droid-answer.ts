/**
 * Tools whose calls only keep Droid's own books. Droid often acknowledges one
 * after its answer ("Plan is up-to-date."), and that line must not become the
 * turn's result.
 */
const BOOKKEEPING_TOOLS = new Set(["TodoWrite"]);

/** The longest assistant message after only bookkeeping tools that still counts as an acknowledgement. */
const ACKNOWLEDGEMENT_MAX_CHARS = 200;

export interface DroidAnswerState {
  answer: string;
  /** Whether any tool was called since the last assistant text. */
  tools: boolean;
  /** Whether every tool called since the last assistant text was a bookkeeping tool. */
  bookkeeping: boolean;
  /** The last assistant text, when it only acknowledged bookkeeping. */
  acknowledgement: string | null;
}

const EMPTY: DroidAnswerState = { answer: "", tools: false, bookkeeping: true, acknowledgement: null };

/**
 * A Droid turn's answer, followed message by message: an assistant text
 * becomes the answer unless it only acknowledges bookkeeping, that is every
 * tool called since the previous text was a bookkeeping tool and the text is
 * short. Shared by the live driver (live/droid.ts) and the plain
 * `droid exec -o stream-json` parse (outcome.ts), so both report the same
 * result. The message itself still reaches the transcript unchanged. Only
 * the turn's own messages and tools count: a subagent's are not its answer.
 */
export class DroidAnswer {
  private state: DroidAnswerState = { ...EMPTY };

  get answer(): string {
    return this.state.answer;
  }

  text(text: string): void {
    const { answer, tools, bookkeeping } = this.state;
    const acknowledges = answer.trim() !== "" && tools && bookkeeping && text.trim().length <= ACKNOWLEDGEMENT_MAX_CHARS;
    this.state = acknowledges ? { ...EMPTY, answer, acknowledgement: text } : { ...EMPTY, answer: text };
  }

  tool(name: string): void {
    this.state.tools = true;
    this.state.bookkeeping &&= BOOKKEEPING_TOOLS.has(name);
  }

  /**
   * Droid's own `finalText`, corrected: when it is the acknowledgement that
   * ended the turn, the answer before it.
   */
  result(finalText: string): string {
    const { acknowledgement, answer } = this.state;
    return acknowledgement !== null && finalText.trim() === acknowledgement.trim() ? answer : finalText;
  }

  reset(): void {
    this.state = { ...EMPTY };
  }

  checkpoint(): DroidAnswerState {
    return { ...this.state };
  }

  restore(state: DroidAnswerState | undefined): void {
    this.state = state && typeof state.tools === "boolean" ? { ...state } : { ...EMPTY };
  }
}
