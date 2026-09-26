#!/usr/bin/env bun
// `bun run release:closeout <version>` records a finished publication in the
// qualification ledger. It collects the public facts itself — the GitHub
// release, the release workflow's jobs, the promotion receipt artifact, the
// release PR and its checks, the migrations since the previous tag — and
// verifies anonymously that the tap and both update channels serve the
// version. The entry it writes keeps judgment as TODO markers, which
// docs:check refuses until they are resolved, so the public record cannot
// silently claim what nobody checked. Run it from a fresh closeout branch:
//
//   git switch -c "release/$version-closeout" origin/main
//   bun run release:closeout "$version"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  REPOSITORY,
  ROOT,
  TAP_REPOSITORY,
  anonymousText,
  checkVerdicts,
  command,
  ghApi,
  ghApiList,
  ghApiOrNull,
  git,
  previousRelease,
  releaseTags,
  remoteTagExists,
  run,
  versionArgument,
  type CheckRun,
} from "./release-github";
import {
  RELEASE_JOBS,
  SOURCE_CHECK_LABELS,
  recordPublication,
  type LedgerSource,
  type PublicationFacts,
} from "./release-ledger";
import { addedMigrations } from "./release-notes";
import { releaseMetadataFromApi, validateReleaseMetadata } from "./release-promotion";
import { assertTaggableVersion } from "./release-versions";

export interface ReleaseInfo {
  id: number;
  tag_name: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
}

export interface WorkflowRun {
  id: number;
  html_url: string;
  event: string;
  head_branch: string;
  head_sha: string;
  conclusion: string | null;
  run_attempt: number;
}

export interface ReleaseJob {
  name: string;
  conclusion: string | null;
}

export interface PromotionReceiptData {
  tag: string;
  version: string;
  releaseCommit: string;
  tapCommit: string;
  completedAt: string;
  channelUrl: string;
  daemonChannelUrl: string;
}

/** The tag-triggered run of the release workflow for exactly this commit. */
export function releaseRunForTag(runs: readonly WorkflowRun[], tag: string, sha: string): WorkflowRun | null {
  return (
    runs
      .filter((entry) => entry.event === "push" && entry.head_branch === tag && entry.head_sha === sha)
      .sort((a, b) => b.id - a.id)[0] ?? null
  );
}

/** The newest exact-main run of the release candidate workflow. */
export function candidateRunFor(runs: readonly WorkflowRun[], sha: string): WorkflowRun | null {
  return (
    runs
      .filter((entry) => entry.event === "push" && entry.head_sha === sha)
      .sort((a, b) => b.id - a.id)[0] ?? null
  );
}

/** The newest successful manual recovery run, if promotion needs one. */
export function recoveryRunFor(runs: readonly WorkflowRun[]): WorkflowRun | null {
  return (
    runs
      .filter((entry) => entry.event === "workflow_dispatch" && entry.conclusion === "success")
      .sort((a, b) => b.id - a.id)[0] ?? null
  );
}

export interface GateOutcome {
  /** True when promotion must come from a separate recovery run. */
  needsRecovery: boolean;
  problems: string[];
}

/**
 * The immutable-publication jobs must all have succeeded; promotion may have
 * finished in the same run or in a recovery run. A job list that does not
 * match RELEASE_JOBS means the workflow changed and the ledger template's
 * gate table is stale — that is reported, not recorded as fact.
 */
export function gateOutcome(jobs: readonly ReleaseJob[]): GateOutcome {
  const problems: string[] = [];
  const byName = new Map(jobs.map((job) => [job.name, job]));
  for (const name of RELEASE_JOBS) {
    const job = byName.get(name);
    if (!job) {
      problems.push(`the release run has no "${name}" job; update RELEASE_JOBS in scripts/release-ledger.ts with the workflow`);
      continue;
    }
    if (name !== "promote" && job.conclusion !== "success") {
      problems.push(`release job ${name} ended ${job.conclusion}; the release did not fully pass`);
    }
  }
  const promote = byName.get("promote");
  return { needsRecovery: !promote || promote.conclusion !== "success", problems };
}

export function parseReceipt(value: unknown): PromotionReceiptData {
  const receipt = value as Record<string, unknown>;
  const strings = ["tag", "version", "releaseCommit", "tapCommit", "completedAt", "channelUrl", "daemonChannelUrl"];
  if (
    receipt.schemaVersion !== 1 ||
    receipt.result !== "promoted" ||
    strings.some((field) => typeof receipt[field] !== "string")
  ) {
    throw new Error("promotion-receipt.json is not a completed promotion receipt");
  }
  return receipt as unknown as PromotionReceiptData;
}

