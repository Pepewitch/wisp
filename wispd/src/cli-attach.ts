import { basename, resolve } from "node:path";
import {
  ATTACHMENT_KIND_LIMITS,
  attachmentKind,
  formatBytes,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_TURN_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_BYTES,
  SNIFF_WINDOW_BYTES,
  sniffAttachmentHeader,
  SUPPORTED_ATTACHMENTS,
  type StagedAttachmentPayload,
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
 * `--attach ./orders.csv` → a one-shot upload reference for create/send (A1b).
 *
 * The daemon is still the authority: it re-sniffs the magic bytes and re-checks
 * every cap on the request. What this does is fail EARLY and locally on the
 * three things only the CLI can see — a path that does not exist, a file wisp
 * does not take, and one that is over its kind's cap. It reads only the sniff
 * window locally; the actual file streams to the daemon as a raw body.
 *
 * `--image` still works and means the same thing: it was the flag's name while
 * images were the only attachment, and a flag in someone's shell history is a
 * promise. Both may appear on one command line.
 *
 * Exits rather than throwing: a bad path is a usage error, and the caller
 * has not sent anything yet.
 */
export type UploadAttachment = (path: string, name: string) => Promise<StagedAttachmentPayload>;
export type DiscardAttachment = (uploadId: string) => Promise<unknown>;

export async function discardAttachmentPayloads(
  files: StagedAttachmentPayload[],
  discard: DiscardAttachment,
): Promise<void> {
  await Promise.allSettled(files.map((file) => discard(file.uploadId)));
}

export async function readAttachmentFlags(
  flags: AttachmentFlags,
  upload: UploadAttachment,
  discard: DiscardAttachment,
): Promise<StagedAttachmentPayload[] | undefined> {
  const named: [string, string][] = [
    ...flagPaths(flags.attach, "--attach").map((p): [string, string] => ["--attach", p]),
    ...flagPaths(flags.image, "--image").map((p): [string, string] => ["--image", p]),
  ];
  if (named.length === 0) return undefined;
  if (named.length > MAX_ATTACHMENTS_PER_TURN) {
    console.error(`at most ${MAX_ATTACHMENTS_PER_TURN} attachments per turn, got ${named.length}`);
    process.exit(1);
  }
  const validated: Array<{ path: string; name: string }> = [];
  let total = 0;
  for (const [flag, p] of named) {
    const file = Bun.file(resolve(p));
    if (!(await file.exists())) {
      console.error(`${flag} ${p}: no such file`);
      process.exit(1);
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      console.error(`${flag} ${p}: ${formatBytes(file.size)} exceeds the ${formatBytes(MAX_ATTACHMENT_BYTES)} per-file limit`);
      process.exit(1);
    }
    const head = new Uint8Array(await file.slice(0, SNIFF_WINDOW_BYTES).arrayBuffer());
    const mediaType = sniffAttachmentHeader(head);
    if (!mediaType) {
      console.error(`${flag} ${p}: not a supported attachment (magic-byte sniff) — wisp takes ${SUPPORTED_ATTACHMENTS}`);
      process.exit(1);
    }
    const kind = attachmentKind(mediaType);
    const limit = ATTACHMENT_KIND_LIMITS[kind];
    if (file.size > limit) {
      console.error(
        `${flag} ${p}: ${formatBytes(file.size)} exceeds the ${formatBytes(limit)} limit for ${kind} attachments`,
      );
      process.exit(1);
    }
    total += file.size;
    // The turn's budget is checked before upload, so several individually
    // legal files cannot spend bandwidth only to be rejected as a group.
    if (total > MAX_TURN_ATTACHMENT_BYTES) {
      console.error(
        `${flag} ${p}: these attachments total ${formatBytes(total)}, over the ${formatBytes(MAX_TURN_ATTACHMENT_BYTES)} limit for one turn`,
      );
      process.exit(1);
    }
    validated.push({ path: resolve(p), name: basename(p) });
  }
  const uploaded: StagedAttachmentPayload[] = [];
  try {
    for (const file of validated) {
      uploaded.push(await upload(file.path, file.name));
    }
    return uploaded;
  } catch (error) {
    await discardAttachmentPayloads(uploaded, discard);
    throw error;
  }
}
