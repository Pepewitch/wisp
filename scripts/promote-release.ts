#!/usr/bin/env bun
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDisposableAuditHost,
  changedTapFiles,
  classifyTapState,
  expectedReleaseAssets,
  parsePromotionArgs,
  type PromotionArgs,
  type PromotionManifests,
  releaseNotesPath,
  releaseVersion,
  renderTapFiles,
  type ReleaseMetadata,
  TAP_FILES,
  validateReleaseMetadata,
} from "./release-promotion";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY = "Pepewitch/wisp";
const AUDIT_TAP = "Pepewitch/tap";
const CHANNEL_URL =
  "https://raw.githubusercontent.com/Pepewitch/homebrew-tap/main/updates/wisp-desktop-alpha.json";

interface CommandOptions {
  cwd?: string;
  quiet?: boolean;
  allowFailure?: boolean;
  env?: Record<string, string>;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PromotionReceipt {
  schemaVersion: 1;
  result: "dry-run" | "promoted";
  tag: string;
  version: string;
  releaseCommit: string;
  releaseAssets: number;
  tapState: "prepared" | "already-promoted";
  tapCommit: string;
  channelUrl: string;
  completedAt: string;
  stageDurationsMs: Record<string, number>;
}

function output(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8").trim();
}

function sanitized(value: string): string {
  const roots = [process.cwd(), tmpdir(), process.env.HOME]
    .filter((root): root is string => Boolean(root))
    .sort((left, right) => right.length - left.length);
  let result = value;
  for (const root of roots) result = result.replaceAll(root, "<local-path>");
  return result;
}

function command(cmd: string[], options: CommandOptions = {}): CommandResult {
  const result = Bun.spawnSync({
    cmd,
    cwd: options.cwd,
    env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = output(result.stdout);
  const stderr = output(result.stderr);
  if (!options.quiet) {
    if (stdout) console.log(sanitized(stdout));
    if (stderr) console.error(sanitized(stderr));
  }
  if (result.exitCode !== 0 && !options.allowFailure) {
    const detail = sanitized(stderr || stdout);
    throw new Error(`${sanitized(cmd.join(" "))} failed${detail ? `: ${detail}` : ""}`);
  }
  return { exitCode: result.exitCode, stdout, stderr };
}

function run(cmd: string[], options: CommandOptions = {}): string {
  return command(cmd, options).stdout;
}

function publicRelease(tag: string): ReleaseMetadata {
  return JSON.parse(
    run(
      [
        "gh",
        "release",
        "view",
        tag,
        "--repo",
        REPOSITORY,
        "--json",
        "tagName,isDraft,isPrerelease,assets",
      ],
      { quiet: true },
    ),
  ) as ReleaseMetadata;
}

function downloadPublicAssets(tag: string, version: string, directory: string): void {
  mkdirSync(directory, { recursive: true });
  for (const file of expectedReleaseAssets(version)) {
    run(
      [
        "curl",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--retry",
        "4",
        "--retry-all-errors",
        `https://github.com/${REPOSITORY}/releases/download/${tag}/${file}`,
        "--output",
        join(directory, file),
      ],
      { quiet: true },
    );
  }
}

function readManifests(directory: string): PromotionManifests {
  return {
    linux: JSON.parse(
      readFileSync(join(directory, "release-manifest.json"), "utf8"),
    ) as PromotionManifests["linux"],
    macos: JSON.parse(
      readFileSync(join(directory, "release-manifest-darwin-arm64.json"), "utf8"),
    ) as PromotionManifests["macos"],
    desktop: JSON.parse(
      readFileSync(join(directory, "release-manifest-desktop-darwin-arm64.json"), "utf8"),
    ) as PromotionManifests["desktop"],
  };
}

function verifyPublicAssets(root: string, directory: string, version: string): void {
  run(["shasum", "-a", "256", "-c", "SHA256SUMS"], { cwd: directory });
  run(["shasum", "-a", "256", "-c", "SHA256SUMS-darwin-arm64"], { cwd: directory });
  run(["shasum", "-a", "256", "-c", "SHA256SUMS-desktop-darwin-arm64"], { cwd: directory });

  const desktop = join(directory, `wisp-desktop-v${version}-darwin-arm64.tar.gz`);
  const signature = `${desktop}.sig`;
  // Cargo builds the package library alongside this standalone verifier. The
  // library's Tauri context requires frontendDist at compile time even though
  // the verifier never links or executes the application UI. Tagged source
  // checkouts correctly omit the generated bundle, so provide and later remove
  // one inert ignored input instead of rebuilding unrelated frontend bytes.
  const verifierFrontend = resolve(root, "web/ui-dist/index.html");
  const createdVerifierFrontend = !existsSync(verifierFrontend);
  if (createdVerifierFrontend) {
    mkdirSync(dirname(verifierFrontend), { recursive: true });
    writeFileSync(verifierFrontend, "<!doctype html><title>release verifier build input</title>\n", {
      mode: 0o644,
    });
  }
  const verifierEnvironment = {
    CARGO_TARGET_DIR: resolve(SCRIPT_ROOT, "desktop/src-tauri/target"),
  };
  const verifier = [
    "cargo",
    "run",
    "--quiet",
    "--locked",
    "--manifest-path",
    resolve(root, "desktop/src-tauri/Cargo.toml"),
    "--bin",
    "verify-update-signature",
    "--features",
    "release-verifier",
    "--",
  ];
  try {
    run([...verifier, desktop, signature, resolve(root, "desktop/src-tauri/updater-public.key")], {
      env: verifierEnvironment,
    });
    const tampered = join(directory, "tampered-desktop.tar.gz");
    copyFileSync(desktop, tampered);
    appendFileSync(tampered, "tampered");
    const tamperedResult = command(
      [...verifier, tampered, signature, resolve(root, "desktop/src-tauri/updater-public.key")],
      { allowFailure: true, quiet: true, env: verifierEnvironment },
    );
    if (tamperedResult.exitCode === 0) throw new Error("updater signature accepted a changed artifact");
  } finally {
    if (createdVerifierFrontend) rmSync(verifierFrontend, { force: true });
  }

  const extracted = join(directory, "desktop-extracted");
  mkdirSync(extracted);
  run(["tar", "-xzf", desktop, "-C", extracted]);
  const app = join(extracted, "Wisp.app");
  run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app]);
  run(["xcrun", "stapler", "validate", app]);
  run(["spctl", "--assess", "--type", "execute", "--verbose=4", app]);
}

function requireReleaseCheckout(root: string, tag: string): string {
  const tagType = run(["git", "-C", root, "cat-file", "-t", `refs/tags/${tag}`], { quiet: true });
  if (tagType !== "tag") throw new Error(`release tag ${tag} must be annotated`);
  const commit = run(["git", "-C", root, "rev-list", "-n", "1", tag], { quiet: true });
  const head = run(["git", "-C", root, "rev-parse", "HEAD"], { quiet: true });
  if (head !== commit) throw new Error(`promotion checkout must be the exact ${tag} commit ${commit}`);
  command(["git", "-C", root, "merge-base", "--is-ancestor", commit, "origin/main"], { quiet: true });
  return commit;
}

function requireCleanTap(tapDir: string): void {
  command(["git", "-C", tapDir, "rev-parse", "--is-inside-work-tree"], { quiet: true });
  run(["git", "-C", tapDir, "fetch", "origin", "main"]);
  const head = run(["git", "-C", tapDir, "rev-parse", "HEAD"], { quiet: true });
  const remote = run(["git", "-C", tapDir, "rev-parse", "origin/main"], { quiet: true });
  if (head !== remote) throw new Error("Homebrew tap checkout is not at origin/main");
  const dirty = run(["git", "-C", tapDir, "status", "--porcelain=v1", "--untracked-files=all"], { quiet: true });
  if (dirty) throw new Error("Homebrew tap checkout must be clean before promotion");
}

function writeTapFiles(tapDir: string, files: Record<(typeof TAP_FILES)[number], string>): void {
  for (const path of TAP_FILES) {
    const outputPath = resolve(tapDir, path);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, files[path], { mode: 0o644 });
  }
}

