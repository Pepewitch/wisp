import { describe, expect, test } from "bun:test";
import { emit, subscribe, type WispEvent } from "../src/events";

describe("events pub/sub", () => {
  test("subscribers receive emitted events; unsubscribe stops delivery", () => {
    const got: WispEvent[] = [];
    const unsub = subscribe((e) => got.push(e));
    emit({ type: "task", taskId: "tab12", state: "running", stateDetail: "turn 1", seq: 3 });
    expect(got).toEqual([{ type: "task", taskId: "tab12", state: "running", stateDetail: "turn 1", seq: 3 }]);
    unsub();
    emit({ type: "turn", taskId: "tab12", n: 1, status: "done" });
    expect(got.length).toBe(1); // nothing after unsubscribe
  });

  test("every subscriber receives the same event", () => {
    const a: WispEvent[] = [];
    const b: WispEvent[] = [];
    const unsubA = subscribe((e) => a.push(e));
    const unsubB = subscribe((e) => b.push(e));
    emit({ type: "turn", taskId: "tcd34", n: 2, status: "running" });
    unsubA();
    unsubB();
    expect(a).toEqual([{ type: "turn", taskId: "tcd34", n: 2, status: "running" }]);
    expect(b).toEqual(a);
  });

  test("a throwing subscriber is reported loudly but never breaks the emitter or other listeners", () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (msg: unknown) => errors.push(String(msg));
    const unsubBad = subscribe(() => {
      throw new Error("boom-listener");
    });
    const got: string[] = [];
    const unsubGood = subscribe((e) => got.push(e.type));
    try {
      emit({ type: "task", taskId: "tef56", state: "failed", stateDetail: "x", seq: 7 });
      expect(got).toEqual(["task"]); // later listeners still got the event
      expect(errors.some((m) => m.includes("boom-listener"))).toBe(true);
    } finally {
      console.error = orig;
      unsubBad();
      unsubGood();
    }
  });
});
