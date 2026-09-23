import { describe, expect, test } from "bun:test";
import {
  boundJsonRecord,
  SequencedRecordBudget,
  TailWindow,
  truncateUtf8,
} from "../src/recording/bounds";

describe("bounded recorder primitives", () => {
  test("UTF-8 truncation never splits a multi-byte code point", () => {
    expect(truncateUtf8("ab🙂cd", 5)).toEqual({ value: "ab", omittedBytes: 6 });
    expect(truncateUtf8("ab🙂cd", 6)).toEqual({ value: "ab🙂", omittedBytes: 2 });
  });

  test("unknown records are bounded structurally before serialization", () => {
    const record = boundJsonRecord(
      {
        type: "future.tool.result",
        huge: "x".repeat(200_000),
        nested: Array.from({ length: 500 }, (_, index) => ({ index, value: "y".repeat(2_000) })),
      },
      { maxRecordBytes: 4_096, maxStringBytes: 1_024, maxTotalStringBytes: 2_048, maxCollectionItems: 8 },
      300_000,
    );

    expect(record.bytes).toBeLessThanOrEqual(4_096);
    expect(record.truncated).toBe(true);
    expect(record.omittedBytes).toBeGreaterThan(0);
    expect(JSON.parse(record.json)).toBeDefined();
  });

  test("cycles, depth and collection fanout degrade to explicit omission markers", () => {
    const cyclic: Record<string, unknown> = { type: "future" };
    cyclic.self = cyclic;
    cyclic.items = Array.from({ length: 20 }, (_, index) => ({ index }));
    const record = boundJsonRecord(cyclic, { maxCollectionItems: 3, maxDepth: 2 });

    expect(record.truncated).toBe(true);
    expect(record.omittedValues).toBeGreaterThanOrEqual(2);
    expect(record.json).toContain("[wisp: omitted]");
  });

  test("one sequence spans retained and omitted records under byte and record ceilings", () => {
    const budget = new SequencedRecordBudget(12, 2);
    expect(budget.offer("{}", "message")).toEqual({ sequence: 1, bytes: 3, retained: true });
    expect(budget.offer("{\"a\":1}", "command")).toEqual({ sequence: 2, bytes: 8, retained: true });
    expect(budget.offer("{}", "command")).toEqual({ sequence: 3, bytes: 3, retained: false });
    expect(budget.offer("long", "message")).toEqual({ sequence: 4, bytes: 5, retained: false });

    expect(budget.snapshot()).toEqual({
      lastSequence: 4,
      retainedRecords: 2,
      retainedBytes: 11,
      omittedRecords: 2,
      omittedBytes: 8,
      firstOmittedSequence: 3,
      lastOmittedSequence: 4,
      omittedByCategory: {
        command: { records: 1, bytes: 3 },
        message: { records: 1, bytes: 5 },
      },
    });
  });

  test("the tail window keeps the newest records inside its byte and record ceilings", () => {
    const record = (line: string) => ({ source: "stdout" as const, line, bytes: line.length + 1, category: "event" });
    const tail = new TailWindow(10, 3);
    for (const line of ["aaa", "bbb", "ccc", "ddd"]) tail.push(record(line));
    // 4 bytes each: two fit in 10 bytes, so the oldest two were evicted.
    expect(tail.size).toBe(2);
    expect(tail.evictedRecords).toBe(2);
    expect(tail.evictedBytes).toBe(8);
    tail.push(record("x".repeat(20)));
    expect(tail.size).toBe(2); // a record larger than the window is evicted on arrival
    expect(tail.drain().map((kept) => kept.line)).toEqual(["ccc", "ddd"]);
    expect(tail.size).toBe(0);

    const counted = new TailWindow(1_000, 3);
    for (let i = 0; i < 5_000; i++) counted.push(record(String(i)));
    expect(counted.drain().map((kept) => kept.line)).toEqual(["4997", "4998", "4999"]);
    expect(counted.evictedRecords).toBe(4_997);
  });

  test("a reclaimed record leaves the omitted totals", () => {
    const budget = new SequencedRecordBudget(0, 10);
    budget.offer("{}", "message");
    budget.offer("{}", "command");
    budget.reclaim(3, "message");
    expect(budget.snapshot()).toMatchObject({
      omittedRecords: 1,
      omittedBytes: 3,
      omittedByCategory: { command: { records: 1, bytes: 3 } },
    });
  });
});
