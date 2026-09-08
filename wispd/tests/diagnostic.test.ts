import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DiagnosticArchiveManager,
  type DiagnosticArchiveOptions,
} from "../src/recording/diagnostic";
import type { TurnDiagnosticCheckpoint } from "../src/store";

function fixture(overrides: Partial<DiagnosticArchiveOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "wisp-diagnostic-"));
  const checkpoints = new Map<number, TurnDiagnosticCheckpoint>();
  const options: DiagnosticArchiveOptions = {
    root,
    maxBytes: 10_000,
    retentionMs: 7 * 24 * 60 * 60 * 1_000,
    checkpoint: (turnId, checkpoint) => checkpoints.set(turnId, checkpoint),
    ...overrides,
  };
  return { root, checkpoints, manager: new DiagnosticArchiveManager(options) };
}

describe("diagnostic flight recorder", () => {
  test("writes ordered stdout/stderr JSONL with private permissions and a durable completion checkpoint", () => {
    const { root, checkpoints, manager } = fixture();
    const writer = manager.open(41);
    writer.record(1, "stdout", "first");
    writer.record(2, "stderr", "second");
    writer.finish();

    const files = readdirSync(root);
    expect(files).toEqual(["turn-41-000001.jsonl"]);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, files[0]!)).mode & 0o777).toBe(0o600);
    const records = readFileSync(join(root, files[0]!), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => [record.version, record.sequence, record.source, record.line])).toEqual([
      [1, 1, "stdout", "first"],
      [1, 2, "stderr", "second"],
    ]);
    expect(checkpoints.get(41)).toMatchObject({
      state: "complete",
      firstSeq: 1,
      lastSeq: 2,
      detail: null,
      evictedAt: null,
    });
    expect(checkpoints.get(41)!.bytes).toBe(statSync(join(root, files[0]!)).size);
  });

  test("evicts the oldest whole settled turn before admitting bytes past the global quota", () => {
    const { root, checkpoints, manager } = fixture({ maxBytes: 500 });
    const first = manager.open(51);
    first.record(1, "stdout", "a".repeat(250));
    first.finish();
    const second = manager.open(52);
    second.record(1, "stdout", "b".repeat(250));
    second.finish();

    expect(readdirSync(root)).toEqual(["turn-52-000001.jsonl"]);
    expect(checkpoints.get(51)).toMatchObject({ state: "evicted", bytes: 0, firstSeq: null, lastSeq: null });
    expect(checkpoints.get(52)?.state).toBe("complete");
  });

  test("an active turn degrades diagnostics instead of exceeding the hard quota or stopping the turn", () => {
    const { root, checkpoints, manager } = fixture({ maxBytes: 500 });
    const writer = manager.open(61);
    writer.record(1, "stdout", "a".repeat(250));
    writer.record(2, "stdout", "b".repeat(250));
    writer.finish();

    const bytes = readdirSync(root).reduce((total, file) => total + statSync(join(root, file)).size, 0);
    expect(bytes).toBeLessThanOrEqual(500);
    expect(checkpoints.get(61)).toMatchObject({ state: "partial", firstSeq: 1, lastSeq: 1 });
    expect(checkpoints.get(61)?.detail).toContain("global quota while active");
  });

  test("TTL enforcement evicts settled archives but never an active writer", () => {
    let now = Date.now();
    const root = mkdtempSync(join(tmpdir(), "wisp-diagnostic-ttl-"));
    mkdirSync(root, { recursive: true });
    const checkpoints = new Map<number, TurnDiagnosticCheckpoint>();
    const options: DiagnosticArchiveOptions = {
      root,
      maxBytes: 10_000,
      retentionMs: 1_000,
      now: () => now,
      checkpoint: (turnId, checkpoint) => checkpoints.set(turnId, checkpoint),
    };
    const manager = new DiagnosticArchiveManager(options);
    const first = manager.open(71);
    first.record(1, "stdout", "old");
    first.finish();
    now += 2_000;
    const restarted = new DiagnosticArchiveManager(options);
    const second = restarted.open(72);

    expect(checkpoints.get(71)?.state).toBe("evicted");
    expect(readdirSync(root)).toEqual([]);
    second.record(1, "stdout", "current");
    expect(readdirSync(root)).toEqual(["turn-72-000001.jsonl"]);
    second.finish();
  });
});
