import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { fakeDaemonTransport } from "@/test/runtime"
import type { DaemonTransport } from "@/lib/transport"

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
  readyState = 0
  constructor(url: string) {
    MockSocket.urls.push(url)
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
})
