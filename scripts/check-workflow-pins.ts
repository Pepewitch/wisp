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
 *   5. Registry-installed Cargo tools use an exact `=x.y.z` version and that
 *      release's lockfile. A range executes newly published code.
 *   6. No `${{ }}` expression inside a `run:` script. The runner splices the
 *      value into the shell source before the shell parses it, so a value with
 *      a quote in it becomes code. Pass it through `env:` and quote the
 *      variable instead.
 *   7. Every `actions/checkout` sets `persist-credentials: false`. Otherwise
 *      the job token sits in `.git/config` for every later step to read. No
 *      job here pushes with the checkout's token.
 *   8. A job that can reach a secret or a write-scoped token, and every job of
 *      a tag-triggered (release) workflow, restores no Actions cache. Any run
 *      on `main` can write a cache entry under the key such a job will look
 *      up, and setup-bun and rust-cache restore executables (`bun`,
 *      `~/.cargo/bin`) from it. That would put code nobody reviewed next to
 *      the signing keys, or into the published bytes.
 *
 * Local actions (`uses: ./…`) are exempt: they are this repository's own code,
 * already reviewed as part of the commit. A same-repo REUSABLE WORKFLOW
 * (`uses: .github/workflows/x.yml@ref`) is not exempt — its ref is as mutable
 * as any other, and a review pointed out the first version let it through on
 * the `.github/` prefix.
 *
 * It stays a line scanner rather than a YAML parser, which is the right size
 * for these rules but has to be honest about its edges: container detection
 * covers `image:`, `container:`, and the `docker`/`podman` verbs that pull or
 * run, and `write-all` is matched as a permissions VALUE rather than anywhere
 * in a line, so a comment mentioning it is not a failure. Steps, `run:`
 * scripts, and jobs are found by indentation, which is how YAML itself nests
 * them in the block style every workflow here uses.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_DIR = join(import.meta.dir, "..", ".github", "workflows");
const SHA = /^[0-9a-f]{40}$/;
/** `image: name@sha256:…` or a `docker run` argument in a shell step. */
const IMAGE_REFERENCE =
  /(?:^\s*(?:image|container):\s*|\b(?:docker|podman)\s+(?:run|pull|create)\b[^\n]*?\s)([a-z0-9][a-z0-9._/-]*(?::[\w.-]+|@sha256:[0-9a-f]{64}))/gim;
/** Words that appear in a docker-run line but are not images. */
const NOT_AN_IMAGE = /^(--|-)/;
const EXACT_CARGO_VERSION = /^=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface PolicyProblem {
  file: string;
  line: number;
  problem: string;
}

function indentOf(line: string): number {
  return line.search(/\S/);
}

function isBlank(line: string): boolean {
  return line.trim() === "" || line.trim().startsWith("#");
}

/**
 * The `uses:` line at `index` and the rest of its step: every later line
 * indented at least as deep as the `uses` key. A `- uses:` step's keys sit two
 * columns right of the dash, so the next step's dash ends it. `with:` is read
 * only after `uses:`; written before it, the step fails closed.
 */
function stepLines(lines: string[], index: number): string[] {
  const match = /^(\s*)(-\s+)?uses:/.exec(lines[index]!)!;
  const keyIndent = match[1]!.length + (match[2]?.length ?? 0);
  const body = [lines[index]!];
  for (let after = index + 1; after < lines.length; after++) {
    const line = lines[after]!;
    if (!isBlank(line) && indentOf(line) < keyIndent) break;
    body.push(line);
  }
  return body;
}

/** Each `run:` script, with the line number of its first line. */
function runScripts(lines: string[]): { line: number; text: string }[] {
  const scripts: { line: number; text: string }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)(-\s+)?run:\s*(.*)$/.exec(lines[index]!);
    if (!match) continue;
    const keyIndent = match[1]!.length + (match[2]?.length ?? 0);
    const rest = match[3]!;
    if (!/^[|>][-+]?\s*(?:#.*)?$/.test(rest)) {
      if (rest) scripts.push({ line: index + 1, text: rest });
      continue;
    }
    for (let body = index + 1; body < lines.length; body++) {
      const line = lines[body]!;
      if (line.trim() !== "" && indentOf(line) <= keyIndent) break;
      scripts.push({ line: body + 1, text: line });
    }
  }
  return scripts;
}

interface Job {
  name: string;
  line: number;
  lines: string[];
}

/** Jobs are the two-space keys under a top-level `jobs:`. */
function jobsOf(lines: string[]): Job[] {
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start === -1) return [];
  const jobs: Job[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(lines[index]!);
    if (header) jobs.push({ name: header[1]!, line: index + 1, lines: [] });
    else if (/^\S/.test(lines[index]!)) break;
    else jobs.at(-1)?.lines.push(lines[index]!);
  }
  return jobs;
}

