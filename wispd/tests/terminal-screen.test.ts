import { describe, expect, test } from "bun:test";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { SCROLLBACK_LINES, TerminalScreen } from "../src/terminal-screen";

/** A prompt that draws a full-width rule, the way oh-my-zsh's af-magic does. */
const rule = (width: number) => `\x1b[38;5;237m${"-".repeat(width)}\x1b[00m`;
const prompt = "\x1b[38;5;032m~/work \x1b[38;5;105m»\x1b[00m ";
/** zsh's reset-prompt on SIGWINCH: up one line, erase down, draw it again. */
const redraw = "\r\r\x1b[A\x1b[0m\x1b[27m\x1b[24m\x1b[J";

/** Strip OSC and CSI so an assertion reads the text a person would see. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex -- escape sequences are the subject here
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function ruleRows(text: string): number {
  return plain(text)
    .split("\n")
    .filter((line) => /^-{4,}/.test(line.trim())).length;
}

/** Render a stream the way a browser tab would, at a given width. */
async function render(width: number, stream: string): Promise<string> {
  const term = new Terminal({ cols: width, rows: 24, scrollback: 200, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  await new Promise<void>((resolve) => term.write(stream, resolve));
  const text = serializer.serialize({ scrollback: 200 });
  serializer.dispose();
  term.dispose();
  return text;
}

describe("terminal screen model", () => {
  test("a snapshot is a screen, not the history that produced it", async () => {
    // The shell prints its prompt, then redraws it twice — every draw correct
    // for the 58 columns the pty actually had.
    const width = 58;
    const stream = `${rule(width)}\r\n${prompt}${redraw}${rule(width)}\r\n${prompt}${redraw}${rule(width)}\r\n${prompt}`;

    const screen = new TerminalScreen({ cols: width, rows: 9 });
    screen.write(stream);
    const snapshot = await screen.snapshot();
    expect(ruleRows(snapshot)).toBe(1);

    // Replaying the RAW stream one column narrower is the old behaviour, and
    // it is where the stacked dashed lines came from: each redraw backs up one
    // line, the wrapped rule occupies two, so the previous rule is never
    // erased. The snapshot has no such history to re-execute.
    expect(ruleRows(await render(width - 1, stream))).toBeGreaterThan(1);
    expect(ruleRows(await render(width - 1, snapshot))).toBe(1);
    screen.dispose();
  });

  test("the snapshot restores what the client should be looking at", async () => {
    const screen = new TerminalScreen({ cols: 40, rows: 10 });
    screen.write("first line\r\nsecond line\r\n$ half-typed");
    const restored = plain(await render(40, await screen.snapshot()));
    expect(restored).toContain("first line");
    expect(restored).toContain("second line");
    expect(restored).toContain("$ half-typed");
    screen.dispose();
  });

  test("reattaching mid-vim gets the alternate screen, not the shell behind it", async () => {
    const screen = new TerminalScreen({ cols: 40, rows: 10 });
    screen.write("shell scrollback here\r\n");
    screen.write("\x1b[?1049h\x1b[H\x1b[2JEDITOR CONTENT\r\n~\r\n~");
    const snapshot = await screen.snapshot();
    expect(snapshot).toContain("?1049");
    expect(plain(await render(40, snapshot))).toContain("EDITOR CONTENT");
    screen.dispose();
  });

  test("terminal modes survive, so paste and arrow keys keep working", async () => {
    const screen = new TerminalScreen({ cols: 40, rows: 10 });
    screen.write("\x1b[?2004h\x1b[?1h\x1b=$ ");
    const snapshot = await screen.snapshot();
    expect(snapshot).toContain("?2004");
    expect(snapshot).toContain("?1h");
    screen.dispose();
  });

  test("a resize moves the model with the pty", async () => {
    const screen = new TerminalScreen({ cols: 80, rows: 24 });
    screen.resize({ cols: 58, rows: 9 });
    expect(screen.size).toEqual({ cols: 58, rows: 9 });
    screen.dispose();
  });

  test("memory is bounded by the screen, not by how long the shell has run", async () => {
    const screen = new TerminalScreen({ cols: 40, rows: 10 });
    for (let i = 0; i < SCROLLBACK_LINES * 3; i++) screen.write(`line ${i}\r\n`);
    const snapshot = await screen.snapshot();
    expect(snapshot.split("\n").length).toBeLessThanOrEqual(SCROLLBACK_LINES + 20);
    expect(snapshot).toContain(`line ${SCROLLBACK_LINES * 3 - 1}`);
    expect(snapshot).not.toContain("line 0\n");
    screen.dispose();
  });
});
