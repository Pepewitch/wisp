import { describe, expect, test } from "bun:test";
import { maxTier, parseNumstat, signalsOf, tierOf } from "../src/verify/depth";

const file = (path: string, added = 1, removed = 0) => ({ path, added, removed });

describe("review depth", () => {
  test("auth and token files are sensitive; words that merely contain them are not", () => {
    const deep = (path: string) => tierOf(signalsOf([{ path, added: 1, removed: 0 }], { areas: 0 })) === "deep";
    for (const path of ["src/auth.ts", "lib/auth/index.ts", "src/user-auth.ts", "src/oauth2.ts", "src/api-token.ts", "src/token.ts"]) expect(deep(path)).toBe(true);
    for (const path of ["src/author.ts", "src/authoring.ts", "src/tokenizer.ts"]) expect(deep(path)).toBe(false);
  });

  test("docs-only and tiny changes are light", () => {
    expect(tierOf(signalsOf([file("README.md", 400, 10), file("docs/guide.md", 50)], { areas: 0 }))).toBe("light");
    expect(tierOf(signalsOf([file("src/a.ts", 10, 5), file("src/b.ts", 3, 1)], { areas: 1 }))).toBe("light");
  });

  test("an ordinary change is standard", () => {
    expect(tierOf(signalsOf([file("src/a.ts", 80, 20), file("src/a.test.ts", 30, 0)], { areas: 1 }))).toBe("standard");
    expect(tierOf(signalsOf([file("src/a.ts", 20), file("src/b.ts", 10), file("src/c.ts", 5), file("src/d.ts", 1)], { areas: 1 }))).toBe("standard");
  });

  test("a sensitive path, a large diff, many files or many areas are deep", () => {
    expect(tierOf(signalsOf([file("db/migrations/0042_add.sql", 3)], { areas: 1 }))).toBe("deep");
    expect(tierOf(signalsOf([file("package.json", 1, 1)], { areas: 0 }))).toBe("deep");
    expect(tierOf(signalsOf([file(".github/workflows/ci.yml", 2)], { areas: 0 }))).toBe("deep");
    expect(tierOf(signalsOf([file("src/a.ts", 700)], { areas: 1 }))).toBe("deep");
    expect(tierOf(signalsOf(Array.from({ length: 26 }, (_, i) => file(`src/f${i}.ts`)), { areas: 1 }))).toBe("deep");
    expect(tierOf(signalsOf([file("a/x.ts", 5), file("b/y.ts", 5), file("c/z.ts", 5)], { areas: 3 }))).toBe("deep");
  });

  test("a project's own sensitive globs count too", () => {
    expect(tierOf(signalsOf([file("billing/charge.ts", 4)], { areas: 1 }))).toBe("light");
    expect(tierOf(signalsOf([file("billing/charge.ts", 4)], { areas: 1, sensitive: ["billing/**"] }))).toBe("deep");
  });

  test("a diff Wisp could not read is deep: nothing about it can be shown safe", () => {
    expect(tierOf(null)).toBe("deep");
  });

  test("lockfile lines are not counted, but a manifest is sensitive", () => {
    expect(signalsOf([file("bun.lock", 5000, 4000)], { areas: 0 }).lines).toBe(0);
    expect(tierOf(signalsOf([file("bun.lock", 5000, 4000)], { areas: 0 }))).toBe("light");
    expect(tierOf(signalsOf([file("package.json", 1, 1), file("bun.lock", 900)], { areas: 0 }))).toBe("deep");
  });

  test("markdown outside docs is not documentation, and agent instruction files are sensitive", () => {
    expect(signalsOf([file("skills/wisp/references/cli.md", 100)], { areas: 0 }).docsOnly).toBe(false);
    expect(tierOf(signalsOf([file("AGENTS.md", 2)], { areas: 0 }))).toBe("deep");
    expect(tierOf(signalsOf([file("wispd/src/migration-auto-review.ts", 3)], { areas: 1 }))).toBe("deep");
  });

  test("a small change outside every area of a mapped project is not light", () => {
    expect(tierOf(signalsOf([file("shared/util.ts", 3)], { areas: 1, unmapped: 1, mapped: true }))).toBe("standard");
    // only outside every area: zero matched areas in a mapped project is still not light
    expect(tierOf(signalsOf([file("shared/util.ts", 3)], { areas: 0, unmapped: 1, mapped: true }))).toBe("standard");
    // a project with no areas at all
    expect(tierOf(signalsOf([file("shared/util.ts", 3)], { areas: 0, unmapped: 0, mapped: false }))).toBe("light");
  });

  test("a rename is judged by both its names: moving a sensitive file out is still deep", () => {
    expect(tierOf(signalsOf([{ path: "ordinary.ts", added: 0, removed: 0, from: "auth.ts" }], { areas: 0 }))).toBe("deep");
    expect(tierOf(signalsOf([{ path: "src/old.ts", added: 0, removed: 0, from: "db/migrations/0001_init.sql" }], { areas: 0 }))).toBe("deep");
  });

  test("a tier only goes up within a PR", () => {
    expect(maxTier("light", "deep")).toBe("deep");
    expect(maxTier("standard", "light")).toBe("standard");
    expect(maxTier("light", null)).toBe("light");
  });

  test("binary files count as a line each, and tests are noticed", () => {
    const signals = signalsOf([{ path: "logo.png", added: null, removed: null }, file("src/x.spec.ts", 4)], { areas: 0 });
    expect(signals.lines).toBe(5);
    expect(signals.testsTouched).toBe(true);
  });

  test("numstat parsing keeps renames and binaries", () => {
    const out = "3\t1\tsrc/a.ts\u0000-\t-\tlogo.png\u00002\t0\t\u0000old/b.ts\u0000new/b.ts\u0000";
    expect(parseNumstat(out)).toEqual([
      { path: "src/a.ts", added: 3, removed: 1 },
      { path: "logo.png", added: null, removed: null },
      { path: "new/b.ts", added: 2, removed: 0, from: "old/b.ts" },
    ]);
  });
});
