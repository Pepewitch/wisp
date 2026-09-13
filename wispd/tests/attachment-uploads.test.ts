import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_ADAPTERS } from "../src/adapters";
import {
  ATTACHMENT_UPLOAD_TTL_MS,
  discardAttachmentUpload,
  MAX_STAGED_ATTACHMENT_COUNT,
  resetAttachmentUploads,
  stageAttachmentUpload,
  sweepAttachmentUploads,
} from "../src/attachment-uploads";
import {
  AttachError,
  decodeAttachments,
  releaseDecodedAttachments,
  taskMessageAttachmentsFingerprint,
  taskMessageAttachmentsFingerprintForSubmission,
  taskMessageAttachmentsFingerprintV2,
  writeTurnAttachments,
} from "../src/attachments";
import { loadConfig, TASKS_DIR, UPLOADS_DIR } from "../src/config";
import { route } from "../src/routes";
import {
  createTask,
  createTaskMessage,
  freeSlot,
  newTaskId,
} from "../src/store";
import { persistTaskSubmission } from "../src/task-submit";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(312, 7),
]);

function uploadRequest(bytes: BlobPart, name = "shot.png"): { request: Request; url: URL } {
  const url = new URL(`http://wisp.test/api/attachments?name=${encodeURIComponent(name)}`);
  return {
    request: new Request(url, { method: "POST", body: new Blob([bytes]) }),
    url,
  };
}

async function upload(bytes: BlobPart, name = "shot.png") {
  const { request, url } = uploadRequest(bytes, name);
  const response = await route(request, url, url.pathname, loadConfig(), BUILTIN_ADAPTERS);
  return {
    response,
    body: (await response.json()) as {
      uploadId?: string;
      name?: string;
      size?: number;
      mediaType?: string;
      contentHash?: string;
      error?: string;
    },
  };
}

beforeEach(() => resetAttachmentUploads());

afterEach(() => {
  resetAttachmentUploads();
});