/** The receipt artifact a run uploaded, preferring the latest attempt's. */
export function receiptArtifactName(artifacts: readonly { name: string; expired: boolean }[], runId: number): string | null {
  const named = new RegExp(`^release-promotion-${runId}-(\\d+)$`);
  return (
    artifacts
      .map((artifact) => ({ expired: artifact.expired, match: named.exec(artifact.name) }))
      .filter((artifact) => artifact.match && !artifact.expired)
      .sort((a, b) => Number(a.match![1]) - Number(b.match![1]))
      .at(-1)?.match?.[0] ?? null
  );
}

export interface TapState {
  daemonChannel: string;
  desktopChannel: string;
  formula: string;
  cask: string;
  darwinSums: string;
  desktopSums: string;
}

function checksumOf(sums: string, file: string): string | null {
  const line = sums.split("\n").find((entry) => entry.trimEnd().endsWith(` ${file}`));
  return line?.split(/\s+/)[0] ?? null;
}

/** What contradicts "the public tap serves this version", checked anonymously. */
export function tapProblems(version: string, state: TapState): string[] {
  const problems: string[] = [];
  const channel = (text: string, name: string) => {
    try {
      const served = (JSON.parse(text) as { version?: unknown }).version;
      if (served !== version) problems.push(`${name} serves ${JSON.stringify(served)}, not ${version}`);
    } catch {
      problems.push(`${name} did not return JSON`);
    }
  };
  channel(state.daemonChannel, "the daemon update channel");
  channel(state.desktopChannel, "the Desktop update channel");

  const formulaSha = /sha256 "([0-9a-f]{64})"/.exec(state.formula)?.[1] ?? null;
  if (!state.formula.includes(`releases/download/v${version}/`)) {
    problems.push("the Homebrew Formula does not install this release");
  } else if (formulaSha !== checksumOf(state.darwinSums, `wisp-v${version}-darwin-arm64.tar.gz`)) {
    problems.push("the Formula's sha256 does not match the published darwin-arm64 archive");
  }
  const caskVersion = /version "([^"]+)"/.exec(state.cask)?.[1] ?? null;
  const caskSha = /sha256 "([0-9a-f]{64})"/.exec(state.cask)?.[1] ?? null;
  if (caskVersion !== version) {
    problems.push(`the Homebrew Cask serves ${JSON.stringify(caskVersion)}, not ${version}`);
  } else if (caskSha !== checksumOf(state.desktopSums, `wisp-desktop-v${version}-darwin-arm64.tar.gz`)) {
    problems.push("the Cask's sha256 does not match the published Desktop archive");
  }
  return problems;
}

const CORE_CHECKS = ["test", "browser-security", "linux-contract", "supply-chain", "update-verifier"];

/** The ledger's source-checks phrase, from what actually passed on the PR head. */
export function passedSourceChecks(runs: readonly CheckRun[]): { labels: string[]; missing: string[] } {
  const verdicts = checkVerdicts(runs, SOURCE_CHECK_LABELS.map(([check]) => check));
  const labels: string[] = [];
  const missing: string[] = [];
  SOURCE_CHECK_LABELS.forEach(([check, label], index) => {
    if (verdicts[index]!.state === "passed") labels.push(label);
    else if (CORE_CHECKS.includes(check)) missing.push(check);
  });
  return { labels, missing };
}

export function releasePullRequest(pulls: readonly { number: number; merged_at: string | null; base: { ref: string } }[]): number | null {
  return pulls.find((pull) => pull.merged_at !== null && pull.base.ref === "main")?.number ?? null;
}

async function fetchTapState(version: string, receipt: PromotionReceiptData): Promise<TapState> {
  const tap = `https://raw.githubusercontent.com/${TAP_REPOSITORY}/main`;
  const download = `https://github.com/${REPOSITORY}/releases/download/v${version}`;
  const [daemonChannel, desktopChannel, formula, cask, darwinSums, desktopSums] = await Promise.all([
    anonymousText(receipt.daemonChannelUrl),
    anonymousText(receipt.channelUrl),
    anonymousText(`${tap}/Formula/wisp.rb`),
    anonymousText(`${tap}/Casks/wisp-desktop.rb`),
    anonymousText(`${download}/SHA256SUMS-darwin-arm64`),
    anonymousText(`${download}/SHA256SUMS-desktop-darwin-arm64`),
  ]);
  return { daemonChannel, desktopChannel, formula, cask, darwinSums, desktopSums };
}