function probeInstalled(kind: "--formula" | "--cask", name: string): string {
  const result = command(["brew", "list", kind, "--versions", name], { allowFailure: true, quiet: true });
  return result.exitCode === 0 ? result.stdout : "";
}

function requireDisposableAuditHost(): void {
  assertDisposableAuditHost(
    probeInstalled("--formula", "wisp"),
    probeInstalled("--cask", "wisp-desktop"),
    run(["brew", "tap"], { quiet: true }).toLowerCase(),
  );
}

function prepareAuditTap(tapDir: string): { auditDir: string; cleanup: () => void } {
  run(["brew", "tap-new", "--no-git", AUDIT_TAP]);
  let trusted = false;
  let auditDir = "";
  const cleanup = (): void => {
    // Remove colliding definitions before untapping. Homebrew must never
    // associate cleanup of this temporary tap with an operator installation.
    if (auditDir) {
      rmSync(join(auditDir, "Formula/wisp.rb"), { force: true });
      rmSync(join(auditDir, "Casks/wisp-desktop.rb"), { force: true });
    }
    try {
      run(["brew", "untap", "--force", AUDIT_TAP]);
    } finally {
      if (trusted) run(["brew", "untrust", "--tap", AUDIT_TAP]);
    }
  };
  try {
    run(["brew", "trust", "--tap", AUDIT_TAP]);
    trusted = true;
    auditDir = run(["brew", "--repository", AUDIT_TAP], { quiet: true });
    const formula = join(auditDir, "Formula/wisp.rb");
    const cask = join(auditDir, "Casks/wisp-desktop.rb");
    mkdirSync(dirname(formula), { recursive: true });
    mkdirSync(dirname(cask), { recursive: true });
    copyFileSync(join(tapDir, "Formula/wisp.rb"), formula);
    copyFileSync(join(tapDir, "Casks/wisp-desktop.rb"), cask);
  } catch (error) {
    cleanup();
    throw error;
  }
  return {
    auditDir,
    cleanup,
  };
}

