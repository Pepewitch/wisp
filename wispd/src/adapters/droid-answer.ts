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
  /** Names of the tools called since the last assistant text. */
  tools: string[];
  /** The last assistant text, when it only acknowledged bookkeeping. */
  acknowledgement: string | null;
}

/**
 * A Droid turn's answer, followed message by message: an assistant text
 * becomes the answer unless it only acknowledges bookkeeping, that is every
 * tool called since the previous text was a bookkeeping tool and the text is
 * short. Shared by the live driver (live/droid.ts) and the plain
 * `droid exec -o stream-json` parse (outcome.ts), so both report the same
 * result. The message itself still reaches the transcript unchanged.
 */
export class DroidAnswer {
  private state: DroidAnswerState = { answer: "", tools: [], acknowledgement: null };

  get answer(): string {
    return this.state.answer;
  }

  text(text: string): void {
    const { answer, tools } = this.state;
    const acknowledges = answer.trim() !== "" && tools.length > 0 && tools.every((name) => BOOKKEEPING_TOOLS.has(name))
      && text.trim().length <= ACKNOWLEDGEMENT_MAX_CHARS;
    this.state = acknowledges ? { answer, tools: [], acknowledgement: text } : { answer: text, tools: [], acknowledgement: null };
  }

  tool(name: string): void {
    this.state.tools.push(name);
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
    this.state = { answer: "", tools: [], acknowledgement: null };
  }

  checkpoint(): DroidAnswerState {
    return { ...this.state, tools: [...this.state.tools] };
  }

  restore(state: DroidAnswerState | undefined): void {
    this.state = state ? { ...state, tools: [...state.tools] } : { answer: "", tools: [], acknowledgement: null };
  }
}
