import { describe, expect, test } from "bun:test";
import { TaskCacheEntries } from "../src/task-cache";

describe("TaskCacheEntries", () => {
  test("an expired entry is removed when its key is read", () => {
    const entries = new TaskCacheEntries<string>(100, 10, 10);
    entries.set("task-a", "task-a:context", "report", 1_000);

    expect(entries.get("task-a:context", 1_099)?.value).toBe("report");
    expect(entries.get("task-a:context", 1_100)).toBeNull();
    expect(entries.size).toBe(0);
  });

  test("a fixed write interval sweeps expired entries that are never read again", () => {
    const entries = new TaskCacheEntries<string>(100, 10, 2);
    entries.set("task-a", "task-a:context", "old", 1_000);
    entries.set("task-b", "task-b:context", "current", 1_100);

    expect(entries.size).toBe(1);
    expect(entries.get("task-b:context", 1_100)?.value).toBe("current");
  });

  test("the oldest writes are removed at the size ceiling", () => {
    const entries = new TaskCacheEntries<string>(10_000, 2, 10);
    entries.set("task-a", "task-a:context", "a", 1);
    entries.set("task-b", "task-b:context", "b", 2);
    entries.set("task-c", "task-c:context", "c", 3);

    expect(entries.size).toBe(2);
    expect(entries.get("task-a:context", 3)).toBeNull();
    expect(entries.get("task-b:context", 3)?.value).toBe("b");
    expect(entries.get("task-c:context", 3)?.value).toBe("c");
  });

  test("task deletion removes every command for that task and leaves others", () => {
    const entries = new TaskCacheEntries<string>(10_000, 10, 10);
    entries.set("task-a", "task-a:context", "context", 1);
    entries.set("task-a", "task-a:usage", "usage", 1);
    entries.set("task-b", "task-b:context", "other", 1);

    entries.deleteTask("task-a");

    expect(entries.size).toBe(1);
    expect(entries.get("task-a:context", 1)).toBeNull();
    expect(entries.get("task-a:usage", 1)).toBeNull();
    expect(entries.get("task-b:context", 1)?.value).toBe("other");
  });
});
