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
      `${PINNED_HEADER}      - uses: actions/setup-node@v4\n`,
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
        with:
          persist-credentials: false
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
        with:
          persist-credentials: false
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
        with:
          persist-credentials: false
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
        with:
          persist-credentials: false
`,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toContain("write-all");
  });

  test("a registry Cargo tool installed from a version range", () => {
    const problems = checkWorkflow(
      "cargo-range.yml",
      `${PINNED_HEADER}      - run: cargo install cargo-audit --locked --version ^0.22\n`,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toContain("exact --version '=x.y.z'");
  });
});

const SETUP_BUN = "      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0\n        with:\n          bun-version: 1.3.14\n";
const RUST_CACHE = "      - uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2\n";

describe("what the policy refuses to run next to credentials", () => {
  test("an expression spliced into a run: script, block or inline", () => {
    const problems = checkWorkflow(
      "splice.yml",
      `${PINNED_HEADER}      - run: |\n          echo start\n          render --notes "\${{ steps.version.outputs.notes }}"\n      - run: echo \${{ github.head_ref }}\n`,
    );
    expect(problems.map((problem) => problem.line)).toEqual([13, 14]);
    expect(problems[0]!.problem).toContain("pass it through env:");
  });

  test("an expression passed through env: is fine, and so is one in a step name", () => {
    expect(
      checkWorkflow(
        "env.yml",
        `${PINNED_HEADER}      - name: shard \${{ matrix.shard }}\n        env:\n          NOTES: \${{ steps.version.outputs.notes }}\n        run: |\n          render --notes "$NOTES"\n`,
      ),
    ).toEqual([]);
  });

  test("a checkout that leaves its token in .git/config", () => {
    const problems = checkWorkflow(
      "persist.yml",
      `${PINNED_HEADER}      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n        with:\n          fetch-depth: 0\n      - run: echo later step\n        # persist-credentials: false belongs to no step here\n`,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toContain("persist-credentials: false");
  });

  test("a job with a secret that restores the bun executable or ~/.cargo/bin from a cache", () => {
    const problems = checkWorkflow(
      "secret-cache.yml",
      `${PINNED_HEADER}${SETUP_BUN}${RUST_CACHE}      - env:\n          KEY: \${{ secrets.SIGNING_KEY }}\n        run: sign\n`,
    );
    expect(problems.map((problem) => problem.problem)).toEqual([
      expect.stringContaining("job build restores an Actions cache through setup-bun"),
      expect.stringContaining("through rust-cache"),
    ]);
    expect(problems[0]!.problem).toContain("it can read a secret");
  });

  test("a job with a write-scoped token that restores a cache", () => {
    const problems = checkWorkflow(
      "write-cache.yml",
      `name: example
on: push

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
${SETUP_BUN}      - uses: actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809 # v4.2.4
`,
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]!.problem).toContain("it holds a write-scoped token");
  });

  test("every job of a tag-triggered workflow, credential or not", () => {
    const problems = checkWorkflow(
      "release.yml",
      `name: release
on:
  push:
    tags: ['v*']

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${SETUP_BUN}`,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toContain("it runs on a release tag");
  });

  test("the release workflow as it stood: caches in its signing and publishing jobs", () => {
    const before = `name: release
on:
  push:
    tags: ['v*']

permissions:
  contents: read

jobs:
  macos-trusted:
    runs-on: macos-15
    steps:
${SETUP_BUN}${RUST_CACHE}        with:
          workspaces: desktop/src-tauri
          cache-targets: false
      - name: build and verify the trusted macOS releases
        env:
          TAURI_SIGNING_PRIVATE_KEY: \${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
        run: bun run scripts/release-desktop.ts --require-tag --signed
`;
    expect(checkWorkflow("release.yml", before)).toHaveLength(2);
    const after = before
      .replace("bun-version: 1.3.14\n", "bun-version: 1.3.14\n          no-cache: true\n")
      .replace(`${RUST_CACHE}        with:\n          workspaces: desktop/src-tauri\n          cache-targets: false\n`, "");
    expect(checkWorkflow("release.yml", after)).toEqual([]);
  });
});

describe("what the policy allows", () => {
  test("a credential-free branch job may cache its toolchain", () => {
    expect(checkWorkflow("ci.yml", `${PINNED_HEADER}${SETUP_BUN}${RUST_CACHE}      - run: bun test\n`)).toEqual([]);
  });

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
        with:
          persist-credentials: false
      - uses: ./.github/actions/local-thing
      - run: |
          docker run --rm \\
            zricethezav/gitleaks@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854 git .
      - run: cargo install cargo-audit --locked --version '=0.22.2'
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
        with:
          persist-credentials: false
`,
      ),
    ).toEqual([]);
  });

  test("a directory of clean workflows", () => {
    const dir = workflowDir("clean", {
      "one.yml": `${PINNED_HEADER}      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n        with:\n          persist-credentials: false\n`,
      "notes.md": "not a workflow",
    });
    expect(checkAllWorkflows(dir)).toEqual([]);
  });
});
