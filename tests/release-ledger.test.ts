import { describe, expect, test } from "bun:test";
import {
  advanceCurrentRelease,
  demoteRelease,
  insertSection,
  limitsLedgerMinor,
  migrationSentence,
  recordPublication,
  recordsVersion,
  renderLedgerSkeleton,
  renderPublicationSection,
  supersedeLedger,
  wrap,
  type LedgerSource,
  type PublicationFacts,
} from "../scripts/release-ledger";

const FACTS: PublicationFacts = {
  version: "0.6.3",
  previousVersion: "0.6.2",
  commit: "1234567890abcdef1234567890abcdef12345678",
  pullRequest: 300,
  publishedAt: "2026-09-26T01:02:03.000Z",
  prerelease: false,
  latest: true,
  releaseRunUrl: "https://github.com/Pepewitch/wisp/actions/runs/42",
  releaseRunAttempt: 1,
  promotionRunUrl: null,
  candidateRunUrl: "https://github.com/Pepewitch/wisp/actions/runs/41",
  sourceChecks: ["test", "browser-security", "Linux-contract", "supply-chain", "update-verifier"],
  promotedAt: "2026-09-26T01:04:05.000Z",
  tapCommit: "cafe0000cafe0000cafe0000cafe0000cafe0000",
  migrations: [],
};

const V06_LEDGER = `# Wisp 0.6 qualification

This ledger separates release evidence from the version label. The 0.6 releases
are regular pre-1.0 releases, not a claim of exhaustive security or platform
coverage. 0.6.2 is the current release; earlier 0.6 records are retained
below. The 0.5 records remain in
[the 0.5 ledger](../v0.5/QUALIFICATION.md).

The tested limits, remaining platform gaps and native dependency advisory scope
recorded for 0.5 under
[Still unqualified or outside scope](../v0.5/QUALIFICATION.md#still-unqualified-or-outside-scope)
still apply to 0.6.2.

## 0.6.2 publication

**Published and promoted on 2026-09-25.**
[Wisp 0.6.2](https://github.com/Pepewitch/wisp/releases/tag/v0.6.2) is the
latest regular GitHub release (\`draft: false\`, \`prerelease: false\`).

Promotion completed at 11:21:53 UTC with Homebrew tap commit
[\`4beeefa\`](https://github.com/Pepewitch/homebrew-tap/commit/4beeefa).
The Formula, Cask, daemon update channel, and Desktop update channel all serve
0.6.2.
`;

const V05_LEDGER = `# Wisp 0.5 qualification

0.5.18 was the last 0.5 release; 0.6.0 supersedes it, and its record
is in [the 0.6 ledger](../v0.6/QUALIFICATION.md). Earlier 0.5 records are
retained below.

## Still unqualified or outside scope

The standing limits.

## 0.5.18 publication

[Wisp 0.5.18](https://github.com/Pepewitch/wisp/releases/tag/v0.5.18) is the
latest regular GitHub release (\`draft: false\`, \`prerelease: false\`).
The Formula, Cask, daemon update channel, and Desktop update channel all serve
0.5.18.
`;

