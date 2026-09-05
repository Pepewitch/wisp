import { useRef, useState } from "react";
import type { ClipboardEvent } from "react";

/**
 * The client half of S3 attachments. The daemon's src/attachments.ts is the
 * AUTHORITY — it re-sniffs magic bytes and re-checks every cap on the wire;
 * these mirrors exist so a bad paste fails quietly-inline instead of
 * round-tripping. The two files share caps and wording by hand (the classic
 * UI's key-sharing contract, one level up).
 *
 * Paste-only this slice (drag-drop chrome is NOT scope). Pending rows render
 * as muted text (`name.png · 12 KB · ✕`) — no chip, no badge, no tint
 * (design law); the small thumbnail is content, not status.
 */

/** Mirror of src/attachments.ts — the daemon re-validates regardless. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export interface PendingAttachment {
  id: string;
  name: string;
  mediaType: string;
  /** the create/send wire payload's data half */
  dataBase64: string;
  bytes: number;
  /** object URL for the content thumbnail; "" where createObjectURL is absent (jsdom) */
  url: string;
}

/**
 * The one place a stored attachment's URL is built (A1a). Same-origin and
 * cookie-authed like every other read. The name is percent-encoded because it
 * is a path segment on the wire — the daemon still resolves it against the
 * turn's manifest rather than against the filesystem, so this encoding is
 * transport correctness, not a security boundary.
 */
export function attachmentUrl(taskId: string, turn: number, name: string): string {
  return `/api/tasks/${taskId}/attachments/${turn}/${encodeURIComponent(name)}`;
}

export function messageAttachmentUrl(taskId: string, messageId: string, name: string): string {
  return `/api/tasks/${taskId}/messages/${messageId}/attachments/${encodeURIComponent(name)}`
}

/** POST /api/tasks and /send accept attachments as { name, dataBase64 }. */
export interface AttachmentPayload {
  name: string;
  dataBase64: string;
}

export function attachmentPayloads(list: PendingAttachment[]): AttachmentPayload[] {
  return list.map((a) => ({ name: a.name, dataBase64: a.dataBase64 }));
}

/**
 * The disabled-with-reason note for a paste against a harness without
 * capability. No harness is named here: all three builtins CAN take an image
 * (A1c gave droid delivery by path), so the only defs left without a mechanism
 * are ones the user wrote, and the honest sentence names theirs.
 */
export function noImageReason(harness: string): string {
  return `harness '${harness}' has no image-attachment capability`;
}

