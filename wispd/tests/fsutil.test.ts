import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathExists, readSlice, readTailOf, readTailSlice } from "../src/fsutil";

const dir = mkdtempSync(join(tmpdir(), "wisp-fsutil-"));

describe("readSlice", () => {
  test("reads from offset and reports the next offset", async () => {
    const p = join(dir, "a.log");
    writeFileSync(p, "0123456789");
    expect(await readSlice(p, 0, 4)).toEqual({ text: "0123", size: 4 });
    expect(await readSlice(p, 4, 100)).toEqual({ text: "456789", size: 10 });
    expect(await readSlice(p, 10, 100)).toEqual({ text: "", size: 10 }); // caught up
  });

  test("missing file yields empty at the same offset", async () => {
    expect(await readSlice(join(dir, "nope.log"), 5, 10)).toEqual({ text: "", size: 5 });
  });
});

describe("readTailOf", () => {
  test("short file returned whole; long file truncated with marker", async () => {
    const p = join(dir, "b.log");
    writeFileSync(p, "hello");
    expect(await readTailOf(p, 100)).toBe("hello");
    writeFileSync(p, "x".repeat(50) + "TAIL");
    expect(await readTailOf(p, 4)).toBe("…TAIL");
  });

  test("missing file is empty", async () => {
    expect(await readTailOf(join(dir, "nope.log"), 10)).toBe("");
  });
});

describe("readTailSlice", () => {
  test("same tail semantics as readTailOf, plus the offset a follow stream continues from", async () => {
    const p = join(dir, "d.log");
    writeFileSync(p, "0123456789");
    expect(await readTailSlice(p, 100)).toEqual({ text: "0123456789", size: 10 });
    expect(await readTailSlice(p, 4)).toEqual({ text: "…6789", size: 10 });
    // readSlice from the reported offset finds no gap and no overlap
    expect(await readSlice(p, 10, 100)).toEqual({ text: "", size: 10 });
  });

  test("missing file yields empty at offset 0", async () => {
    expect(await readTailSlice(join(dir, "nope.log"), 10)).toEqual({ text: "", size: 0 });
  });
});

describe("pathExists", () => {
  test("true for a real path, false for a missing one", async () => {
    const p = join(dir, "c.log");
    writeFileSync(p, "x");
    expect(await pathExists(p)).toBe(true);
    expect(await pathExists(join(dir, "nope.log"))).toBe(false);
  });
});