function downloadReceipt(runId: number): PromotionReceiptData {
  const { artifacts } = ghApi<{ artifacts: Array<{ name: string; expired: boolean }> }>(
    `repos/${REPOSITORY}/actions/runs/${runId}/artifacts`,
  );
  const name = receiptArtifactName(artifacts, runId);
  if (!name) {
    throw new Error(`run ${runId} has no usable release-promotion artifact (they expire after 30 days)`);
  }
  const dir = mkdtempSync(join(tmpdir(), "wisp-receipt-"));
  try {
    run(["gh", "run", "download", String(runId), "--repo", REPOSITORY, "--name", name, "--dir", dir]);
    return parseReceipt(JSON.parse(readFileSync(join(dir, "promotion-receipt.json"), "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function diskLedgers(): LedgerSource {
  return {
    read: (path) => (existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), "utf8") : null),
    ledgers: () =>
      readdirSync(join(ROOT, "docs"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^v\d+\.\d+$/.test(entry.name))
        .map((entry) => ({ minor: entry.name.slice(1), path: join("docs", entry.name, "QUALIFICATION.md") }))
        .filter((entry) => existsSync(join(ROOT, entry.path)))
        .map((entry) => ({ minor: entry.minor, text: readFileSync(join(ROOT, entry.path), "utf8") })),
  };
}

function releaseMigrations(previousTag: string, tag: string): number[] {
  const migrations = "wispd/src/migrations.ts";
  return addedMigrations(git(["show", `${previousTag}:${migrations}`]), git(["show", `${tag}:${migrations}`]));
}

async function gather(version: string): Promise<{ facts: PublicationFacts; manual: string[] }> {
  const tag = `v${version}`;
  const sha = git(["rev-list", "-n", "1", `refs/tags/${tag}`]);
  const release = ghApiOrNull<ReleaseInfo>(`repos/${REPOSITORY}/releases/tags/${tag}`);
  if (!release) throw new Error(`no GitHub release for ${tag} yet; wait for the release workflow's publish job`);
  const assets = ghApiList<{ name: string }>(`repos/${REPOSITORY}/releases/${release.id}/assets?per_page=100`, ".[]");
  validateReleaseMetadata(releaseMetadataFromApi(release, assets), tag);
  const latest = ghApi<{ tag_name: string }>(`repos/${REPOSITORY}/releases/latest`).tag_name === tag;

  const runs = ghApiList<WorkflowRun>(`repos/${REPOSITORY}/actions/workflows/release.yml/runs?per_page=30`, ".workflow_runs[]");
  const pushRun = releaseRunForTag(runs, tag, sha);
  if (!pushRun) throw new Error(`the release workflow has not run for ${tag} yet`);
  const outcome = gateOutcome(ghApiList<ReleaseJob>(`repos/${REPOSITORY}/actions/runs/${pushRun.id}/jobs?filter=latest&per_page=100`, ".jobs[]"));
  if (outcome.problems.length > 0) throw new Error(outcome.problems.join("\n"));
  let promotionRunUrl: string | null = null;
  let receiptRun = pushRun;
  if (outcome.needsRecovery) {
    const recovery = recoveryRunFor(runs);
    if (!recovery) throw new Error("promotion has not finished; rerun the failed promote job or dispatch a recovery (releasing.md), then run this again");
    const jobs = ghApiList<ReleaseJob>(`repos/${REPOSITORY}/actions/runs/${recovery.id}/jobs?filter=latest&per_page=100`, ".jobs[]");
    if (!jobs.some((job) => job.name === "promote" && job.conclusion === "success")) {
      throw new Error(`the recovery run ${recovery.html_url} did not promote successfully`);
    }
    promotionRunUrl = recovery.html_url;
    receiptRun = recovery;
  }
  const receipt = downloadReceipt(receiptRun.id);
  if (receipt.tag !== tag || receipt.releaseCommit !== sha) {
    throw new Error(`the promotion receipt is for ${receipt.tag} at ${receipt.releaseCommit.slice(0, 7)}, not ${tag} at ${sha.slice(0, 7)}`);
  }

  const pulls = ghApiList<{ number: number; merged_at: string | null; base: { ref: string }; head: { sha: string } }>(
    `repos/${REPOSITORY}/commits/${sha}/pulls`,
    ".[]",
  );
  const pullRequest = releasePullRequest(pulls);
  const head = pulls.find((pull) => pull.number === pullRequest)?.head.sha;
  const checks = head ? passedSourceChecks(commitChecks(head)) : { labels: [], missing: CORE_CHECKS };

  const candidates = ghApiList<WorkflowRun>(
    `repos/${REPOSITORY}/actions/workflows/release-candidate.yml/runs?event=push&branch=main&per_page=30`,
    ".workflow_runs[]",
  );
  const previous = previousRelease(releaseTags(), version);
  if (!previous) throw new Error(`no release tag is older than ${version}`);

  const served = tapProblems(version, await fetchTapState(version, receipt));
  if (served.length > 0) {
    throw new Error(`the public tap does not serve ${version} yet:\n  - ${served.join("\n  - ")}\nWait a minute and run this again; if it persists, the promotion is incomplete.`);
  }

  const manual: string[] = [];
  if (checks.missing.length > 0) {
    manual.push(`verify the release PR's ${checks.missing.join(", ")} check(s) by hand and name them in the Source checks row, then delete this line.`);
  }
  if (!pullRequest) manual.push("name the pull request that carried the release commit, then delete this line.");
  return {
    manual,
    facts: {
      version,
      previousVersion: previous,
      commit: sha,
      pullRequest,
      publishedAt: release.published_at,
      prerelease: release.prerelease,
      latest,
      releaseRunUrl: pushRun.html_url,
      releaseRunAttempt: pushRun.run_attempt,
      promotionRunUrl,
      candidateRunUrl: candidateRunFor(candidates, sha)?.html_url ?? null,
      sourceChecks: checks.labels,
      promotedAt: receipt.completedAt,
      tapCommit: receipt.tapCommit,
      migrations: releaseMigrations(`v${previous}`, tag),
    },
  };
}

function commitChecks(sha: string): CheckRun[] {
  return ghApiList<CheckRun>(`repos/${REPOSITORY}/commits/${sha}/check-runs?per_page=100`, ".check_runs[]");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const version = versionArgument(args, "bun run release:closeout <version> [--dry-run]");
  assertTaggableVersion(version);
  const tag = `v${version}`;
  git(["fetch", "--quiet", "origin", "main", "--tags"]);
  if (!remoteTagExists(tag)) {
    console.error(`${tag} has not been pushed, so nothing was published. Publish first (release:ready prints the commands).`);
    return 1;
  }
  if (command(["git", "cat-file", "-t", `refs/tags/${tag}`]).stdout !== "tag") {
    console.error(`${tag} is not an annotated tag locally; run: git fetch --force origin refs/tags/${tag}:refs/tags/${tag}`);
    return 1;
  }
  const head = git(["rev-parse", "HEAD"]);
  if (head !== git(["rev-parse", "origin/main"])) {
    console.error(`run the closeout from a fresh branch at origin/main:\n  git switch -c release/${version}-closeout origin/main`);
    return 1;
  }
  if (command(["git", "status", "--porcelain=v1", "--untracked-files=no"]).stdout !== "") {
    console.error("the working tree has uncommitted changes; the closeout edits must be the only ones in the closeout PR");
    return 1;
  }

  console.log(`release:closeout ${version}: collecting the release, its jobs, the promotion receipt, and the PR`);
  const { facts, manual } = await gather(version);
  console.log(`  ok    the tap and both update channels serve ${version}, verified anonymously`);
  const { writes, manual: ledgerManual } = recordPublication(diskLedgers(), facts);
  const todos = [...manual, ...ledgerManual];

  if (args.includes("--dry-run")) {
    for (const write of writes) console.log(`--- ${write.path} would be written (${write.text.length} bytes)`);
  } else {
    for (const write of writes) {
      mkdirSync(dirname(join(ROOT, write.path)), { recursive: true });
      writeFileSync(join(ROOT, write.path), write.text);
      console.log(`  wrote ${write.path}`);
    }
  }
  if (todos.length > 0) {
    console.log(`${todos.length} TODO marker(s) left for judgment:`);
    for (const todo of todos) console.log(`  - ${todo}`);
  }
  console.log("Resolve every TODO (docs:check refuses them), review the diff, then commit and open the closeout PR.");
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`release:closeout: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