/** Why a job must not restore a cache, or null when it may. */
function cacheFreeReason(job: Job, releaseWorkflow: boolean): string | null {
  if (job.lines.some((line) => /\$\{\{[^}]*\bsecrets\./.test(line))) return "it can read a secret";
  for (let index = 0; index < job.lines.length; index++) {
    const permissions = /^(\s+)permissions:\s*(\S*)/.exec(job.lines[index]!);
    if (!permissions) continue;
    if (permissions[2] === "write-all") return "it holds a write-scoped token";
    for (let scope = index + 1; scope < job.lines.length; scope++) {
      const line = job.lines[scope]!;
      if (isBlank(line)) continue;
      if (indentOf(line) <= permissions[1]!.length) break;
      if (/^\s+[\w-]+:\s*write\b/.test(line)) return "it holds a write-scoped token";
    }
  }
  return releaseWorkflow ? "it runs on a release tag, where it builds, signs, or publishes release bytes" : null;
}

/** The cache a step restores, or null. */
function restoredCache(step: string[]): string | null {
  const uses = step.map((line) => /^\s*(?:-\s*)?uses:\s*([^@\s]+)@/.exec(line)?.[1]).find(Boolean);
  if (!uses) return null;
  if (uses === "Swatinem/rust-cache") return "rust-cache (it restores ~/.cargo/bin and the registry)";
  if (uses === "actions/cache" || uses.startsWith("actions/cache/")) return uses;
  if (uses === "oven-sh/setup-bun" && !step.some((line) => /^\s+no-cache:\s*true\b/.test(line))) {
    return "setup-bun without `no-cache: true` (it restores the bun executable)";
  }
  return null;
}

export function checkWorkflow(file: string, source: string): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  const lines = source.split("\n");

  lines.forEach((line, index) => {
    const uses = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line);
    if (uses) {
      const reference = uses[1]!;
      // Only a path-relative local action is exempt. A same-repo reusable
      // workflow referenced by tag or branch is still a mutable identity.
      if (!reference.startsWith("./")) {
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
      if (reference.startsWith("actions/checkout@")) {
        const step = stepLines(lines, index);
        if (!step.some((stepLine) => /^\s+persist-credentials:\s*false\b/.test(stepLine))) {
          problems.push({
            file,
            line: index + 1,
            problem: "actions/checkout must set `persist-credentials: false`; a persisted token is readable by every later step",
          });
        }
      }
    }
    // As a VALUE (`permissions: write-all`), not as any occurrence of the word:
    // a comment that mentions it is documentation, not a grant.
    if (/^\s*permissions:\s*write-all\s*$/.test(line)) {
      problems.push({ file, line: index + 1, problem: "write-all grants every scope; name the ones the job needs" });
    }
    const cargoInstall = /\bcargo\s+install\s+([A-Za-z0-9_-]+)(?:\s|$)/.exec(line);
    if (cargoInstall && !/\s--(?:path|git)\s/.test(line)) {
      const version = /(?:^|\s)--version\s+(?:'([^']+)'|"([^"]+)"|(\S+))/.exec(line);
      const value = version?.[1] ?? version?.[2] ?? version?.[3] ?? "";
      if (!EXACT_CARGO_VERSION.test(value) || !/(?:^|\s)--locked(?:\s|$)/.test(line)) {
        problems.push({
          file,
          line: index + 1,
          problem: `cargo install ${cargoInstall[1]} must use --locked and an exact --version '=x.y.z'`,
        });
      }
    }
  });

  for (const script of runScripts(lines)) {
    const expression = /\$\{\{.*?\}\}/.exec(script.text);
    if (expression) {
      problems.push({
        file,
        line: script.line,
        problem: `${expression[0]} is spliced into a run: script before the shell parses it; pass it through env: and quote the variable`,
      });
    }
  }

  const releaseWorkflow = /^\s+tags(?:-ignore)?:/m.test(source.split(/^jobs:/m)[0] ?? "");
  for (const job of jobsOf(lines)) {
    const reason = cacheFreeReason(job, releaseWorkflow);
    if (!reason) continue;
    job.lines.forEach((line, index) => {
      if (!/^\s*(?:-\s*)?uses:/.test(line)) return;
      const cache = restoredCache(stepLines(job.lines, index));
      if (cache) {
        problems.push({
          file,
          line: job.line + 1 + index,
          problem: `job ${job.name} restores an Actions cache through ${cache}, but ${reason}; any main run can write that cache`,
        });
      }
    });
  }

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
  console.log(
    `checked ${files} workflows: third-party actions, containers, and Cargo tools are pinned; ` +
      "no run: script splices an expression, no checkout keeps its token, and no credentialed or release job restores a cache",
  );
}