function auditBeforePromotion(auditDir: string): void {
  run(["brew", "style", join(auditDir, "Formula/wisp.rb"), join(auditDir, "Casks/wisp-desktop.rb")]);
  run(["brew", "audit", "--strict", `${AUDIT_TAP}/wisp`]);
  run(["brew", "audit", "--strict", "--cask", `${AUDIT_TAP}/wisp-desktop`]);
  run(["brew", "audit", "--strict", "--online", `${AUDIT_TAP}/wisp`]);
  run([
    "brew",
    "audit",
    "--strict",
    "--online",
    "--cask",
    "--except",
    "github_prerelease_version,livecheck_version,livecheck_https_availability",
    `${AUDIT_TAP}/wisp-desktop`,
  ]);
}

function publishTap(tapDir: string, state: "prepared" | "already-promoted"): string {
  run(["git", "-C", tapDir, "fetch", "origin", "main"]);
  const head = run(["git", "-C", tapDir, "rev-parse", "HEAD"], { quiet: true });
  const remote = run(["git", "-C", tapDir, "rev-parse", "origin/main"], { quiet: true });
  if (head !== remote) throw new Error("Homebrew tap moved during audit; rerun promotion from the new main");
  if (state === "prepared") {
    run(["git", "-C", tapDir, "config", "user.name", "github-actions[bot]"], { quiet: true });
    run(
      [
        "git",
        "-C",
        tapDir,
        "config",
        "user.email",
        "41898282+github-actions[bot]@users.noreply.github.com",
      ],
      { quiet: true },
    );
    run(["git", "-C", tapDir, "add", ...TAP_FILES], { quiet: true });
    const staged = run(["git", "-C", tapDir, "diff", "--cached", "--name-only"], { quiet: true })
      .split(/\r?\n/)
      .filter(Boolean)
      .sort();
    if (JSON.stringify(staged) !== JSON.stringify([...TAP_FILES].sort())) {
      throw new Error(`staged tap files do not match the three-file contract: ${JSON.stringify(staged)}`);
    }
    command(["git", "-C", tapDir, "diff", "--quiet"], { quiet: true });
    command(["git", "-C", tapDir, "diff", "--cached", "--check"], { quiet: true });
    const version = readFileSync(join(tapDir, "Casks/wisp-desktop.rb"), "utf8").match(/version "([^"]+)"/)?.[1];
    if (!version) throw new Error("rendered Cask has no version");
    run(["git", "-C", tapDir, "commit", "-m", `release: update Wisp to ${version}`]);
    run(["git", "-C", tapDir, "push", "origin", "HEAD:main"]);
  }
  return run(["git", "-C", tapDir, "rev-parse", "HEAD"], { quiet: true });
}

