/**
 * The ignore lookup fails closed: a folder git cannot answer for in one batch
 * is asked one candidate at a time, and a candidate it still cannot answer for
 * counts as ignored. Only a folder outside any work tree hides nothing.
 */
import { describe, expect, test } from "bun:test";
import { ignoredAsks, RETRY_CAP, type IgnoreGit } from "../src/project-ignore";

/** A git whose batch call always fails, and which answers single paths from `answers` (missing = fails). */
function failingGit(answers: Record<string, boolean>, insideWorkTree = true): IgnoreGit & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async checkIgnore(_cwd, paths) {
      calls.push(paths);
      if (paths.length > 1) return null;
      const answer = answers[paths[0]!];
      if (answer === undefined) return null;
      return answer ? new Set(paths) : new Set();
    },
    async insideWorkTree() {
      return insideWorkTree;
    },
  };
}

describe("ignoredAsks", () => {
  test("groups the asks by folder: one call per folder", async () => {
    const calls: string[] = [];
    const git: IgnoreGit = {
      async checkIgnore(cwd, paths) {
        calls.push(cwd);
        return new Set(paths.filter((path) => path.endsWith(".log")));
      },
      async insideWorkTree() {
        return true;
      },
    };
    const ignored = await ignoredAsks(
      [
        { cwd: "/p", path: "a.log" },
        { cwd: "/p", path: "src/" },
        { cwd: "/p/vendor", path: "b.log" },
      ],
      git,
    );
    expect(calls.sort()).toEqual(["/p", "/p/vendor"]);
    expect(ignored({ cwd: "/p", path: "a.log" })).toBe(true);
    expect(ignored({ cwd: "/p", path: "src/" })).toBe(false);
    expect(ignored({ cwd: "/p/vendor", path: "b.log" })).toBe(true);
  });

  test("a failed batch is retried one candidate at a time, and an unanswerable one is hidden", async () => {
    const git = failingGit({ "keep.ts": false, "drop.log": true });
    const ignored = await ignoredAsks(
      ["keep.ts", "drop.log", "unanswerable"].map((path) => ({ cwd: "/p", path })),
      git,
    );
    expect(ignored({ cwd: "/p", path: "keep.ts" })).toBe(false);
    expect(ignored({ cwd: "/p", path: "drop.log" })).toBe(true);
    expect(ignored({ cwd: "/p", path: "unanswerable" })).toBe(true);
    expect(git.calls).toEqual([["keep.ts", "drop.log", "unanswerable"], ["keep.ts"], ["drop.log"], ["unanswerable"]]);
  });

  test("a failed folder too large to retry hides all of it", async () => {
    const paths = Array.from({ length: RETRY_CAP + 1 }, (_, i) => `f${i}`);
    const git = failingGit(Object.fromEntries(paths.map((path) => [path, false])));
    const ignored = await ignoredAsks(paths.map((path) => ({ cwd: "/p", path })), git);
    expect(paths.every((path) => ignored({ cwd: "/p", path }))).toBe(true);
    expect(git.calls).toHaveLength(1);
  });

  test("outside any work tree there are no rules, so nothing is hidden", async () => {
    const ignored = await ignoredAsks([{ cwd: "/plain", path: "node_modules/" }], failingGit({}, false));
    expect(ignored({ cwd: "/plain", path: "node_modules/" })).toBe(false);
  });
});
