#!/usr/bin/env bun
// Resolves the release the promotion dry run should replay.
//
// The dry run needs a published release whose tap files it can re-render and
// compare byte for byte. That is always the release the tap currently serves,
// so this reads it out of the tap instead of carrying a pinned tag that has to
// be advanced by hand after every promotion.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertPromotableFixture, promotionFixtureTag, TAP_FILES } from "./release-promotion";

const DESKTOP_CHANNEL = "updates/wisp-desktop-alpha.json";

interface Args {
  tapDir: string;
}

function parseArgs(args: string[]): Args {
  let tapDir: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${name ?? "argument"}`);
    if (name === "--tap-dir") tapDir = value;
    else throw new Error(`unknown argument: ${name}`);
  }
  if (!tapDir) throw new Error("usage: promotion-fixture.ts --tap-dir <homebrew-tap>");
  return { tapDir: resolve(tapDir) };
}

export function resolveFixtureTag(tapDir: string): string {
  const channel = join(tapDir, DESKTOP_CHANNEL);
  if (!existsSync(channel)) {
    throw new Error(`tap checkout does not contain ${DESKTOP_CHANNEL}: ${tapDir}`);
  }
  const tag = promotionFixtureTag(readFileSync(channel, "utf8"));
  assertPromotableFixture(
    tag,
    TAP_FILES.filter((file) => existsSync(join(tapDir, file))),
  );
  return tag;
}

if (import.meta.main) {
  try {
    console.log(resolveFixtureTag(parseArgs(process.argv.slice(2)).tapDir));
  } catch (error) {
    console.error(`promotion-fixture: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
