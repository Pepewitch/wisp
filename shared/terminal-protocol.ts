/**
 * Frame limits of the task terminal WebSocket, shared by the daemon that
 * enforces them and the client that must stay inside them.
 */

/**
 * The largest frame the daemon accepts on a terminal socket, in bytes. Bun's
 * default is 16 MB, which an unauthenticated socket could send before the
 * daemon had parsed anything. A bigger frame closes the socket (1009).
 */
export const TERMINAL_MAX_FRAME_BYTES = 1024 * 1024;

/**
 * The most UTF-16 code units one `in` frame carries. JSON writes a control
 * character as six bytes (`\u001b`), so a chunk this long stays under
 * TERMINAL_MAX_FRAME_BYTES whatever a paste holds.
 */
export const TERMINAL_INPUT_CHUNK_UNITS = 128 * 1024;

/**
 * Terminal input split into frame-sized pieces, in order. A cut never lands
 * inside a surrogate pair, so every piece is valid text on its own and the
 * shell receives exactly the bytes of the whole.
 */
export function terminalInputChunks(data: string, maxUnits = TERMINAL_INPUT_CHUNK_UNITS): string[] {
  if (data.length <= maxUnits) return [data];
  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + maxUnits, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && end - start > 1 && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}
