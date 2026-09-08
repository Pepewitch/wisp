import { IMAGE_INPUT_STRATEGIES } from "./images";
import type { AdapterDef } from "./types";

/**
 * Expand an image argv template against the turn's stored paths (S3): an
 * element containing {path} maps to one arg PER path — so codex's
 * ["-i", "{path}", "--"] with two files yields ["-i", "a.png", "b.jpg", "--"].
 */
function expandImageTemplate(template: string[], paths: string[]): string[] {
  return template.flatMap((part) => (part.includes("{path}") ? paths.map((p) => part.replaceAll("{path}", p)) : [part]));
}

export function buildArgv(
  def: AdapterDef,
  opts: {
    prompt: string;
    session?: string | null;
    model?: string | null;
    effort?: string | null;
    /**
     * This turn's stored attachment paths (S3). With def.image they expand
     * into argv immediately before the prompt positional; with def.imageInput
     * they switch the turn to the strategy's stdin envelope instead (the
     * prompt leaves argv entirely — it rides the NDJSON line).
     */
    images?: string[];
    /** Enable the adapter's duplex prompt channel for an actual runner turn. */
    live?: boolean;
  },
): string[] {
  const sub = (s: string) =>
    s
      .replaceAll("{session}", opts.session ?? "")
      .replaceAll("{model}", opts.model ?? "")
      .replaceAll("{effort}", opts.effort ?? "");
  const argv = [def.bin, ...def.exec];
  if (opts.session && def.resume) argv.push(...def.resume.map(sub));
  if (opts.model && def.model) argv.push(...def.model.map(sub));
  if (opts.effort && def.effort) argv.push(...def.effort.map(sub));
  const images = opts.images ?? [];
  // Droid's live channel is JSON-RPC, not an IMAGE_INPUT_STRATEGY. The runner
  // swaps its command and owns that protocol; buildArgv remains useful for
  // diagnostics and one-shot adapter tests.
  const inputStrategy =
    opts.live && def.liveInput === "claude-stream-json"
      ? def.liveInput
      : images.length > 0
        ? def.imageInput
        : null;
  // the image slot is immediately before the prompt positional, after
  // resume/model/effort — spike-verified: any earlier and codex's variadic
  // -i would eat those flags' values
  if (images.length > 0 && def.image) argv.push(...expandImageTemplate(def.image, images));
  if (inputStrategy) {
    const strategy = IMAGE_INPUT_STRATEGIES[inputStrategy];
    // unreachable via config (validateAdapter rejects unknown names at load), so
    // this only fires on a def built in code — loud beats a silent prompt-only turn
    if (!strategy) {
      const known = Object.keys(IMAGE_INPUT_STRATEGIES).join(", ");
      const field = def.liveInput === inputStrategy ? "liveInput" : "imageInput";
      throw new Error(`adapter ${field} '${inputStrategy}' is not a known strategy (known: ${known})`);
    }
    argv.push(...strategy.argv);
  }
  if (!inputStrategy) argv.push(opts.prompt);
  return argv;
}

export function buildAttachArgv(def: AdapterDef, session: string): string[] | null {
  if (!def.attach) return null;
  return [def.bin, ...def.attach.map((s) => s.replaceAll("{session}", session))];
}
