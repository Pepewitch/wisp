/**
 * Text from outside Wisp — an agent's brief, a CI log, a person's message —
 * made safe to print to a terminal: CSI and OSC escape sequences removed
 * whole, then every remaining control character except tab and newline. An
 * OSC 52 sequence in a stored brief would otherwise write to the reader's
 * clipboard, and CSI could repaint their screen, whenever someone printed it.
 */
export function controlFree(line: string): string {
  return line
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
}

/**
 * JSON for a terminal: lossless, but with the C1 controls escaped as well —
 * `JSON.stringify` escapes only U+0000–U+001F, and a UTF-8 terminal may act
 * on a raw U+009B (CSI) or U+009D (OSC).
 */
export function terminalJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
}
