import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ATTACHMENT_KIND_LIMITS,
  attachmentPayloads,
  clearRememberedAttachments,
  formatBytes,
  insertPastedText,
  MAX_ATTACHMENTS,
  MAX_TURN_ATTACHMENT_BYTES,
  noImageReason,
  PASTE_TO_FILE_CHARS,
  pastedTextFile,
  readAttachment,
  sniffAttachmentType,
  sniffImageType,
  usePendingAttachments,
  type PendingAttachment,
} from "./attachments";

afterEach(() => {
  clearRememberedAttachments("synthetic-connection");
  clearRememberedAttachments("other-connection");
  vi.unstubAllGlobals();
});

/**
 * The client mirror of the daemon's attachment rules (S3): caps and the
 * magic-byte sniffer track src/attachments.ts by hand — the daemon
 * re-validates everything on the wire, these tests pin the client side.
 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 4, 5]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const PDF = new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n");
const MP4 = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypisom"), 1, 2, 3, 4]);
const CSV = new TextEncoder().encode("id,name\n1,café\n2,ok\n");
const HEIC = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic"), 1, 2, 3, 4]);
const BINARY = new Uint8Array([0x00, 0x01, 0x02, 0xff]);

function file(bytes: Uint8Array<ArrayBuffer>, name = "shot.png"): File {
  return new File([bytes], name);
}

function delayedFile(name = "delayed.png") {
  let resolve!: (value: ArrayBuffer) => void;
  const bytes = new Promise<ArrayBuffer>((accept) => {
    resolve = accept;
  });
  const selected = file(PNG, name);
  vi.spyOn(selected, "arrayBuffer").mockReturnValue(bytes);
  return {
    selected,
    resolve: () => resolve(Uint8Array.from(PNG).buffer),
  };
}

function stubObjectUrls() {
  const createObjectURL = vi.fn(() => "blob:synthetic");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
  return { createObjectURL, revokeObjectURL };
}

async function settleDelayedRead(resolve: () => void): Promise<void> {
  await act(async () => {
    resolve();
    await new Promise((accept) => setTimeout(accept, 0));
  });
}

describe("sniffImageType (mirrors src/attachments.ts)", () => {
  it("recognizes png/jpeg/gif/webp by magic bytes", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });

  it("rejects short and foreign byte strings", () => {
    expect(sniffImageType(new Uint8Array([0x89]))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("hello world"))).toBeNull();
    expect(sniffImageType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // %PDF
  });
});

describe("sniffAttachmentType (mirrors src/attachments.ts)", () => {
  it("recognizes every kind the daemon stores, text last", () => {
    expect(sniffAttachmentType(PNG)).toBe("image/png");
    expect(sniffAttachmentType(PDF)).toBe("application/pdf");
    expect(sniffAttachmentType(MP4)).toBe("video/mp4");
    expect(sniffAttachmentType(CSV)).toBe("text/plain");
    expect(sniffAttachmentType(BINARY)).toBeNull();
    expect(sniffAttachmentType(new Uint8Array([]))).toBeNull();
    // the ftyp box is shared with HEIC/AVIF photos and M4A audio: brand decides
    expect(sniffAttachmentType(HEIC)).toBeNull();
  });
});

describe("formatBytes (mirrors src/attachments.ts)", () => {
  it("formats like the daemon: 320 B / 12 KB / 1.2 MB", () => {
    expect(formatBytes(320)).toBe("320 B");
    expect(formatBytes(12 * 1024)).toBe("12 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2 MB");
    expect(formatBytes(1_204_225)).toBe("1.1 MB");
  });
});

describe("readAttachment", () => {
  it("reads a png into a pending row with its sniffed media type and kind", async () => {
    const r = await readAttachment(file(PNG));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attachment.name).toBe("shot.png");
    expect(r.attachment.mediaType).toBe("image/png");
    expect(r.attachment.kind).toBe("image");
    expect(r.attachment.bytes).toBe(PNG.byteLength);
    // the FILE is kept, not its base64: encoding waits for the submit (A1d)
    expect(r.attachment.file.name).toBe("shot.png");
  });

  it("takes pdf, text and video too, each with its own kind", async () => {
    const kinds = await Promise.all([
      readAttachment(file(PDF, "spec.pdf")),
      readAttachment(file(CSV, "orders.csv")),
      readAttachment(file(MP4, "clip.mp4")),
    ]);
    expect(kinds.map((r) => (r.ok ? [r.attachment.kind, r.attachment.mediaType] : r.reason))).toEqual([
      ["pdf", "application/pdf"],
      ["text", "text/plain"],
      ["video", "video/mp4"],
    ]);
  });

  it("names a nameless clipboard file 'pasted image'", async () => {
    const r = await readAttachment(file(PNG, ""));
    expect(r.ok && r.attachment.name === "pasted image").toBe(true);
  });

  it("rejects unstorable bytes, empty files, and oversize with named reasons", async () => {
    const unsupported = await readAttachment(file(BINARY));
    expect(unsupported).toEqual({
      ok: false,
      reason: "shot.png: not an image, pdf, text file, or mp4/mov/webm video",
    });

    const empty = await readAttachment(file(new Uint8Array([])));
    expect(empty).toEqual({ ok: false, reason: "shot.png: empty file" });

    // the cap that applies is the KIND's: 5 MB of png is over, 5 MB of csv is not
    const big = new Uint8Array(ATTACHMENT_KIND_LIMITS.image + 1);
    big.set(PNG); // it must SNIFF as png to reach the size branch
    const oversize = await readAttachment(file(big));
    expect(oversize.ok).toBe(false);
    if (!oversize.ok) expect(oversize.reason).toContain("exceeds the 5 MB limit for image attachments");

    const text = new Uint8Array(ATTACHMENT_KIND_LIMITS.image + 1).fill(0x61);
    expect((await readAttachment(file(text, "big.csv"))).ok).toBe(true);
  });
});

describe("pastedTextFile (A1d)", () => {
  it("keeps a delimited paste's extension, so the agent knows what it has", () => {
    expect(pastedTextFile("a,b\n1,2\n3,4\n", 1).name).toBe("pasted-1.csv");
    expect(pastedTextFile("a\tb\n1\t2\n", 2).name).toBe("pasted-2.tsv");
    expect(pastedTextFile("just a long note\nwith prose\n", 3).name).toBe("pasted-3.txt");
  });

  it("the cutoff is a real threshold, and insertion puts the text back where it was", () => {
    expect(PASTE_TO_FILE_CHARS).toBe(8000);
    expect(insertPastedText("start end", { name: "pasted-1.txt", text: "MID", caret: 5 })).toBe("startMID end");
    // the value has been editable since the paste, so a stale caret is clamped
    expect(insertPastedText("ab", { name: "pasted-1.txt", text: "X", caret: 99 })).toBe("abX");
  });
});

describe("noImageReason", () => {
  // A1c: droid is no longer a special case — all three builtins can take an
  // image, so the only defs without a mechanism are ones the user wrote
  it("names the harness that declared no mechanism", () => {
    expect(noImageReason("droid")).toBe("harness 'droid' has no image-attachment capability");
    expect(noImageReason("opencode")).toBe("harness 'opencode' has no image-attachment capability");
  });
});

describe("attachmentPayloads", () => {
  it("encodes each row's file into the wire shape { name, dataBase64 }", async () => {
    const list: PendingAttachment[] = [
      {
        id: "a1",
        name: "a.txt",
        mediaType: "text/plain",
        kind: "text",
        file: new File(["ABC"], "a.txt"),
        bytes: 3,
        url: "",
      },
    ];
    expect(await attachmentPayloads(list)).toEqual([{ name: "a.txt", dataBase64: "QUJD" }]);
  });

  it("the caps constants mirror the daemon's", () => {
    expect(ATTACHMENT_KIND_LIMITS).toEqual({
      image: 5 * 1024 * 1024,
      pdf: 20 * 1024 * 1024,
      text: 20 * 1024 * 1024,
      video: 50 * 1024 * 1024,
    });
    expect(MAX_TURN_ATTACHMENT_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_ATTACHMENTS).toBe(10);
  });
});

describe("per-file capability and the turn budget", () => {
  it("refuses an IMAGE by name on a harness without one, and takes the rest of the batch", async () => {
    const hook = renderHook(() =>
      usePendingAttachments({ harness: "opencode", hasImage: false }),
    );
    act(() => hook.result.current.addFiles([file(PNG, "shot.png"), file(CSV, "orders.csv")]));
    await waitFor(() => expect(hook.result.current.list).toHaveLength(1));
    expect(hook.result.current.list[0]!.name).toBe("orders.csv");
    expect(hook.result.current.note).toBe(noImageReason("opencode"));
  });

  it("a paste that would blow the turn's byte budget is refused by name", async () => {
    const hook = renderHook(() => usePendingAttachments({ harness: "codex", hasImage: true }));
    // each file is under the 20 MB text cap; the third one is over the TURN
    const chunk = new Uint8Array(18 * 1024 * 1024).fill(0x61);
    act(() => hook.result.current.addFiles([file(chunk, "one.csv"), file(chunk, "two.csv")]));
    await waitFor(() => expect(hook.result.current.list).toHaveLength(2));
    act(() => hook.result.current.addFiles([file(chunk, "three.csv")]));
    await waitFor(() => expect(hook.result.current.note).toBe("three.csv: over the 50 MB limit for one turn"));
    expect(hook.result.current.list).toHaveLength(2);
  });

  it("a long paste that cannot attach makes no offer to undo", async () => {
    const hook = renderHook(() => usePendingAttachments({ harness: "codex", hasImage: true }));
    const chunk = new Uint8Array(18 * 1024 * 1024).fill(0x61);
    act(() => hook.result.current.addFiles([file(chunk, "one.csv"), file(chunk, "two.csv"), file(chunk, "three.csv")]));
    await waitFor(() =>
      expect(hook.result.current.note).toBe("three.csv: over the 50 MB limit for one turn"),
    );

    // 36 MB is already attached. This paste is below the 20 MB text-file cap,
    // but genuinely crosses the 50 MB turn cap.
    const pasted = "a".repeat(15 * 1024 * 1024);
    act(() => hook.result.current.addPastedText(pasted, 0));
    await waitFor(() =>
      expect(hook.result.current.note).toBe("pasted-1.txt: over the 50 MB limit for one turn"),
    );
    // no row landed, so there is nothing to insert back — an offer that does
    // nothing when taken is worse than no offer
    expect(hook.result.current.pastedText).toBeNull();
    expect(hook.result.current.list).toHaveLength(2);
  });

  it("a long paste becomes a file the composer can put back inline", async () => {
    const hook = renderHook(() => usePendingAttachments({ harness: "codex", hasImage: true }));
    const pasted = "id,name\n" + "1,a\n".repeat(PASTE_TO_FILE_CHARS);
    act(() => hook.result.current.addPastedText(pasted, 4));
    await waitFor(() => expect(hook.result.current.list).toHaveLength(1));
    expect(hook.result.current.list[0]!.name).toBe("pasted-1.csv");
    expect(hook.result.current.pastedText).toEqual({ name: "pasted-1.csv", text: pasted, caret: 4 });
    // removing the row is the other half of the undo: the offer goes with it
    act(() => hook.result.current.remove(hook.result.current.list[0]!.id));
    expect(hook.result.current.pastedText).toBeNull();
  });
});

describe("remembered desktop attachments", () => {
  it("keeps pending bytes across a task view unmount until explicitly cleared", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:synthetic"),
      revokeObjectURL: vi.fn(),
    });
    const options = {
      harness: "codex",
      hasImage: true,
      rememberKey: "synthetic-connection\u0000synthetic-task",
    };
    const first = renderHook(() => usePendingAttachments(options));
    act(() => first.result.current.addFiles([file(PNG)]));
    await waitFor(() => expect(first.result.current.list).toHaveLength(1));
    first.unmount();

    const second = renderHook(() => usePendingAttachments(options));
    expect(second.result.current.list).toHaveLength(1);
    expect(await second.result.current.payloads()).toEqual([
      expect.objectContaining({ name: "shot.png" }),
    ]);
    act(() => second.result.current.clear());
    expect(second.result.current.list).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic");
  });

  it("does not let delayed bytes reappear after the composer is cleared", async () => {
    const urls = stubObjectUrls();
    const delayed = delayedFile();
    const hook = renderHook(() => usePendingAttachments({ harness: "codex", hasImage: true }));

    act(() => hook.result.current.addFiles([delayed.selected]));
    await waitFor(() => expect(delayed.selected.arrayBuffer).toHaveBeenCalledOnce());
    act(() => hook.result.current.clear());
    await settleDelayedRead(delayed.resolve);

    expect(hook.result.current.list).toEqual([]);
    expect(hook.result.current.note).toBeNull();
    expect(urls.createObjectURL).not.toHaveBeenCalled();
  });

  it("does not let a delayed read survive destructive connection removal", async () => {
    const urls = stubObjectUrls();
    const delayed = delayedFile();
    const options = {
      harness: "codex",
      hasImage: true,
      rememberKey: "synthetic-connection\u0000removed-task",
    };
    const hook = renderHook(() => usePendingAttachments(options));

    act(() => hook.result.current.addFiles([delayed.selected]));
    await waitFor(() => expect(delayed.selected.arrayBuffer).toHaveBeenCalledOnce());
    act(() => clearRememberedAttachments("synthetic-connection"));
    await settleDelayedRead(delayed.resolve);
    hook.unmount();

    const reopened = renderHook(() => usePendingAttachments(options));
    expect(reopened.result.current.list).toEqual([]);
    expect(await reopened.result.current.payloads()).toBeUndefined();
    expect(urls.createObjectURL).not.toHaveBeenCalled();
  });

  it("invalidates every delayed composer in a reset-style connection clear", async () => {
    const urls = stubObjectUrls();
    const firstFile = delayedFile("first.png");
    const secondFile = delayedFile("second.png");
    const firstOptions = {
      harness: "codex",
      hasImage: true,
      rememberKey: "synthetic-connection\u0000first-task",
    };
    const secondOptions = {
      harness: "codex",
      hasImage: true,
      rememberKey: "synthetic-connection\u0000second-task",
    };
    const first = renderHook(() => usePendingAttachments(firstOptions));
    const second = renderHook(() => usePendingAttachments(secondOptions));

    act(() => {
      first.result.current.addFiles([firstFile.selected]);
      second.result.current.addFiles([secondFile.selected]);
    });
    await waitFor(() => {
      expect(firstFile.selected.arrayBuffer).toHaveBeenCalledOnce();
      expect(secondFile.selected.arrayBuffer).toHaveBeenCalledOnce();
    });
    act(() => clearRememberedAttachments("synthetic-connection"));
    await settleDelayedRead(() => {
      firstFile.resolve();
      secondFile.resolve();
    });
    first.unmount();
    second.unmount();

    const reopenedFirst = renderHook(() => usePendingAttachments(firstOptions));
    const reopenedSecond = renderHook(() => usePendingAttachments(secondOptions));
    expect(reopenedFirst.result.current.list).toEqual([]);
    expect(reopenedSecond.result.current.list).toEqual([]);
    expect(urls.createObjectURL).not.toHaveBeenCalled();
  });

  it("cancels an unfinished read on unmount without discarding completed rows", async () => {
    const urls = stubObjectUrls();
    const options = {
      harness: "codex",
      hasImage: true,
      rememberKey: "synthetic-connection\u0000navigated-task",
    };
    const first = renderHook(() => usePendingAttachments(options));
    act(() => first.result.current.addFiles([file(PNG, "complete.png")]));
    await waitFor(() => expect(first.result.current.list).toHaveLength(1));

    const delayed = delayedFile();
    act(() => first.result.current.addFiles([delayed.selected]));
    await waitFor(() => expect(delayed.selected.arrayBuffer).toHaveBeenCalledOnce());
    first.unmount();
    await settleDelayedRead(delayed.resolve);

    const reopened = renderHook(() => usePendingAttachments(options));
    expect(reopened.result.current.list.map((attachment) => attachment.name)).toEqual(["complete.png"]);
    expect(urls.createObjectURL).toHaveBeenCalledOnce();
  });
});
