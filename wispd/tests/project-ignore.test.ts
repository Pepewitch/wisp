/**
 * One listed folder, at most two git processes: the check, and only when it
 * fails, the probe that tells "outside every repository" (nothing hidden)
 * from a repository git could not read (the request fails, never unfiltered).
 */
import { describe, expect, test } from "bun:test";
import { ignoredNames, IgnoreRulesUnreadable, type CheckIgnore, type IgnoreGit } from "../src/project-ignore";

function fakeGit(check: CheckIgnore, outside: boolean): IgnoreGit & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async checkIgnore(cwd, paths) {
      calls.push(`check ${cwd} ${paths.length}`);
      return check;
    },
    async outsideRepository(cwd) {
      calls.push(`probe ${cwd}`);
      return outside;
    },
  };
}

describe("ignoredNames", () => {
  test("asks once, from the folder, about every name", async () => {
    const git = fakeGit({ ok: true, ignored: new Set(["debug.log", "node_modules/"]) }, false);
    const ignored = await ignoredNames("/p/src", ["debug.log", "node_modules/", "index.ts"], git);
    expect([...ignored].sort()).toEqual(["debug.log", "node_modules/"]);
    expect(git.calls).toEqual(["check /p/src 3"]);
  });

  test("a folder git positively places outside every repository hides nothing", async () => {
    const git = fakeGit({ ok: false, detail: "fatal: not a git repository" }, true);
    expect(await ignoredNames("/plain", ["node_modules/"], git)).toEqual(new Set());
    expect(git.calls).toEqual(["check /plain 1", "probe /plain"]);
  });

  test("any other failure is an error, never an unfiltered answer", async () => {
    const git = fakeGit({ ok: false, detail: "fatal: bad config line 1" }, false);
    const failed = ignoredNames("/p", ["a", "b"], git);
    await expect(failed).rejects.toBeInstanceOf(IgnoreRulesUnreadable);
    await expect(failed).rejects.toThrow("couldn't read this project's ignore rules: fatal: bad config line 1");
    expect(git.calls).toHaveLength(2);
  });

  test("an empty folder asks git nothing", async () => {
    const git = fakeGit({ ok: true, ignored: new Set() }, false);
    expect(await ignoredNames("/p", [], git)).toEqual(new Set());
    expect(git.calls).toEqual([]);
  });
});
