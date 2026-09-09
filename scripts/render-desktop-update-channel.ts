#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DesktopReleaseManifest } from "./release-desktop";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_NOTES_BYTES = 16 * 1024;

export interface DesktopUpdateChannel {
  schemaVersion: 1;
  // Keep the original wire contract so installed 0.4 alpha clients can upgrade.
  channel: "alpha";
  version: string;
  publishedAt: string;
  pub_date: string;
  notes: string;
  artifactSize: number;
  platforms: {
    "darwin-aarch64-app": {
      url: string;
      signature: string;
    };
  };
}

export function renderDesktopUpdateChannel(
  manifest: DesktopReleaseManifest,
  notes: string,
): string {
  if (
    manifest.schemaVersion !== 2 ||
    manifest.product !== "wisp-desktop" ||
    manifest.dirty ||
    !VERSION.test(manifest.version) ||
    manifest.target.os !== "darwin" ||
    manifest.target.arch !== "arm64" ||
    manifest.signing.kind !== "developer-id" ||
    !manifest.signing.developerId ||
    !manifest.signing.notarized ||
    !manifest.signing.timestamp ||
    !manifest.signing.hardenedRuntime ||
    !manifest.publishedAt ||
    !manifest.updater ||
    manifest.updater.algorithm !== "minisign-ed25519" ||
    !SHA256.test(manifest.updater.publicKeySha256)
  ) {
    throw new Error("desktop manifest is not a signed, notarized updater release");
  }
  const publishedAt = new Date(manifest.publishedAt);
  if (Number.isNaN(publishedAt.valueOf()) || publishedAt.toISOString() !== manifest.publishedAt) {
    throw new Error("desktop manifest has an invalid publication time");
  }
  const trimmedNotes = notes.trim();
  if (!trimmedNotes || Buffer.byteLength(trimmedNotes) > MAX_NOTES_BYTES) {
    throw new Error("desktop update release notes are empty or too large");
  }
  const artifact = `wisp-desktop-v${manifest.version}-darwin-arm64.tar.gz`;
  if (manifest.artifact.file !== artifact || manifest.artifact.size <= 0) {
    throw new Error("desktop manifest has an invalid updater artifact");
  }
  if (
    manifest.updater.signatureFile !== `${artifact}.sig` ||
    !manifest.updater.signature.trim() ||
    manifest.updater.signature.length > 4 * 1024
  ) {
    throw new Error("desktop manifest has an invalid updater signature");
  }
  const channel: DesktopUpdateChannel = {
    schemaVersion: 1,
    channel: "alpha",
    version: manifest.version,
    publishedAt: manifest.publishedAt,
    pub_date: manifest.publishedAt,
    notes: trimmedNotes,
    artifactSize: manifest.artifact.size,
    platforms: {
      "darwin-aarch64-app": {
        url: `https://github.com/Pepewitch/wisp/releases/download/v${manifest.version}/${artifact}`,
        signature: manifest.updater.signature.trim(),
      },
    },
  };
  const rendered = `${JSON.stringify(channel, null, 2)}\n`;
  if (Buffer.byteLength(rendered) > 64 * 1024) {
    throw new Error("desktop update channel exceeds 64 KiB");
  }
  return rendered;
}

interface Args {
  manifest: string;
  notes: string;
  output: string;
}

function parseArgs(args: string[]): Args {
  const values: Partial<Args> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${name ?? "argument"}`);
    if (name === "--manifest") values.manifest = value;
    else if (name === "--notes") values.notes = value;
    else if (name === "--output") values.output = value;
    else throw new Error(`unknown argument: ${name}`);
  }
  if (!values.manifest || !values.notes || !values.output) {
    throw new Error(
      "usage: render-desktop-update-channel.ts --manifest <manifest> --notes <release-notes> --output <channel>",
    );
  }
  return values as Args;
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const manifest = JSON.parse(readFileSync(resolve(args.manifest), "utf8")) as DesktopReleaseManifest;
    const notes = readFileSync(resolve(args.notes), "utf8");
    const output = resolve(args.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, renderDesktopUpdateChannel(manifest, notes), { mode: 0o644 });
    console.log(`wrote ${output}`);
  } catch (error) {
    console.error(`render-desktop-update-channel: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
