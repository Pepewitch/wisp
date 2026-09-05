#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type BinaryTarget = "native" | "linux-x64" | "darwin-arm64";

export interface SourceIdentity {
  commit: string;
  dirty: boolean;
}

export interface BuildBinaryOptions {
  target: BinaryTarget;
  outfile: string;
  root?: string;
  identity?: SourceIdentity;
}

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function output(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8").trim();
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", root, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = output(result.stderr);
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return output(result.stdout);
}

/** Identity of the exact working tree being compiled, including untracked files. */
export function sourceIdentity(root = SCRIPT_ROOT): SourceIdentity {
  const commit = git(root, ["rev-parse", "HEAD"]);
  if (!SHA_PATTERN.test(commit)) throw new Error(`git returned an invalid commit: ${JSON.stringify(commit)}`);
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  return { commit, dirty: status.length > 0 };
}

export function buildBinary(options: BuildBinaryOptions): SourceIdentity {
  const root = options.root ?? SCRIPT_ROOT;
  const identity = options.identity ?? sourceIdentity(root);
  if (!SHA_PATTERN.test(identity.commit)) {
    throw new Error(`build commit must be a full lowercase Git SHA, got ${JSON.stringify(identity.commit)}`);
  }

  const outfile = resolve(root, options.outfile);
  mkdirSync(dirname(outfile), { recursive: true });
  const cmd = [
    "bun",
    "build",
    "--compile",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    ...(options.target === "linux-x64"
      ? ["--target=bun-linux-x64"]
      : options.target === "darwin-arm64"
        ? ["--target=bun-darwin-arm64"]
        : []),
    `--define=__WISP_BUILD_COMMIT__=${JSON.stringify(identity.commit)}`,
    `--define=__WISP_BUILD_DIRTY__=${String(identity.dirty)}`,
    "src/index.ts",
    `--outfile=${outfile}`,
  ];
  const result = Bun.spawnSync({
    cmd,
    cwd: root,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`binary build failed with exit ${result.exitCode}`);
  return identity;
}

interface BuildArgs {
  target: BinaryTarget;
  outfile: string;
}

function parseArgs(args: string[]): BuildArgs {
  let target: BinaryTarget | undefined;
  let outfile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === "--target" && value) {
      if (value !== "native" && value !== "linux-x64" && value !== "darwin-arm64") {
        throw new Error(`unsupported binary target: ${value}`);
      }
      target = value;
      i++;
    } else if (arg === "--outfile" && value) {
      outfile = value;
      i++;
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }
  if (!target || !outfile) {
    throw new Error("usage: build-binary.ts --target <native|linux-x64|darwin-arm64> --outfile <path>");
  }
  return { target, outfile };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const identity = buildBinary(args);
    console.log(`built ${args.outfile} from ${identity.commit}${identity.dirty ? " (dirty)" : ""}`);
  } catch (error) {
    console.error(`build-binary: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