function waitForPublicChannel(expectedPath: string, destination: string): void {
  for (let attempt = 1; attempt <= 24; attempt++) {
    const result = command(
      [
        "curl",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        CHANNEL_URL,
        "--output",
        destination,
      ],
      { allowFailure: true, quiet: true },
    );
    if (
      result.exitCode === 0 &&
      existsSync(destination) &&
      readFileSync(destination).equals(readFileSync(expectedPath))
    ) {
      return;
    }
    console.log(`promotion: updater channel not converged (attempt ${attempt}/24)`);
    if (attempt < 24) command(["sleep", "15"], { quiet: true });
  }
  throw new Error("public Desktop update channel did not converge");
}

function auditAfterPromotion(): void {
  run(["brew", "audit", "--strict", "--online", `${AUDIT_TAP}/wisp`]);
  run([
    "brew",
    "audit",
    "--strict",
    "--online",
    "--cask",
    "--except",
    "github_prerelease_version",
    `${AUDIT_TAP}/wisp-desktop`,
  ]);
}

function writeReceipt(path: string, receipt: PromotionReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
}

function appendStepSummary(receipt: PromotionReceipt): void {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  appendFileSync(
    summary,
    [
      "## Release promotion",
      "",
      `- Result: ${receipt.result}`,
      `- Tag: \`${receipt.tag}\``,
      `- Release commit: \`${receipt.releaseCommit}\``,
      `- Public assets: ${receipt.releaseAssets}`,
      `- Tap state: ${receipt.tapState}`,
      `- Tap commit: \`${receipt.tapCommit}\``,
      `- Update channel: ${receipt.channelUrl}`,
      "",
    ].join("\n"),
  );
}

