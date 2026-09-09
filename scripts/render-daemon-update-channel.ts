#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isReleaseVersion } from "../shared/release-version";
import type { DesktopReleaseManifest } from "./release-desktop";
import type { ReleaseManifest } from "../wispd/scripts/release-linux";

const SHA256 = /^[0-9a-f]{64}$/;

export interface DaemonUpdateChannel {
  schemaVersion: 1;
  product: "wisp";
  version: string;
  apiProtocolVersion: number;
  publishedAt: string;
}

export function renderDaemonUpdateChannel(
  manifest: ReleaseManifest,
  publishedAt: string | null,
): string {
  const published =
    typeof publishedAt === "string" ? new Date(publishedAt) : new Date(NaN);
  const artifact = `wisp-v${manifest.version}-linux-x86_64`;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.product !== "wisp" ||
    !isReleaseVersion(manifest.version) ||
    !Number.isSafeInteger(manifest.apiProtocolVersion) ||
    manifest.apiProtocolVersion < 1 ||
    typeof manifest.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(manifest.commit) ||
    manifest.dirty !== false ||
    manifest.target?.os !== "linux" ||
    manifest.target.arch !== "x86_64" ||
    manifest.target.libc !== "glibc" ||
    manifest.artifact?.file !== artifact ||
    !SHA256.test(manifest.artifact.sha256) ||
    !Number.isSafeInteger(manifest.artifact.size) ||
    manifest.artifact.size < 1
  ) {
    throw new Error("Linux manifest is not a valid Wisp daemon release");
  }
  if (
    typeof publishedAt !== "string" ||
    Number.isNaN(published.valueOf()) ||
    published.toISOString() !== publishedAt
  ) {
    throw new Error("daemon update channel has an invalid publication time");
  }
  const channel: DaemonUpdateChannel = {
    schemaVersion: 1,
    product: "wisp",
    version: manifest.version,
    apiProtocolVersion: manifest.apiProtocolVersion,
    publishedAt,
  };
  return `${JSON.stringify(channel, null, 2)}\n`;
}

interface Args {
  manifest: string;
  desktopManifest: string;
  output: string;
}

function parseArgs(args: string[]): Args {
  const values: Partial<Args> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${name ?? "argument"}`);
    if (name === "--manifest") values.manifest = value;
    else if (name === "--desktop-manifest") values.desktopManifest = value;
    else if (name === "--output") values.output = value;
    else throw new Error(`unknown argument: ${name}`);
  }
  if (!values.manifest || !values.desktopManifest || !values.output) {
    throw new Error(
      "usage: render-daemon-update-channel.ts --manifest <release-manifest.json> --desktop-manifest <release-manifest-desktop-darwin-arm64.json> --output <path>",
    );
  }
  return values as Args;
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const manifest = JSON.parse(readFileSync(resolve(args.manifest), "utf8")) as ReleaseManifest;
    const desktop = JSON.parse(
      readFileSync(resolve(args.desktopManifest), "utf8"),
    ) as DesktopReleaseManifest;
    const output = resolve(args.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, renderDaemonUpdateChannel(manifest, desktop.publishedAt), {
      mode: 0o644,
    });
    console.log(`wrote ${output}`);
  } catch (error) {
    console.error(
      `render-daemon-update-channel: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
