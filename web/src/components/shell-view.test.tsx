import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { fakeDaemonTransport } from "@/test/runtime"
import type { DaemonTransport } from "@/lib/transport"

import { TRY_AGAIN_LATER, tryAgainLaterDelayMs } from "@/lib/terminal"

import { ShellView } from "./shell-view"

// xterm asks for the device pixel ratio's media query as it opens
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

class MockSocket {
  static urls: string[] = []
  static sockets: MockSocket[] = []
  readyState = 0
  onclose: ((event: { code: number }) => void) | null = null
  constructor(url: string) {
    MockSocket.urls.push(url)
    MockSocket.sockets.push(this)
  }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

describe("ShellView", () => {
  // The xterm is built by an effect that runs AFTER the connect effect, so a
  // connect that only read the terminal ref once sat on "connecting…" forever.
  it("opens the active tab's socket on mount", async () => {
    MockSocket.urls = []
    const transport = fakeDaemonTransport("local", {
      openWebSocket: ((url: string) => new MockSocket(url)) as unknown as DaemonTransport["openWebSocket"],
    })
    render(
      <ShellView
        transport={transport}
        taskId="t1"
        shellId={0}
        active
        register={() => {}}
        apple={false}
        daemonScreen={false}
        finding={null}
        onFind={() => {}}
        onFindClose={() => {}}
        touch={false}
      />,
    )
    await vi.waitFor(() => expect(MockSocket.urls.length).toBeGreaterThan(0))
    expect(MockSocket.urls[0]).toContain("/api/tasks/t1/terminal?shell=0")
  })

  // The daemon turns sockets away with 1013 while too many are waiting to
  // authenticate. That pane must come back on its own, not sit dead.
  it("retries a socket the daemon turned away with 1013 before hello", async () => {
    MockSocket.urls = []
    MockSocket.sockets = []
    const random = vi.spyOn(Math, "random").mockReturnValue(0)
    const requested: string[] = []
    const transport = fakeDaemonTransport("local", {
      openWebSocket: ((url: string) => new MockSocket(url)) as unknown as DaemonTransport["openWebSocket"],
      request: (async (path: string) => {
        requested.push(path)
        return {}
      }) as DaemonTransport["request"],
      // a browser transport, the one that asks the origin question
      socketToken: () => "token",
    })
    const view = render(
      <ShellView
        transport={transport}
        taskId="t1"
        shellId={0}
        active
        register={() => {}}
        apple={false}
        daemonScreen={false}
        finding={null}
        onFind={() => {}}
        onFindClose={() => {}}
        touch={false}
      />,
    )
    await vi.waitFor(() => expect(MockSocket.sockets.length).toBe(1))
    MockSocket.sockets[0]!.onclose?.({ code: TRY_AGAIN_LATER })
    await vi.waitFor(() => expect(MockSocket.sockets.length).toBe(2), { timeout: 2_000 })
    expect(MockSocket.urls[1]).toBe(MockSocket.urls[0])
    expect(view.container.textContent).not.toContain("refused")
    // the reason is known, so the pane does not ask why its origin was refused
    expect(requested.filter((path) => path.includes("terminal-origin"))).toEqual([])
    random.mockRestore()
  })

  it("spreads 1013 retries over 300 to 1500 ms", () => {
    expect(tryAgainLaterDelayMs(0)).toBe(300)
    expect(tryAgainLaterDelayMs(0.5)).toBe(900)
    expect(tryAgainLaterDelayMs(1)).toBe(1500)
  })
})
