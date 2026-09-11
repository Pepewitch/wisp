import { basename, resolve } from "node:path";
import {
  ATTACHMENT_KIND_LIMITS,
  attachmentKind,
  formatBytes,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_TURN_ATTACHMENT_BYTES,
  sniffAttachmentType,
  SUPPORTED_ATTACHMENTS,
  type AttachmentPayload,
} from "./attachments";

/** The two flags that name files; `--image` is what `--attach` used to be called. */
export interface AttachmentFlags {
  attach?: string | boolean | string[];
  image?: string | boolean | string[];
}

function flagPaths(raw: string | boolean | string[] | undefined, flag: string): string[] {
  if (raw === undefined) return [];
  if (raw === true) {
    console.error(`${flag} requires a path (e.g. ${flag} ./notes.csv)`);
    process.exit(1);
  }
  return Array.isArray(raw) ? raw : [String(raw)];
}

/**
 * `--attach ./orders.csv` → the wire payload the create/send routes take (A1b).
 *
 * The daemon is still the authority: it re-sniffs the magic bytes and re-checks
 * every cap on the request. What this does is fail EARLY and locally on the
 * three things only the CLI can see — a path that does not exist, a file wisp
 * does not take, and one that is over its kind's cap — because the alternative
 * is base64-ing 50 MB of someone's video up a socket to be told the same thing.
 *
 * `--image` still works and means the same thing: it was the flag's name while
 * images were the only attachment, and a flag in someone's shell history is a
 * promise. Both may appear on one command line.
 *
 * Exits rather than throwing: a bad path is a usage error, and the caller
 * has not sent anything yet.
 */
export async function readAttachmentFlags(flags: AttachmentFlags): Promise<AttachmentPayload[] | undefined> {
  const named: [string, string][] = [
    ...flagPaths(flags.attach, "--attach").map((p): [string, string] => ["--attach", p]),
    ...flagPaths(flags.image, "--image").map((p): [string, string] => ["--image", p]),
  ];
  if (named.length === 0) return undefined;
  if (named.length > MAX_ATTACHMENTS_PER_TURN) {
    console.error(`at most ${MAX_ATTACHMENTS_PER_TURN} attachments per turn, got ${named.length}`);
    process.exit(1);
  }
  const out: AttachmentPayload[] = [];
  let total = 0;
  for (const [flag, p] of named) {
    const file = Bun.file(resolve(p));
    if (!(await file.exists())) {
      console.error(`${flag} ${p}: no such file`);
      process.exit(1);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mediaType = sniffAttachmentType(bytes);
    if (!mediaType) {
      console.error(`${flag} ${p}: not a supported attachment (magic-byte sniff) — wisp takes ${SUPPORTED_ATTACHMENTS}`);
      process.exit(1);
    }
    const kind = attachmentKind(mediaType);
    const limit = ATTACHMENT_KIND_LIMITS[kind];
    if (bytes.byteLength > limit) {
      console.error(
        `${flag} ${p}: ${formatBytes(bytes.byteLength)} exceeds the ${formatBytes(limit)} limit for ${kind} attachments`,
      );
      process.exit(1);
    }
    total += bytes.byteLength;
    // the turn's budget, before the encode rather than after it: ten legal
    // 20 MB texts are 200 MB of base64 to be told the same thing by the daemon
    if (total > MAX_TURN_ATTACHMENT_BYTES) {
      console.error(
        `${flag} ${p}: these attachments total ${formatBytes(total)}, over the ${formatBytes(MAX_TURN_ATTACHMENT_BYTES)} limit for one turn`,
      );
      process.exit(1);
    }
    out.push({ name: basename(p), dataBase64: Buffer.from(bytes).toString("base64") });
  }
  return out;
}
