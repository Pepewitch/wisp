/**
 * Open a client socket that sends upgrade headers. Bun's `WebSocket` takes
 * `{ headers }` as its second argument (the daemon's upgrade reads
 * `authorization`, `origin` and `cookie` from it), but the global constructor
 * type the compiler sees is the DOM one, whose second argument is only
 * `protocols`. The cast lives here once instead of at every call site.
 */
export function openWebSocket(url: string | URL, headers: Record<string, string>): WebSocket {
  const options: Bun.WebSocketOptions = { headers };
  return new WebSocket(url, options as unknown as string[]);
}