/** The renderer wraps prose at 80 columns; assert against the unwrapped text. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

function source(files: Record<string, string>): LedgerSource {
  return {
    read: (path) => files[path] ?? null,
    ledgers: () =>
      Object.entries(files)
        .filter(([path]) => /^docs\/v\d+\.\d+\/QUALIFICATION\.md$/.test(path))
        .map(([path, text]) => ({ minor: path.split("/")[1]!.slice(1), text })),
  };
}

describe("wrap", () => {
  test("keeps lines within the width and off Markdown block syntax", () => {
    const wrapped = wrap("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen", 30);
    for (const line of wrapped.split("\n")) expect(line.length).toBeLessThanOrEqual(30);
    expect(wrapped).toContain("one two three four five six");
  });
});

describe("migrationSentence", () => {
  test("describes none, one, and several migrations", () => {
    expect(migrationSentence("0.6.3", "0.6.2", [])).toBe("0.6.3 adds no database migration.");
    expect(migrationSentence("0.6.3", "0.6.2", [7])).toBe(
      "0.6.3 adds database migration 7, so a 0.6.2 daemon cannot reopen a profile that 0.6.3 has opened.",
    );
    expect(migrationSentence("0.6.3", "0.6.2", [7, 8, 9])).toContain("migrations 7, 8, and 9");
  });
});

describe("renderPublicationSection", () => {
  test("renders the same shape the 0.6.x entries use", () => {
    const section = renderPublicationSection(FACTS);
    expect(section).toStartWith("## 0.6.3 publication");
    expect(section).toContain("**Published and promoted on 2026-09-26.**");
    expect(section).toContain("| Gate | Result |");
    expect(flat(section)).toContain("is the latest regular GitHub release");
    expect(flat(section)).toContain("published at 01:02:03 UTC with ten release assets");
    expect(flat(section)).toContain("[PR #300](https://github.com/Pepewitch/wisp/pull/300)");
    expect(flat(section)).toContain("[release workflow](https://github.com/Pepewitch/wisp/actions/runs/42) completed every job successfully on its first run:");
    expect(flat(section)).toContain("Release PR test, browser-security, Linux-contract, supply-chain, and update-verifier checks passed");
    expect(flat(section)).toContain("[release candidate](https://github.com/Pepewitch/wisp/actions/runs/41)");
    expect(flat(section)).toContain("Promotion completed at 01:04:05 UTC");
    expect(flat(section)).toContain("[`cafe0000cafe0000cafe0000cafe0000cafe0000`](https://github.com/Pepewitch/homebrew-tap/commit/cafe0000cafe0000cafe0000cafe0000cafe0000)");
    expect(flat(section)).toContain("all serve 0.6.3");
    expect(flat(section)).toContain("0.6.3 adds no database migration.");
    expect(section).toContain("TODO");
  });

  test("a prerelease never claims to be the latest release", () => {
    const section = renderPublicationSection({ ...FACTS, version: "0.7.0-alpha.1", prerelease: true, latest: false });
    expect(flat(section)).toContain("a GitHub prerelease (`draft: false`, `prerelease: true`)");
    expect(flat(section)).not.toContain("latest regular");
  });

  test("a rerun asks which job failed first", () => {
    const section = renderPublicationSection({ ...FACTS, releaseRunAttempt: 2 });
    expect(flat(section)).toContain("on attempt 2, after TODO name the job that failed first");
  });

  test("a recovery run asks why the first promotion failed", () => {
    const section = renderPublicationSection({ ...FACTS, promotionRunUrl: "https://github.com/Pepewitch/wisp/actions/runs/99" });
    expect(flat(section)).toContain("finished in a separate [recovery run](https://github.com/Pepewitch/wisp/actions/runs/99)");
    expect(flat(section)).toContain("TODO say why the first promotion failed");
  });

  test("a missing PR becomes a TODO instead of a dead link", () => {
    expect(flat(renderPublicationSection({ ...FACTS, pullRequest: null }))).toContain("TODO link the pull request");
  });
});

describe("insertSection", () => {
  test("puts the newest publication above the earlier ones", () => {
    const result = insertSection("# Ledger\n\n## 0.6.2 publication\n\nold\n", "## 0.6.3 publication\n\nnew\n");
    expect(result.indexOf("## 0.6.3 publication")).toBeLessThan(result.indexOf("## 0.6.2 publication"));
    expect(result).toStartWith("# Ledger\n");
  });
});

describe("demoteRelease", () => {
  test("keeps the evidence and drops only the claims a new release made false", () => {
    const { text, manual } = demoteRelease(V06_LEDGER, "docs/v0.6/QUALIFICATION.md", "0.6.2", "0.6.3");
    expect(manual).toEqual([]);
    expect(text).toContain("is a\nregular GitHub release");
    expect(text).toContain("all served\n0.6.2 until 0.6.3 was promoted.");
    expect(text).not.toContain("latest regular");
  });

  test("a missing section becomes an instruction, not silence", () => {
    const { manual } = demoteRelease("# Ledger\n", "docs/v0.6/QUALIFICATION.md", "0.6.1", "0.6.3");
    expect(manual.join("\n")).toContain('no "0.6.1 publication" section');
  });
});

describe("advanceCurrentRelease", () => {
  test("moves the intro's current release within a minor line", () => {
    const { text, manual } = advanceCurrentRelease(V06_LEDGER, "docs/v0.6/QUALIFICATION.md", "0.6.2", "0.6.3");
    expect(manual).toEqual([]);
    expect(text).toContain("0.6.3 is the current release;");
    expect(text).toContain("still apply to 0.6.3.");
    expect(text).not.toContain("0.6.2 is the current release");
  });

  test("turns a prepared skeleton into a published ledger", () => {
    const skeleton = renderLedgerSkeleton("0.7.0", "0.6", "0.5");
    const { text, manual } = advanceCurrentRelease(skeleton, "docs/v0.7/QUALIFICATION.md", "0.6.2", "0.7.0");
    expect(manual).toEqual([]);
    expect(text).toContain("0.7.0 is the current release.");
    expect(flat(text)).toContain("still apply to 0.7.0.");
    expect(flat(text)).toContain("[Still unqualified or outside scope](../v0.5/QUALIFICATION.md#still-unqualified-or-outside-scope)");
    expect(flat(text)).not.toContain("not yet published");
  });
});

describe("supersedeLedger", () => {
  test("points the old minor's intro at the new ledger", () => {
    const { text, manual } = supersedeLedger(V06_LEDGER, "docs/v0.6/QUALIFICATION.md", "0.6.2", "0.7.0");
    expect(manual).toEqual([]);
    expect(text).toContain("0.6.2 was the last 0.6 release; 0.7.0 supersedes it");
    expect(text).toContain("[the 0.7 ledger](../v0.7/QUALIFICATION.md)");
    expect(text).toContain("Earlier 0.6 records are\nretained below.");
  });
});

describe("renderLedgerSkeleton", () => {
  test("starts a new minor's ledger before its first tag", () => {
    const skeleton = renderLedgerSkeleton("0.7.0", "0.6", "0.5");
    expect(skeleton).toStartWith("# Wisp 0.7 qualification");
    expect(flat(skeleton)).toContain("0.7.0 is prepared and not yet published");
    expect(flat(skeleton)).toContain("[the 0.6 ledger](../v0.6/QUALIFICATION.md)");
  });
});

describe("limitsLedgerMinor", () => {
  test("finds the newest ledger carrying the standing limits", () => {
    expect(
      limitsLedgerMinor([
        { minor: "0.4", text: "## Still unqualified or outside scope\n" },
        { minor: "0.5", text: "## Still unqualified or outside scope\n" },
        { minor: "0.6", text: "## 0.6.2 publication\n" },
      ]),
    ).toBe("0.5");
    expect(limitsLedgerMinor([])).toBeNull();
  });
});

describe("recordPublication", () => {
  test("a patch writes one ledger: new entry, advanced intro, demoted predecessor", () => {
    const { writes, manual } = recordPublication(source({ "docs/v0.6/QUALIFICATION.md": V06_LEDGER }), FACTS);
    expect(manual).toEqual([]);
    expect(writes.map((write) => write.path)).toEqual(["docs/v0.6/QUALIFICATION.md"]);
    const text = writes[0]!.text;
    expect(text.indexOf("## 0.6.3 publication")).toBeLessThan(text.indexOf("## 0.6.2 publication"));
    expect(text).toContain("0.6.3 is the current release;");
    expect(text).toContain("still apply to 0.6.3.");
    expect(text).toContain("is a\nregular GitHub release");
    expect(text).toContain("all served\n0.6.2 until 0.6.3 was promoted.");
  });

  test("a new minor writes both ledgers: skeleton, superseded predecessor", () => {
    const { writes, manual } = recordPublication(
      source({ "docs/v0.6/QUALIFICATION.md": V06_LEDGER, "docs/v0.5/QUALIFICATION.md": V05_LEDGER }),
      { ...FACTS, version: "0.7.0", previousVersion: "0.6.2" },
    );
    expect(writes.map((write) => write.path).sort()).toEqual(["docs/v0.6/QUALIFICATION.md", "docs/v0.7/QUALIFICATION.md"]);
    const next = writes.find((write) => write.path === "docs/v0.7/QUALIFICATION.md")!;
    expect(next.text).toContain("# Wisp 0.7 qualification");
    expect(next.text).toContain("0.7.0 is the current release.");
    expect(next.text).toContain("## 0.7.0 publication");
    expect(flat(next.text)).toContain("[the 0.6 ledger](../v0.6/QUALIFICATION.md)");
    const previous = writes.find((write) => write.path === "docs/v0.6/QUALIFICATION.md")!;
    expect(previous.text).toContain("0.6.2 was the last 0.6 release; 0.7.0 supersedes it");
    expect(previous.text).toContain("all served\n0.6.2 until 0.7.0 was promoted.");
    expect(manual.join("\n")).toContain("did not exist");
  });

  test("refuses to record a version twice", () => {
    expect(() => recordPublication(source({ "docs/v0.6/QUALIFICATION.md": V06_LEDGER }), { ...FACTS, version: "0.6.2" })).toThrow(
      "already records",
    );
    expect(recordsVersion(V06_LEDGER, "0.6.2")).toBe(true);
    expect(recordsVersion(V06_LEDGER, "0.6.3")).toBe(false);
  });
});
