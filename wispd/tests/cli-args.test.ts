import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli";

describe("parseArgs", () => {
  test("short flags are boolean and never eaten as positionals", () => {
    const p = parseArgs(["tq2szu", "-f"]);
    expect(p.positional).toEqual(["tq2szu"]);
    expect(p.flags.f).toBe(true);
  });

  test("value flags consume the next token", () => {
    const p = parseArgs(["repo", "do the thing", "--harness", "droid", "--model", "opus", "--effort", "high", "--name", "Demo"]);
    expect(p.positional).toEqual(["repo", "do the thing"]);
    expect(p.flags.harness).toBe("droid");
    expect(p.flags.model).toBe("opus");
    expect(p.flags.effort).toBe("high");
    expect(p.flags.name).toBe("Demo");
  });

  test("--timeout takes a value, so `wait <id> --timeout 30` parses as one task and 30 seconds", () => {
    const p = parseArgs(["tq2szu", "--timeout", "30"]);
    expect(p.positional).toEqual(["tq2szu"]);
    expect(p.flags.timeout).toBe("30");
  });

  test("a value-less --timeout stays boolean so `wisp wait` can reject it instead of waiting 1s", () => {
    const p = parseArgs(["tq2szu", "--timeout"]);
    expect(p.flags.timeout).toBe(true);
  });

  test("boolean long flags don't eat the next positional", () => {
    const p = parseArgs(["t1", "--force", "t2"]);
    expect(p.flags.force).toBe(true);
    expect(p.positional).toEqual(["t1", "t2"]);
  });

  test("--image ACCUMULATES: a turn takes ten, so the second must not replace the first (A1b)", () => {
    const p = parseArgs(["t1", "look", "--image", "./a.png", "--image", "../b.jpg"]);
    expect(p.positional).toEqual(["t1", "look"]);
    expect(p.flags.image).toEqual(["./a.png", "../b.jpg"]);
  });

  test("one --image is still an array, so the caller never branches on arity", () => {
    expect(parseArgs(["t1", "--image", "./a.png"]).flags.image).toEqual(["./a.png"]);
  });

  test("a value-less --image stays boolean so the command can reject it by name", () => {
    expect(parseArgs(["t1", "--image"]).flags.image).toBe(true);
  });

  test("--image does not swallow a following positional it was not given", () => {
    const p = parseArgs(["t1", "--image", "./a.png", "trailing"]);
    expect(p.flags.image).toEqual(["./a.png"]);
    expect(p.positional).toEqual(["t1", "trailing"]);
  });

  test("--copy accumulates like --image: `project set --copy a --copy b` is two globs", () => {
    const p = parseArgs(["set", "/repo", "--copy", ".env", "--copy", "*.local"]);
    expect(p.positional).toEqual(["set", "/repo"]);
    expect(p.flags.copy).toEqual([".env", "*.local"]);
  });

  test("--setup/--archive are value flags; --clear-* stay boolean", () => {
    const p = parseArgs(["set", "/repo", "--setup", "bun install", "--clear-archive"]);
    expect(p.flags.setup).toBe("bun install");
    expect(p.flags["clear-archive"]).toBe(true);
  });

  /**
   * `--base` shipped in a review draft reading its ref as a POSITIONAL,
   * because the handlers were written for a value flag while VALUE_FLAGS was
   * not updated. Every caller then saw `flags.base === true` and refused with
   * "--base requires a value" — an advertised flag that could not be used at
   * all. This is the cheap test that catches the next one.
   */
  test("--base is a value flag on both `new` and `project set`, and --clear-base is not", () => {
    const create = parseArgs(["repo", "do the thing", "--harness", "droid", "--base", "origin/develop"]);
    expect(create.flags.base).toBe("origin/develop");
    expect(create.positional).toEqual(["repo", "do the thing"]); // the ref did not leak into arity

    const set = parseArgs(["set", "/repo", "--base", "origin/develop", "--clear-copy"]);
    expect(set.flags.base).toBe("origin/develop");
    expect(set.positional).toEqual(["set", "/repo"]);

    expect(parseArgs(["set", "/repo", "--clear-base"]).flags["clear-base"]).toBe(true);
  });
});
