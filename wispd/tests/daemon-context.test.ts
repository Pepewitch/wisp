import { describe, expect, test } from "bun:test";
import { intervalService, startedService, stopServices, type DaemonService } from "../src/daemon-context";

describe("stopping a daemon's services", () => {
  test("in registration order, with every synchronous stop done before the first one yields", async () => {
    const stopped: string[] = [];
    let finishSlow!: () => void;
    const services: DaemonService[] = [
      { name: "timer a", stop: () => { stopped.push("timer a"); } },
      { name: "timer b", stop: () => { stopped.push("timer b"); } },
      { name: "runtime", stop: () => new Promise<void>((resolve) => { stopped.push("runtime"); finishSlow = resolve; }) },
      { name: "after", stop: () => { stopped.push("after"); } },
    ];
    const stopping = stopServices(services);
    // synchronously, up to and including the first asynchronous stop
    expect(stopped).toEqual(["timer a", "timer b", "runtime"]);
    await Bun.sleep(5);
    expect(stopped).toEqual(["timer a", "timer b", "runtime"]);
    finishSlow();
    await stopping;
    expect(stopped).toEqual(["timer a", "timer b", "runtime", "after"]);
  });

  test("a timer loop stops ticking, and a runtime is started once and stopped once", async () => {
    let ticks = 0;
    const timer = intervalService("ticker", setInterval(() => { ticks += 1; }, 1));
    const calls: string[] = [];
    const runtime = startedService("runtime", {
      start: () => { calls.push("start"); },
      stop: async () => { calls.push("stop"); },
    });
    expect(calls).toEqual(["start"]);
    await stopServices([timer, runtime]);
    const after = ticks;
    await Bun.sleep(20);
    expect(ticks).toBe(after);
    expect(calls).toEqual(["start", "stop"]);
  });
});
