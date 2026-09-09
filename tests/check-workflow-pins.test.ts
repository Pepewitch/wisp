/**
 * The supply-chain policy gate, tested on synthetic workflows (SEC-06).
 *
 * A checker that only ever runs against a repository that already passes is a
 * checker nobody has seen fail. Each case here is a workflow with exactly one
 * of the defects the review found, plus the real workflows, which must pass.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkAllWorkflows, checkWorkflow } from "../scripts/check-workflow-pins";

function workflowDir(name: string, contents: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), `wisp-workflow-${name}-`));
  for (const [file, body] of Object.entries(contents)) writeFileSync(join(dir, file), body);
  return dir;
}

const PINNED_HEADER = `name: example
on: push

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
`;

describe("the repository's own workflows", () => {
  test("pass the policy", () => {
    expect(checkAllWorkflows()).toEqual([]);
  });
});

describe("what the policy refuses", () => {
  test("a third-party action pinned to a mutable tag", () => {
    const problems = checkWorkflow(
      "tagged.yml",
      `${PINNED_HEADER}      - uses: actions/checkout@v4\n`,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toContain("must be pinned to a 40-character commit SHA");
  });

  test("a third-party action pinned to a branch", () => {
    const problems = checkWorkflow(
      "branch.yml",
      `${PINNED_HEADER}      - uses: dtolnay/rust-toolchain@stable\n`,
    );
    expect(problems).toHaveLength(1);
  });

  test("a container image pinned by tag", () => {
    const problems = checkWorkflow(
      "container.yml",
      `${PINNED_HEADER}      - run: docker run --rm zricethezav/gitleaks:v8.28.0 detect\n`,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toContain("pinned by digest");
  });

  test("a missing top-level permissions block", () => {
    const problems = checkWorkflow(
      "nopermissions.yml",
      `name: example
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
`,
    );
    expect(problems.map((problem) => problem.problem)).toEqual([
      expect.stringContaining("no top-level permissions"),
    ]);
  });

  test("write scopes granted to every job at the top level", () => {
    const problems = checkWorkflow(
      "toplevelwrite.yml",
      `name: example
on: push

permissions:
  contents: write
  id-token: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
`,
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]!.problem).toContain("contents: write");
    expect(problems[1]!.problem).toContain("id-token: write");
  });

  test("a same-repo reusable workflow referenced by tag", () => {
    const problems = checkWorkflow(
      "reusable.yml",
      `name: example
on: push

permissions:
  contents: read

jobs:
  call:
    uses: .github/workflows/shared.yml@v1
`,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toContain("must be pinned to a 40-character commit SHA");
  });

  test("a tag-pinned image pulled rather than run, and a container: key", () => {
    expect(
      checkWorkflow("pull.yml", `${PINNED_HEADER}      - run: docker pull zricethezav/gitleaks:v8.28.0\n`),
    ).toHaveLength(1);
    expect(
      checkWorkflow("podman.yml", `${PINNED_HEADER}      - run: podman run --rm alpine:3.20 true\n`),
    ).toHaveLength(1);
    expect(
      checkWorkflow(
        "containerkey.yml",
        `name: example
on: push

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    container: node:22
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
`,
      ),
    ).toHaveLength(1);
  });

  test("write-all anywhere", () => {
    const problems = checkWorkflow(
      "writeall.yml",
      `name: example
on: push

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    permissions: write-all
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
`,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toContain("write-all");
  });
});

describe("what the policy allows", () => {
  test("a pinned action, a digest-pinned container, and a job-level write scope", () => {
    expect(
      checkWorkflow(
        "good.yml",
        `name: example
on: push

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    # a job that needs more says so itself, where it is reviewable
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - uses: ./.github/actions/local-thing
      - run: |
          docker run --rm \\
            zricethezav/gitleaks@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854 git .
`,
      ),
    ).toEqual([]);
  });

  /** A comment that merely mentions the word is documentation, not a grant. */
  test("a comment mentioning write-all is not a failure", () => {
    expect(
      checkWorkflow(
        "comment.yml",
        `name: example
on: push

# Never use write-all here; name the scopes a job needs.
permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
`,
      ),
    ).toEqual([]);
  });

  test("a directory of clean workflows", () => {
    const dir = workflowDir("clean", {
      "one.yml": `${PINNED_HEADER}      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n`,
      "notes.md": "not a workflow",
    });
    expect(checkAllWorkflows(dir)).toEqual([]);
  });
});