describe("raw attachment upload", () => {
  test("keeps the persisted v1 fingerprint for attachment-free retries", () => {
    expect(taskMessageAttachmentsFingerprint([])).toBe(
      "b6c95ec4e10a4cf17ea5c8c1554cad232d84c8c61bef9de76df31dd5e2f2b684",
    );
  });

  test("stages mode-0600 bytes, returns their digest, and promotes without a memory copy", async () => {
    const { response, body } = await upload(PNG);
    expect(response.status).toBe(201);
    expect(body).toEqual({
      uploadId: expect.any(String),
      name: "shot.png",
      size: PNG.length,
      mediaType: "image/png",
      contentHash: createHash("sha256").update(PNG).digest("hex"),
    });
    const stagedPath = join(UPLOADS_DIR, body.uploadId!);
    expect(statSync(stagedPath).mode & 0o777).toBe(0o600);

    const decoded = decodeAttachments("droid", BUILTIN_ADAPTERS.droid!, [
      { name: "shot.png", uploadId: body.uploadId },
    ]);
    expect(decoded).toHaveLength(1);
    expect("data" in decoded[0]!).toBe(false);
    const taskId = `upload${Date.now()}`;
    const stored = writeTurnAttachments(taskId, 1, decoded);
    expect(readFileSync(stored[0]!.path)).toEqual(PNG);
    expect(existsSync(stagedPath)).toBe(false);
    expect(() =>
      decodeAttachments("droid", BUILTIN_ADAPTERS.droid!, [
        { name: "shot.png", uploadId: body.uploadId },
      ]),
    ).toThrow("does not exist or expired");
    rmSync(join(TASKS_DIR, taskId), { recursive: true, force: true });
  });

  test("validates the whole text stream, not only its text-looking prefix", async () => {
    const bytes = Buffer.alloc(5000, 0x61);
    bytes[4999] = 0xff;
    const { response, body } = await upload(bytes, "notes.txt");
    expect(response.status).toBe(400);
    expect(body.error).toContain("not a supported attachment");
    expect(readdirSync(UPLOADS_DIR)).toEqual([]);
  });

  test("enforces the byte cap while reading and removes the partial file", async () => {
    const { request } = uploadRequest("four", "tiny.txt");
    await expect(stageAttachmentUpload(request, "tiny.txt", 3)).rejects.toMatchObject({ status: 413 });
    expect(readdirSync(UPLOADS_DIR)).toEqual([]);
  });

  test("yields to the event loop while a multi-megabyte body drains to disk", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 96; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const request = new Request("http://wisp.test/api/attachments?name=large.txt", {
      method: "POST",
      body,
    });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    const staged = await stageAttachmentUpload(request, "large.txt", 10 * 1024 * 1024);
    clearInterval(timer);
    expect(staged.size).toBe(6 * 1024 * 1024);
    expect(ticks).toBeGreaterThan(0);
    discardAttachmentUpload(staged.uploadId);
  });

  test("does not sweep an upload whose request body is still arriving", async () => {
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("still uploading"));
        finish = () => controller.close();
      },
    });
    const pending = stageAttachmentUpload(
      new Request("http://wisp.test/api/attachments?name=slow.txt", { method: "POST", body }),
      "slow.txt",
      1024,
    );
    for (let i = 0; i < 100 && readdirSync(UPLOADS_DIR).length === 0; i++) {
      await Bun.sleep(1);
    }
    const [path] = readdirSync(UPLOADS_DIR);
    expect(path).toBeDefined();
    sweepAttachmentUploads(Date.now() + ATTACHMENT_UPLOAD_TTL_MS + 1);
    expect(readdirSync(UPLOADS_DIR)).toEqual([path!]);
    finish();
    const staged = await pending;
    discardAttachmentUpload(staged.uploadId);
  });

  test("bounds tiny staged files by count as well as total bytes", async () => {
    for (let i = 0; i < MAX_STAGED_ATTACHMENT_COUNT; i++) {
      const { request } = uploadRequest("x", `tiny-${i}.txt`);
      await stageAttachmentUpload(request, `tiny-${i}.txt`, 1024);
    }
    const { request } = uploadRequest("x", "one-too-many.txt");
    await expect(
      stageAttachmentUpload(request, "one-too-many.txt", 1024),
    ).rejects.toMatchObject({ status: 429 });
  });

  test("a validation refusal releases every upload already claimed by the request", async () => {
    const { body } = await upload(PNG);
    expect(() =>
      decodeAttachments("blind", { argv: ["bash"] }, [
        { name: "shot.png", uploadId: body.uploadId },
      ]),
    ).toThrow(AttachError);
    expect(readdirSync(UPLOADS_DIR)).toEqual([]);
  });

  test("claimed references reject concurrent reuse, then release explicitly", async () => {
    const { body } = await upload(PNG);
    const decoded = decodeAttachments("droid", BUILTIN_ADAPTERS.droid!, [
      { name: "shot.png", uploadId: body.uploadId },
    ]);
    discardAttachmentUpload(body.uploadId!);
    expect(readdirSync(UPLOADS_DIR)).toHaveLength(1);
    expect(() =>
      decodeAttachments("droid", BUILTIN_ADAPTERS.droid!, [
        { name: "shot.png", uploadId: body.uploadId },
      ]),
    ).toThrow("already in use");
    releaseDecodedAttachments(decoded);
    expect(readdirSync(UPLOADS_DIR)).toEqual([]);
  });

  test("staged and legacy forms produce the same retry fingerprint", async () => {
    const { body } = await upload(PNG);
    const staged = decodeAttachments("droid", BUILTIN_ADAPTERS.droid!, [
      { name: "shot.png", uploadId: body.uploadId },
    ]);
    const inline = decodeAttachments("droid", BUILTIN_ADAPTERS.droid!, [
      { name: "shot.png", dataBase64: PNG.toString("base64") },
    ]);
    expect(await taskMessageAttachmentsFingerprintForSubmission(staged)).toBe(
      taskMessageAttachmentsFingerprint(inline),
    );
    expect(taskMessageAttachmentsFingerprintV2(staged)).toBe(
      taskMessageAttachmentsFingerprintV2(inline),
    );
    releaseDecodedAttachments(staged);
  });

  test("an upload retry matches a v1 message persisted before upgrade", async () => {
    const { body } = await upload(PNG);
    const staged = decodeAttachments("droid", BUILTIN_ADAPTERS.droid!, [
      { name: "shot.png", uploadId: body.uploadId },
    ]);
    const inline = decodeAttachments("droid", BUILTIN_ADAPTERS.droid!, [
      { name: "shot.png", dataBase64: PNG.toString("base64") },
    ]);
    const task = createTask({
      id: newTaskId(),
      title: "legacy retry",
      repo_path: "/tmp/repo",
      harness: "droid",
      model: null,
      slot: freeSlot(),
    });
    const messageId = `legacy-upload-${task.id}`;
    createTaskMessage({
      id: messageId,
      taskId: task.id,
      text: "same request",
      attachmentHash: taskMessageAttachmentsFingerprint(inline),
    }, false);

    const retried = await persistTaskSubmission(
      task,
      "same request",
      staged,
      messageId,
    );
    expect(retried.message.id).toBe(messageId);
    releaseDecodedAttachments(staged);
  });

  test("unclaimed references expire and their files are swept", async () => {
    const { body } = await upload(PNG);
    sweepAttachmentUploads(Date.now() + ATTACHMENT_UPLOAD_TTL_MS + 1);
    expect(readdirSync(UPLOADS_DIR)).toEqual([]);
    try {
      decodeAttachments("droid", BUILTIN_ADAPTERS.droid!, [
        { name: "shot.png", uploadId: body.uploadId },
      ]);
      throw new Error("expected decode to reject");
    } catch (error) {
      expect(error).toMatchObject({ status: 404 });
      expect(String(error)).toContain("does not exist or expired");
    }
  });

  test("the authenticated discard route eagerly removes an unused upload", async () => {
    const { body } = await upload(PNG);
    const url = new URL(`http://wisp.test/api/attachments/${body.uploadId}`);
    const response = await route(
      new Request(url, { method: "DELETE" }),
      url,
      url.pathname,
      loadConfig(),
      BUILTIN_ADAPTERS,
    );
    expect(response.status).toBe(200);
    expect(readdirSync(UPLOADS_DIR)).toEqual([]);
  });
});
