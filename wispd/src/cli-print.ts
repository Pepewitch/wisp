/**
 * The one place the CLI writes to the console (eslint.config.js enforces it).
 *
 * Almost everything the CLI prints carries text Wisp did not write: an agent's
 * answer, a harness's stderr, a branch or file name from a repository, a
 * setup script's log. A terminal acts on escape sequences inside such text
 * (OSC 52 replaces the clipboard, CSI repaints the screen), so every line goes
 * through `controlFree` on its way out. Newlines and tabs survive, and Wisp's
 * own output carries no escape sequences to lose.
 */
import { controlFree, terminalJson } from "./control-free";

export function print(text: string): void {
  console.log(controlFree(text));
}

export function printError(text: string): void {
  console.error(controlFree(text));
}

/** `--json`: lossless, with the C1 controls `JSON.stringify` leaves raw escaped too. */
export function printJson(value: unknown): void {
  console.log(terminalJson(value));
}

/**
 * `--raw`: the retained bytes, unchanged, for a pipe or a file. A terminal
 * still gets them without control sequences.
 */
export function printRaw(text: string, to: "out" | "err" = "out"): void {
  const stream = to === "out" ? process.stdout : process.stderr;
  const write = to === "out" ? console.log : console.error;
  write(stream.isTTY ? controlFree(text) : text);
}