export function promoteRelease(args: PromotionArgs, root = SCRIPT_ROOT): PromotionReceipt {
  if (process.platform !== "darwin" || arch() !== "arm64") {
    throw new Error(`release promotion requires a disposable Apple Silicon macOS host, got ${process.platform} ${arch()}`);
  }
  const durations: Record<string, number> = {};
  const stage = <T>(name: string, task: () => T): T => {
    const started = Date.now();
    if (process.env.GITHUB_ACTIONS) console.log(`::group::${name}`);
    console.log(`promotion: ${name}`);
    try {
      return task();
    } finally {
      durations[name] = Date.now() - started;
      console.log(`promotion: ${name} finished in ${durations[name]}ms`);
      if (process.env.GITHUB_ACTIONS) console.log("::endgroup::");
    }
  };

  const releaseRoot = args.releaseRoot ?? root;
  const version = releaseVersion(args.tag);
  const notesPath = releaseNotesPath(releaseRoot, args.tag);
  if (!existsSync(notesPath)) throw new Error(`release notes do not exist: ${sanitized(notesPath)}`);
  const releaseCommit = stage("verify release identity", () => requireReleaseCheckout(releaseRoot, args.tag));
  const metadata = stage("verify public release inventory", () => {
    const value = publicRelease(args.tag);
    validateReleaseMetadata(value, args.tag);
    return value;
  });
  stage("require disposable Homebrew host", requireDisposableAuditHost);
  const workDir = mkdtempSync(join(tmpdir(), `wisp-promotion-${args.tag}-`));
  let cleanupAuditTap: (() => void) | undefined;
  try {
    const assetsDir = join(workDir, "public-assets");
    stage("download and verify public assets", () => {
      downloadPublicAssets(args.tag, version, assetsDir);
      verifyPublicAssets(releaseRoot, assetsDir, version);
    });
    const files = stage("render promotion metadata", () =>
      renderTapFiles(readManifests(assetsDir), readFileSync(notesPath, "utf8"), args.tag, releaseCommit),
    );
    stage("prepare tap checkout", () => {
      requireCleanTap(args.tapDir);
      writeTapFiles(args.tapDir, files);
      command(["git", "-C", args.tapDir, "diff", "--check"], { quiet: true });
    });
    const tapState = classifyTapState(
      changedTapFiles(
        run(["git", "-C", args.tapDir, "status", "--porcelain=v1", "--untracked-files=all"], { quiet: true }),
      ),
    );
    const audit = stage("create isolated Homebrew audit tap", () => prepareAuditTap(args.tapDir));
    cleanupAuditTap = audit.cleanup;
    stage("audit before channel promotion", () => auditBeforePromotion(audit.auditDir));
    if (!args.publish) {
      if (tapState === "already-promoted") {
        stage("verify already-public channel", () => {
          waitForPublicChannel(
            join(args.tapDir, "updates/wisp-desktop-alpha.json"),
            join(workDir, "public-channel.json"),
          );
          auditAfterPromotion();
        });
      }
      const receipt: PromotionReceipt = {
        schemaVersion: 1,
        result: "dry-run",
        tag: args.tag,
        version,
        releaseCommit,
        releaseAssets: metadata.assets.length,
        tapState,
        tapCommit: run(["git", "-C", args.tapDir, "rev-parse", "HEAD"], { quiet: true }),
        channelUrl: CHANNEL_URL,
        completedAt: new Date().toISOString(),
        stageDurationsMs: durations,
      };
      if (args.receipt) writeReceipt(args.receipt, receipt);
      appendStepSummary(receipt);
      return receipt;
    }
    const tapCommit = stage("publish Homebrew tap", () => publishTap(args.tapDir, tapState));
    stage("wait for and audit public channel", () => {
      waitForPublicChannel(join(args.tapDir, "updates/wisp-desktop-alpha.json"), join(workDir, "public-channel.json"));
      auditAfterPromotion();
    });
    const receipt: PromotionReceipt = {
      schemaVersion: 1,
      result: "promoted",
      tag: args.tag,
      version,
      releaseCommit,
      releaseAssets: metadata.assets.length,
      tapState,
      tapCommit,
      channelUrl: CHANNEL_URL,
      completedAt: new Date().toISOString(),
      stageDurationsMs: durations,
    };
    if (args.receipt) writeReceipt(args.receipt, receipt);
    appendStepSummary(receipt);
    return receipt;
  } finally {
    cleanupAuditTap?.();
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const args = parsePromotionArgs(process.argv.slice(2));
    const receipt = promoteRelease(args);
    const verb = receipt.result === "promoted" ? "promoted" : "validated";
    console.log(`${verb} ${receipt.tag} from ${receipt.releaseCommit} through tap ${receipt.tapCommit} (${receipt.tapState})`);
  } catch (error) {
    console.error(`promote-release: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
