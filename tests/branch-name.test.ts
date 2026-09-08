import { describe, expect, test } from "bun:test";
import { BRANCH_WORDS, branchFor, branchWords } from "../src/branch-name";

describe("branch words", () => {
  test("the same id always names the same branch", () => {
    expect(branchFor("tabc12")).toBe(branchFor("tabc12"));
    expect(branchWords("tk9zdy")).toBe(branchWords("tk9zdy"));
  });

  // Golden values. The id → words mapping ends up in git history and on
  // remotes, so a refactor that silently renames what the NEXT branch would
  // have been should fail here rather than in someone's `git branch -a`.
  test("mapping is pinned", () => {
    expect(branchFor("tabc12")).toBe("wisp/tabc12-mighty-falcon");
    expect(branchFor("tk9zdy")).toBe("wisp/tk9zdy-rosy-bison");
    expect(branchFor("t00001")).toBe("wisp/t00001-calm-osprey");
  });

  test("different ids generally get different words", () => {
    const tags = new Set(Array.from({ length: 200 }, (_, i) => branchWords(`t${i.toString(36)}zz`)));
    // Collisions are allowed — the id keeps the ref unique either way — but a
    // hash that ignored most of its input would show up as a tiny set here.
    expect(tags.size).toBeGreaterThan(150);
  });

  test("carries only the id, never prompt text", () => {
    expect(branchFor("tabc12")).toStartWith("wisp/tabc12-");
    expect(branchFor("tabc12")).toMatch(/^wisp\/tabc12-[a-z]+-[a-z]+$/);
  });
});

describe("wordlists", () => {
  const lists = [
    ["adjectives", BRANCH_WORDS.ADJECTIVES],
    ["nouns", BRANCH_WORDS.NOUNS],
  ] as const;

  for (const [name, list] of lists) {
    // Powers of two: branchWords slices two disjoint bit ranges out of one
    // hash, and only a power-of-two length makes those picks unbiased.
    test(`${name} is 64 entries with no duplicates`, () => {
      expect(list.length).toBe(64);
      expect(new Set(list).size).toBe(64);
    });

    // A ref is a filename on every platform git runs on, and a word with an
    // apostrophe, a capital or a space would produce a branch that is awkward
    // to type and, on a case-insensitive filesystem, ambiguous.
    test(`${name} are plain lowercase words`, () => {
      for (const word of list) expect(word).toMatch(/^[a-z]{3,8}$/);
    });
  }
});
