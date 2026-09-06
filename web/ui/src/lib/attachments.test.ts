import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachmentPayloads,
  clearRememberedAttachments,
  formatBytes,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  noImageReason,
  readAttachment,
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
  it("reads a png into a base64 payload with its sniffed media type", async () => {
    const r = await readAttachment(file(PNG));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attachment.name).toBe("shot.png");
    expect(r.attachment.mediaType).toBe("image/png");
    expect(r.attachment.bytes).toBe(PNG.byteLength);
    expect(new Uint8Array(atob(r.attachment.dataBase64).split("").map((c) => c.charCodeAt(0)))).toEqual(PNG);
  });

  it("names a nameless clipboard file 'pasted image'", async () => {
    const r = await readAttachment(file(PNG, ""));
    expect(r.ok && r.attachment.name === "pasted image").toBe(true);
  });

  it("rejects non-images, empty files, and oversize with named reasons", async () => {
    const notImage = await readAttachment(file(new TextEncoder().encode("plain text")));
    expect(notImage).toEqual({ ok: false, reason: "shot.png: not a png/jpeg/gif/webp image" });

    const empty = await readAttachment(file(new Uint8Array([])));
    expect(empty).toEqual({ ok: false, reason: "shot.png: empty file" });

    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    big.set(PNG); // it must SNIFF as png to reach the size branch
    const oversize = await readAttachment(file(big));
    expect(oversize.ok).toBe(false);
    if (!oversize.ok) expect(oversize.reason).toContain("exceeds the 5 MB per-file limit");
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
  it("strips rows down to the wire shape { name, dataBase64 }", () => {
    const list: PendingAttachment[] = [
      { id: "a1", name: "a.png", mediaType: "image/png", dataBase64: "QUJD", bytes: 3, url: "blob:x" },
    ];
    expect(attachmentPayloads(list)).toEqual([{ name: "a.png", dataBase64: "QUJD" }]);
  });

  it("the caps constants mirror the daemon's", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_ATTACHMENTS).toBe(10);
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
    expect(second.result.current.payloads()).toEqual([
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
    expect(reopened.result.current.payloads()).toBeUndefined();
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
