/**
 * The policy gate for what CI is allowed to execute (SEC-06).
 *
 * Release jobs handle Apple signing material, Tauri updater keys, GitHub
 * publication rights, and a Homebrew tap token. A review pointed out that they
 * reached those steps after running third-party actions referenced by MUTABLE
 * tags: `actions/checkout@v4` is whatever that tag points at today, and a
 * compromised upstream tag would run attacker code in a job that later touches
 * signing secrets. `softprops/action-gh-release` was already pinned to a
 * commit, which is the pattern this makes mandatory.
 *
 * The rules, and why each one is here rather than left to review:
 *
 *   1. Every third-party `uses:` is pinned to a 40-character commit SHA. A tag
 *      or branch is not an identity.
 *   2. Every container image is pinned by digest, for the same reason.
 *   3. Every workflow declares a top-level `permissions:` block, so a job
 *      added later cannot inherit whatever the repository default happens to
 *      be.
 *   4. No workflow grants `write-all`, and no top-level block grants write
 *      scopes: a job that needs one says so itself.
 *
 * Local actions (`uses: ./…`) are exempt: they are this repository's own code,
 * already reviewed as part of the commit.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_DIR = join(import.meta.dir, "..", ".github", "workflows");
const SHA = /^[0-9a-f]{40}$/;
/** `image: name@sha256:…` or a `docker run` argument in a shell step. */
const IMAGE_REFERENCE = /(?:^\s*image:\s*|\bdocker\s+run\b[^\n]*?\s)([a-z0-9][a-z0-9._/-]*(?::[\w.-]+|@sha256:[0-9a-f]{64}))/gim;
/** Words that appear in a docker-run line but are not images. */
const NOT_AN_IMAGE = /^(--|-)/;

export interface PolicyProblem {
  file: string;
  line: number;
  problem: string;
}

export function checkWorkflow(file: string, source: string): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  const lines = source.split("\n");

  lines.forEach((line, index) => {
    const uses = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line);
    if (uses) {
      const reference = uses[1]!;
      // this repository's own composite actions and reusable workflows
      if (!reference.startsWith("./") && !reference.startsWith(".github/")) {
        const at = reference.lastIndexOf("@");
        const pin = at === -1 ? "" : reference.slice(at + 1);
        if (!SHA.test(pin)) {
          problems.push({
            file,
            line: index + 1,
            problem: `third-party action ${reference} must be pinned to a 40-character commit SHA (a tag is mutable)`,
          });
        }
      }
    }
    if (/write-all/.test(line)) {
      problems.push({ file, line: index + 1, problem: "write-all grants every scope; name the ones the job needs" });
    }
  });

  for (const match of source.matchAll(IMAGE_REFERENCE)) {
    const reference = match[1]!;
    if (NOT_AN_IMAGE.test(reference)) continue;
    if (!reference.includes("@sha256:")) {
      const line = source.slice(0, match.index).split("\n").length;
      problems.push({
        file,
        line,
        problem: `container ${reference} must be pinned by digest (name@sha256:…), not by tag`,
      });
    }
  }

  const header = source.split(/^jobs:/m)[0] ?? "";
  if (!/^permissions:/m.test(header)) {
    problems.push({
      file,
      line: 1,
      problem: "no top-level permissions: block — a job added later would inherit the repository default",
    });
  } else {
    // Only the top-level block is checked for write scopes; a job that needs
    // one declares it next to the step that uses it, where it is reviewable.
    const block = /^permissions:\n((?:[ \t]+.*\n)+)/m.exec(header)?.[1] ?? "";
    for (const scope of block.matchAll(/^\s+([\w-]+):\s*(\S+)/gm)) {
      if (scope[2] === "write") {
        problems.push({
          file,
          line: 1,
          problem: `top-level permissions grants ${scope[1]}: write — move it to the job that needs it`,
        });
      }
    }
  }
  return problems;
}

export function checkAllWorkflows(dir: string = WORKFLOW_DIR): PolicyProblem[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .flatMap((name) => checkWorkflow(name, readFileSync(join(dir, name), "utf8")));
}

if (import.meta.main) {
  const problems = checkAllWorkflows();
  for (const { file, line, problem } of problems) console.error(`${file}:${line}: ${problem}`);
  const files = readdirSync(WORKFLOW_DIR).filter((name) => name.endsWith(".yml")).length;
  if (problems.length > 0) {
    console.error(`\n${problems.length} workflow policy problem(s) in ${files} workflow(s)`);
    process.exit(1);
  }
  console.log(`checked ${files} workflows: every third-party action and container is pinned`);
}