/** src/attachments.ts's sniffer, mirrored: png/jpeg/gif/webp by magic bytes, never the pasted mime. */
export function sniffImageType(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && // RIFF….WEBP
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** src/attachments.ts's formatBytes, mirrored: "320 B" / "12 KB" / "1.2 MB". */
export function formatBytes(n: number): string {
  const trimmed = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${trimmed(kb)} KB`;
  return `${trimmed(kb / 1024)} MB`;
}

/** base64 without the spread-stack blowup (5MB of bytes never hits one apply). */
function base64Encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * Read one pasted file into a pending attachment, or name the client-side
 * rejection (type / empty / oversize). The count cap lives in the hook —
 * it owns the running list.
 */
export async function readAttachment(
  file: File,
): Promise<{ ok: true; attachment: Omit<PendingAttachment, "id" | "url"> } | { ok: false; reason: string }> {
  const name = file.name || "pasted image";
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) return { ok: false, reason: `${name}: empty file` };
  const mediaType = sniffImageType(bytes);
  if (!mediaType) return { ok: false, reason: `${name}: not a png/jpeg/gif/webp image` };
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: `${name}: ${formatBytes(bytes.byteLength)} exceeds the 5 MB per-file limit` };
  }
  return { ok: true, attachment: { name, mediaType, dataBase64: base64Encode(bytes), bytes: bytes.byteLength } };
}

export interface PendingAttachments {
  list: PendingAttachment[];
  /** the muted client-side note (capability / caps / type) — null when quiet */
  note: string | null;
  /** wire payloads for the submit body; undefined = omit the field entirely */
  payloads: () => AttachmentPayload[] | undefined;
  /**
   * Image-file half of composer paste. Text (including HTML hyperlinks) is
   * left to handleComposerPaste — this only preventDefaults when there are files.
   */
  onPaste: (e: ClipboardEvent) => void;
  /**
   * Attach files chosen from the machine (A1a: "pick images from my folder").
   * The same read/validate/note path as a paste — a picked file and a pasted
   * file must not be able to disagree about what is acceptable.
   */
  addFiles: (files: File[]) => void;
  /** false when the harness has no image capability: the picker says why instead of opening */
  enabled: boolean;
  /** the reason the picker is disabled, or null */
  disabledReason: string | null;
  /**
   * The harness's delivery caveat, shown while images are pending (A1c). Not a
   * rejection: the attach worked, and this is the part of "worked" the user
   * cannot see from the rows alone.
   */
  deliveryNote: string | null;
  remove: (id: string) => void;
  /** clears rows + note; the composers call it ONLY after a successful submit */
  clear: () => void;
}

/**
 * Pending-attachment state for one composer (create dialog / steer box).
 * `hasImage` is tri-state: true/false = known capability (false pastes get
 * the disabled-with-reason note and attach nothing), undefined = the harness
 * list hasn't landed yet — allow optimistically; the daemon re-validates
 * and its named 400 renders inline.
 */
export function usePendingAttachments({
  harness,
  hasImage,
  imageNote,
}: {
  harness: string | null;
  hasImage: boolean | undefined;
  /**
   * The harness's own caveat about HOW its images travel (A1c: droid reads them
   * from a path, which is png/jpeg-only and depends on the model). Written by
   * the adapter, carried by /api/harnesses, shown here — the composer never
   * composes this sentence itself.
   */
  imageNote?: string;
}): PendingAttachments {
  const [list, setList] = useState<PendingAttachment[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const seq = useRef(0);
  // the async paste loop reads the live list through this mirror, so the
  // setters stay pure (no URL revocation inside a state updater)
  const listRef = useRef<PendingAttachment[]>([]);
  const commit = (next: PendingAttachment[]) => {
    listRef.current = next;
    setList(next);
  };

  const remove = (id: string) => {
    const hit = listRef.current.find((a) => a.id === id);
    if (hit?.url) URL.revokeObjectURL(hit.url);
    commit(listRef.current.filter((a) => a.id !== id));
  };

  const clear = () => {
    for (const a of listRef.current) if (a.url) URL.revokeObjectURL(a.url);
    commit([]);
    setNote(null);
  };

  /** One path for both pasting and picking: the two must never disagree. */
  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    if (harness && hasImage === false) {
      setNote(noImageReason(harness));
      return; // disabled-with-reason: nothing attaches
    }
    void (async () => {
      let rejection: string | null = null;
      for (const file of files) {
        if (listRef.current.length >= MAX_ATTACHMENTS) {
          rejection = `at most ${MAX_ATTACHMENTS} attachments per turn`;
          break;
        }
        const result = await readAttachment(file);
        if (!result.ok) {
          rejection = result.reason;
          continue;
        }
        seq.current += 1;
        const url = typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "";
        commit([...listRef.current, { id: `att-${seq.current}`, url, ...result.attachment }]);
      }
      // a fully-clean batch clears the previous note; the latest rejection wins otherwise
      setNote(rejection);
    })();
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return; // a text paste passes through untouched
    e.preventDefault(); // an image paste never inserts junk text
    addFiles(files);
  };

  return {
    list,
    note,
    payloads: () => (list.length > 0 ? attachmentPayloads(list) : undefined),
    onPaste,
    addFiles,
    enabled: !(harness && hasImage === false),
    disabledReason: harness && hasImage === false ? noImageReason(harness) : null,
    // shown only once there is something to caveat
    deliveryNote: list.length > 0 ? (imageNote ?? null) : null,
    remove,
    clear,
  };
}
