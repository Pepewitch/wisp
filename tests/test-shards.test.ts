/**
 * CI's daemon shards: every test file runs in exactly one shard, and the
 * slow files spread out instead of landing together by name.
 */
import { describe, expect, test } from "bun:test";

import { assignShards, parseJunit, parseShard, readDurations, testFiles } from "../scripts/test-shards";

const load = (files: string[], seconds: Record<string, number>): number =>
  files.reduce((sum, file) => sum + (seconds[file] ?? 0), 0);

describe("assignShards", () => {
  test("the real suite: every file in exactly one shard, for any shard count", () => {
    const files = testFiles();
    expect(files.length).toBeGreaterThan(50);
    for (let count = 1; count <= 8; count++) {
      const shards = assignShards(files, readDurations(), count);
      expect(shards).toHaveLength(count);
      expect(shards.flat().sort()).toEqual(files);
      for (const shard of shards) expect(shard.length).toBeGreaterThan(0);
    }
  });

  test("slow files that sort next to each other go to different shards", () => {
    const seconds = { "tests/a.test.ts": 10, "tests/b.test.ts": 10, "tests/c.test.ts": 10 };
    const files = [...Object.keys(seconds), ...["d", "e", "f", "g", "h", "i"].map((n) => `tests/${n}.test.ts`)];
    const shards = assignShards(files, { ...seconds, ...Object.fromEntries(files.slice(3).map((f) => [f, 1])) }, 3);
    for (const shard of shards) expect(shard.filter((file) => file in seconds)).toHaveLength(1);
    expect(shards.map((shard) => shard.length)).toEqual([3, 3, 3]);
  });

  test("no shard exceeds an even share by more than its largest file", () => {
    const seconds = readDurations();
    const files = testFiles();
    const total = load(files, seconds);
    const largest = Math.max(...files.map((file) => seconds[file] ?? 0));
    for (const shard of assignShards(files, seconds, 6)) expect(load(shard, seconds)).toBeLessThanOrEqual(total / 6 + largest);
  });

  test("a file the map has never seen still runs, as a median-length file", () => {
    const seconds = { "tests/a.test.ts": 1, "tests/b.test.ts": 2, "tests/c.test.ts": 30 };
    const shards = assignShards([...Object.keys(seconds), "tests/new.test.ts"], seconds, 2);
    expect(shards.flat().sort()).toEqual([...Object.keys(seconds), "tests/new.test.ts"].sort());
    // c alone is heavier than everything else, so the newcomer joins a and b
    expect(shards.find((shard) => shard.includes("tests/c.test.ts"))).toEqual(["tests/c.test.ts"]);
  });

  test("files that take no measurable time spread across shards instead of piling onto one", () => {
    const files = Array.from({ length: 12 }, (_, i) => `tests/f${String(i).padStart(2, "0")}.test.ts`);
    const shards = assignShards(files, Object.fromEntries(files.map((file) => [file, 0])), 3);
    expect(shards.map((shard) => shard.length)).toEqual([4, 4, 4]);
  });
});

test("parseJunit sums each file's test cases, including nested describes", () => {
  const xml = `<testsuites><testsuite name="tests/a.test.ts" file="tests/a.test.ts" time="0">
    <testsuite name="group" file="tests/a.test.ts" time="0.3">
      <testcase name="one" classname="group" time="0.25" file="tests/a.test.ts" line="3" />
      <testcase name="two &amp; more" classname="group" time="1.5" file="tests/a.test.ts" line="9" />
    </testsuite></testsuite>
    <testsuite name="tests/b.test.ts" file="tests/b.test.ts"><testcase name="x" time="2" file="tests/b.test.ts" /></testsuite></testsuites>`;
  expect(parseJunit(xml)).toEqual({ "tests/a.test.ts": 1.75, "tests/b.test.ts": 2 });
});

test("parseShard accepts <index>/<count> and nothing else", () => {
  expect(parseShard("3/6")).toEqual({ index: 3, count: 6 });
  for (const bad of ["0/6", "7/6", "3", "3/0", "a/b", ""]) expect(() => parseShard(bad)).toThrow("shard must be");
});
