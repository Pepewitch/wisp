import { describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS, buildArgv, validateAdapters } from "../src/adapters";

describe("endOfOptions", () => {
  // A message is text, never flags: without the separator a prompt of
  // "--help" or "-c foo" was the last argv element, and the CLI parsed it.
  test("a prompt that starts with a dash stays one operand after --, for every harness that honors it", () => {
    for (const name of ["cursor", "opencode"]) {
      const def = BUILTIN_ADAPTERS[name]!;
      expect(def.endOfOptions).toBe(true);
      for (const prompt of ["--help", "-c foo", "--model other"]) {
        const argv = buildArgv(def, { prompt, model: "m", live: true });
        expect(argv.slice(-2)).toEqual(["--", prompt]);
        expect(argv.filter((part) => part === "--")).toHaveLength(1);
      }
    }
    // A custom adapter opts in explicitly; the default is unchanged.
    const custom = validateAdapters({ plain: { bin: "plain", exec: [], parse: { format: "text" } } }).plain!;
    expect(buildArgv(custom, { prompt: "-x" })).toEqual(["plain", "-x"]);
    const flagged = validateAdapters({ plain: { bin: "plain", exec: [], endOfOptions: true, parse: { format: "text" } } }).plain!;
    expect(buildArgv(flagged, { prompt: "-x" })).toEqual(["plain", "--", "-x"]);
    expect(() => validateAdapters({ plain: { bin: "plain", exec: [], endOfOptions: "yes", parse: { format: "text" } } })).toThrow(
      "endOfOptions must be a boolean",
    );
  });
});
