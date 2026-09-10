import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS, type AdapterDef } from "../src/adapters";
import {
  ATTACHMENT_KIND_LIMITS,
  attachmentKind,
  decodeAttachments,
  formatAttachNote,
  formatBytes,
  looksLikeUtf8Text,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_BASE64_CHARS,
  MAX_TURN_ATTACHMENT_BYTES,
  promoteMessageAttachments,
  restoreMessageAttachments,
  sniffAttachmentType,
  sniffImageType,
  writeMessageAttachments,
  writeTurnAttachments,
  type DecodedAttachment,
} from "../src/attachments";
import { TASKS_DIR, type WispConfig } from "../src/config";
import { route } from "../src/daemon";
import { createTask, freeSlot, listTasks, newTaskId, setTaskFields, transition, turnsFor } from "../src/store";

/** Magic-byte heads; the sniffer reads prefixes only, so the tails are filler. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(312, 1)]); // 320 B, the spike's size
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(28, 2)]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(26, 3)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 0), Buffer.from("WEBP"), Buffer.alloc(20, 4)]);
const TEXT = Buffer.from("hello, not an image");
/** A1d fixtures: one head per non-image kind wisp stores, filler for the tails. */
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n", "ascii"), Buffer.alloc(64, 0x20)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "ascii"), Buffer.alloc(32, 5)]);
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  ", "ascii"), Buffer.alloc(32, 6)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(48, 7)]);
const CSV = Buffer.from("id,name\n1,café\n2,ok\n", "utf8");
/** Bytes no signature claims and the text scan refuses: the unsupported case. */
const BINARY = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);

const b64 = (data: Buffer): string => data.toString("base64");
const item = (name: string, data: Buffer): { name: string; dataBase64: string } => ({ name, dataBase64: b64(data) });

/** A bash harness WITH the argv-form image capability (consumed in work item 2). */
const imgBash: AdapterDef = {
  bin: "bash",
  exec: ["-c", "echo turn-ran"],
  image: ["-i", "{path}", "--"],
  parse: { format: "text" },
  attach: null,
};

/**
 * A harness with NO image mechanism at all. Every builtin has one since A1c
 * gave droid prompt-path delivery, so the capability guard has to be tested
 * against a def that declares none — which is what the guard actually reads.
 */
const blindBash: AdapterDef = {
  bin: "bash",
  exec: ["-c", "echo turn-ran"],
  parse: { format: "text" },
  attach: null,
};

const cfg: WispConfig = {
  instanceId: "123e4567-e89b-42d3-a456-426614174000",
  port: 0,
  host: "127.0.0.1",
  token: "test",
  webhooks: [],
  repos: [],
  stuckMinutes: 10,
  logMaxBytes: 5_000_000,
  setupTimeoutMinutes: 10,
  envAllowlist: {},
  harnessDefaults: {},
};

describe("sniffImageType", () => {
  test("png/jpeg/gif/webp magic bytes are recognized", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });

  test("anything else is null — the pasted mime is never consulted", () => {
    expect(sniffImageType(TEXT)).toBeNull();
    expect(sniffImageType(Buffer.from("GIF79a"))).toBeNull(); // near-miss
    expect(sniffImageType(Buffer.from("RIFF....AVI "))).toBeNull(); // RIFF but not WEBP
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe("sniffAttachmentType (A1d)", () => {
  test("each kind is recognized by its own evidence, images first", () => {
    expect(sniffAttachmentType(PNG)).toBe("image/png");
    expect(sniffAttachmentType(PDF)).toBe("application/pdf");
    expect(sniffAttachmentType(MP4)).toBe("video/mp4");
    expect(sniffAttachmentType(MOV)).toBe("video/quicktime"); // the brand, not the box
    expect(sniffAttachmentType(WEBM)).toBe("video/webm");
    expect(sniffAttachmentType(CSV)).toBe("text/plain");
  });

  test("text is the LAST rule, and it is a scan rather than a prefix test", () => {
    expect(sniffAttachmentType(BINARY)).toBeNull(); // a NUL is not text
    expect(sniffAttachmentType(Buffer.alloc(0))).toBeNull();
    // a truncated multi-byte character fails on a whole file and passes on a
    // window: that ordering is what lets promotion re-sniff 4 KiB of a 50 MB file
    const splitChar = Buffer.from("café", "utf8").subarray(0, 4);
    expect(looksLikeUtf8Text(splitChar)).toBe(false);
    expect(looksLikeUtf8Text(splitChar, true)).toBe(true);
    expect(looksLikeUtf8Text(Buffer.from([0xed, 0xa0, 0x80]))).toBe(false); // surrogate half
    expect(looksLikeUtf8Text(Buffer.from([0xc0, 0x80]))).toBe(false); // overlong NUL
    expect(looksLikeUtf8Text(Buffer.from("log\u001b[31mred\u001b[0m\n"))).toBe(true); // ANSI logs are text
  });

  test("kinds carry the caps, and the turn budget is the old worst case", () => {
    expect(attachmentKind("image/png")).toBe("image");
    expect(attachmentKind("application/pdf")).toBe("pdf");
    expect(attachmentKind("text/plain")).toBe("text");
    expect(attachmentKind("video/quicktime")).toBe("video");
    expect(MAX_TURN_ATTACHMENT_BYTES).toBe(MAX_ATTACHMENTS_PER_TURN * ATTACHMENT_KIND_LIMITS.image);
  });
});

describe("formatBytes", () => {
  test("the attach note's wording: 320 B, 12 KB, 1.2 MB", () => {
    expect(formatBytes(320)).toBe("320 B");
    expect(formatBytes(12 * 1024)).toBe("12 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1_258_291)).toBe("1.2 MB");
  });
});

describe("decodeAttachments", () => {
  // a capable def (argv form) — the builtins gain their fields in work item 2
  const codex = imgBash;

  test("absent/null/empty is no attachments", () => {
    expect(decodeAttachments("droid", BUILTIN_ADAPTERS.droid!, undefined)).toEqual([]);
    expect(decodeAttachments("droid", BUILTIN_ADAPTERS.droid!, null)).toEqual([]);
    // even a harness without capability accepts an explicitly empty list (nothing to reject)
    expect(decodeAttachments("droid", BUILTIN_ADAPTERS.droid!, [])).toEqual([]);
  });

  test("the field must be an array", () => {
    expect(() => decodeAttachments("codex", codex, "x")).toThrow(
      "attachments must be an array of {name, dataBase64}, got string",
    );
  });

  test("a harness without image capability is rejected with a named reason", () => {
    expect(() => decodeAttachments("blind", blindBash, [item("red.png", PNG)])).toThrow(
      "harness 'blind' has no image-attachment capability (its adapter declares no image/imageInput/imageDelivery field)",
    );
  });

  test("droid's prompt-path delivery IS a capability, and it accepts png/jpeg only (A1c)", () => {
    const droid = BUILTIN_ADAPTERS.droid!;
    expect(droid.imageDelivery).toBe("read-tool-path");
    expect(decodeAttachments("droid", droid, [item("red.png", PNG)])).toHaveLength(1);
    expect(decodeAttachments("droid", droid, [item("shot.jpg", JPEG)])).toHaveLength(1);
    // droid's Read tool throws on gif/webp, so the boundary refuses them BY NAME
    // instead of handing over a file that breaks mid-turn
    for (const [name, bytes, type] of [
      ["anim.gif", GIF, "image/gif"],
      ["pic.webp", WEBP, "image/webp"],
    ] as const) {
      expect(() => decodeAttachments("droid", droid, [item(name, bytes)])).toThrow(
        `attachments[0] (${name}): harness 'droid' reads images from a path with its own file tool, which accepts only png and jpeg — this is ${type}`,
      );
    }
  });

  test(`more than ${MAX_ATTACHMENTS_PER_TURN} files is a named rejection`, () => {
    const many = Array.from({ length: MAX_ATTACHMENTS_PER_TURN + 1 }, (_, i) => item(`f${i}.png`, PNG));
    expect(() => decodeAttachments("codex", codex, many)).toThrow(
      `at most ${MAX_ATTACHMENTS_PER_TURN} attachments per turn, got ${MAX_ATTACHMENTS_PER_TURN + 1}`,
    );
  });

  test("item shape is checked with a named index", () => {
    expect(() => decodeAttachments("codex", codex, ["nope"])).toThrow(
      "attachments[0] must be an object with name and dataBase64, got string",
    );
    expect(() => decodeAttachments("codex", codex, [{ dataBase64: b64(PNG) }])).toThrow(
      "attachments[0].name must be a non-empty string, got undefined",
    );
    expect(() => decodeAttachments("codex", codex, [{ name: "", dataBase64: b64(PNG) }])).toThrow(
      'attachments[0].name must be a non-empty string, got ""',
    );
    expect(() => decodeAttachments("codex", codex, [{ name: "a.png", dataBase64: 42 }])).toThrow(
      "attachments[0] (a.png): dataBase64 must be a string, got number",
    );
    expect(() => decodeAttachments("codex", codex, [{ name: "a.png", dataBase64: "not!base64!" }])).toThrow(
      "attachments[0] (a.png): dataBase64 is not valid base64",
    );
    expect(() => decodeAttachments("codex", codex, [{ name: "a.png", dataBase64: "" }])).toThrow(
      "attachments[0] (a.png): empty file",
    );
  });

  test("the cap that applies is the KIND's, named with the formatted size", () => {
    // 5MB+1 byte of png: small enough that the base64-length guard passes
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1 - PNG.length, 7)]);
    expect(() => decodeAttachments("codex", codex, [item("big.png", big)])).toThrow(
      "attachments[0] (big.png): 5.0 MB exceeds the 5 MB limit for image attachments",
    );
    // …and the same bytes as text would be fine: 20 MB is the text cap
    const bigText = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
    expect(decodeAttachments("codex", codex, [item("big.csv", bigText)])).toHaveLength(1);
    const hugeText = Buffer.alloc(ATTACHMENT_KIND_LIMITS.text + 1, 0x61);
    expect(() => decodeAttachments("codex", codex, [item("huge.csv", hugeText)])).toThrow(
      "attachments[0] (huge.csv): 20.0 MB exceeds the 20 MB limit for text attachments",
    );
  });

  test("an oversize base64 string is rejected before decoding", () => {
    const hugeB64 = "A".repeat(MAX_BASE64_CHARS + (4 - (MAX_BASE64_CHARS % 4)));
    expect(() => decodeAttachments("codex", codex, [{ name: "huge.mp4", dataBase64: hugeB64 }])).toThrow(
      "attachments[0] (huge.mp4): over the 50 MB per-file limit",
    );
  });

  test("the turn's TOTAL budget is what bounds a request, not the per-file cap", () => {
    // four 15 MB texts: each one is legal, together they are over the 50 MB turn
    const chunk = Buffer.alloc(15 * 1024 * 1024, 0x61);
    const four = Array.from({ length: 4 }, (_, i) => item(`part${i}.csv`, chunk));
    expect(() => decodeAttachments("codex", codex, four)).toThrow(
      "attachments total 60 MB, over the 50 MB limit for one turn",
    );
    expect(decodeAttachments("codex", codex, four.slice(0, 3))).toHaveLength(3);
  });

  test("bytes that sniff as nothing wisp stores are rejected even with a .png name", () => {
    expect(() => decodeAttachments("codex", codex, [item("fake.png", BINARY)])).toThrow(
      "attachments[0] (fake.png): not a supported attachment (magic-byte sniff) — wisp takes png/jpeg/gif/webp images, pdf, utf-8 text, and mp4/mov/webm video",
    );
  });

  test("A1d: pdf, text and video need NO adapter capability — they travel by path", () => {
    const out = decodeAttachments("blind", blindBash, [
      item("spec.pdf", PDF),
      item("orders.csv", CSV),
      item("clip.mp4", MP4),
    ]);
    expect(out.map((a) => a.mediaType)).toEqual(["application/pdf", "text/plain", "video/mp4"]);
    // the image half of the same harness is still refused, by the same rule as before
    expect(() => decodeAttachments("blind", blindBash, [item("red.png", PNG)])).toThrow(
      "harness 'blind' has no image-attachment capability",
    );
  });

  test("a delivery harness's narrow image reader does not narrow its other kinds", () => {
    const droid = BUILTIN_ADAPTERS.droid!;
    // gif is refused (its Read tool throws on one) — a webm is not an image at all
    expect(() => decodeAttachments("droid", droid, [item("anim.gif", GIF)])).toThrow("accepts only png and jpeg");
    expect(decodeAttachments("droid", droid, [item("clip.webm", WEBM)])).toHaveLength(1);
  });

  test("happy path: decoded bytes, sniffed mediaType, original name", () => {
    const out = decodeAttachments("codex", codex, [item("red.png", PNG), item("shot.jpg", JPEG)]);
    expect(out.map((a) => [a.name, a.mediaType, a.data.length])).toEqual([
      ["red.png", "image/png", 320],
      ["shot.jpg", "image/jpeg", 32],
    ]);
  });
});

describe("writeTurnAttachments", () => {
  const decoded = (name: string, data: Buffer = PNG): DecodedAttachment => ({
    name,
    mediaType: sniffImageType(data) ?? "image/png",
    data,
  });

  test("files land under tasks/<id>/attachments/turn-<n>/ with sizes and media types", () => {
    const stored = writeTurnAttachments("twritetest1", 3, [decoded("red.png"), decoded("shot.jpg", JPEG)]);
    expect(stored.map((s) => s.name)).toEqual(["red.png", "shot.jpg"]);
    for (const s of stored) {
      expect(s.path).toBe(join(TASKS_DIR, "twritetest1", "attachments", "turn-3", s.name));
      expect(readFileSync(s.path)).toEqual(s.name === "red.png" ? PNG : JPEG);
      expect(s.size).toBe(s.name === "red.png" ? 320 : 32);
    }
    expect(stored[0]!.mediaType).toBe("image/png");
    expect(stored[1]!.mediaType).toBe("image/jpeg");
  });

  test("names are sanitized: traversal dies at basename, unsafe chars become _, dot-only falls back", () => {
    const stored = writeTurnAttachments("twritetest2", 1, [
      decoded("../../etc/evil script.png"),
      decoded(".."),
      decoded(""),
    ]);
    expect(stored[0]!.name).toBe("evil_script.png");
    expect(stored[1]!.name).toBe("image");
    expect(stored[2]!.name).toBe("image-2"); // collision with the sanitized "image"
    for (const s of stored) expect(s.path.startsWith(join(TASKS_DIR, "twritetest2", "attachments", "turn-1"))).toBe(true);
  });

  test("collisions suffix case-insensitively within a batch and against existing files", () => {
    const stored = writeTurnAttachments("twritetest3", 1, [decoded("a.png"), decoded("a.png"), decoded("A.PNG")]);
    expect(stored.map((s) => s.name)).toEqual(["a.png", "a-2.png", "A-3.PNG"]); // case-insensitive fs safety
    // a later turn never overwrites an earlier turn's file (different dir), but a
    // retried write into the SAME turn dir suffixes instead of clobbering
    const again = writeTurnAttachments("twritetest3", 1, [decoded("a.png")]);
    expect(again[0]!.name).toBe("a-4.png");
  });
});

describe("message attachment promotion", () => {
  const decoded = (): DecodedAttachment => ({ name: "red.png", mediaType: "image/png", data: PNG });

  test("an existing turn directory is never trusted over staged message bytes", () => {
    const taskId = `tpremote${Date.now()}`;
    writeMessageAttachments(taskId, "message-1", [decoded()]);
    const stale = join(TASKS_DIR, taskId, "attachments", "turn-1");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "red.png"), JPEG);
    expect(() =>
      promoteMessageAttachments(taskId, "message-1", 1, [
        { name: "red.png", size: PNG.length, mediaType: "image/png" },
      ]),
    ).toThrow("refusing to replace existing attachment directory for turn 1");
  });

  test("a crash after rename can revalidate the promotion or restore it for retry", () => {
    const taskId = `tprecover${Date.now()}`;
    const stored = writeMessageAttachments(taskId, "message-2", [decoded()]);
    const records = stored.map(({ name, size, mediaType }) => ({ name, size, mediaType }));
    const promoted = promoteMessageAttachments(taskId, "message-2", 2, records);
    expect(readFileSync(promoted[0]!.path)).toEqual(PNG);

    // The staged source is gone, so a second promotion is startup recovery,
    // not permission to accept arbitrary stale bytes.
    expect(promoteMessageAttachments(taskId, "message-2", 2, records)).toEqual(promoted);
    restoreMessageAttachments(taskId, "message-2", 2);
    expect(existsSync(stored[0]!.path)).toBe(true);
  });

  test("A1d: a promoted text file revalidates from its leading window", () => {
    const taskId = `ttext${Date.now()}`;
    const stored = writeMessageAttachments(taskId, "message-4", [
      { name: "orders.csv", mediaType: "text/plain", data: CSV },
    ]);
    const records = stored.map(({ name, size, mediaType }) => ({ name, size, mediaType }));
    const promoted = promoteMessageAttachments(taskId, "message-4", 4, records);
    expect(readFileSync(promoted[0]!.path)).toEqual(CSV);
  });

  test("recovery rejects a symlink even when its target bytes match the manifest", () => {
    const taskId = `tsymlink${Date.now()}`;
    const stored = writeMessageAttachments(taskId, "message-3", [decoded()]);
    const records = stored.map(({ name, size, mediaType }) => ({ name, size, mediaType }));
    const [promoted] = promoteMessageAttachments(taskId, "message-3", 3, records);
    const target = join(TASKS_DIR, taskId, "matching-target.png");
    writeFileSync(target, PNG);
    unlinkSync(promoted!.path);
    symlinkSync(target, promoted!.path);

    expect(() => promoteMessageAttachments(taskId, "message-3", 3, records)).toThrow(
      `attachment does not match the persisted manifest: ${promoted!.path}`,
    );
  });
});

describe("formatAttachNote", () => {
  test("one honest line: · attached: red.png (320 B), shot2.jpg (1.2 MB)", () => {
    const note = formatAttachNote([
      { name: "red.png", path: "/x/red.png", size: 320, mediaType: "image/png" },
      { name: "shot2.jpg", path: "/x/shot2.jpg", size: 1_258_291, mediaType: "image/jpeg" },
    ]);
    expect(note).toBe("· attached: red.png (320 B), shot2.jpg (1.2 MB)");
  });
});

/** POST helper hitting route() directly (the web.test.ts pattern). */
function call(cfg_: WispConfig, adapters: Record<string, AdapterDef>, path: string, body: unknown): Promise<Response> {
  const url = new URL(`http://wisp.test${path}`);
  return Promise.resolve(
    route(
      new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      url,
      url.pathname,
      cfg_,
      adapters,
    ),
  );
}

/** GET helper hitting route() directly. */
function get(cfg_: WispConfig, adapters: Record<string, AdapterDef>, path: string): Promise<Response> {
  const url = new URL(`http://wisp.test${path}`);
  return Promise.resolve(route(new Request(url), url, url.pathname, cfg_, adapters));
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

describe("POST /api/tasks attachments (S3)", () => {
  test("a rejected create names its reason and leaves NO task row behind", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-att-repo-"));
    const before = listTasks(true).length;

    const blindRes = await call(cfg, { blind: blindBash }, "/api/tasks", {
      repoPath: repo,
      prompt: "with an image",
      harness: "blind",
      attachments: [item("red.png", PNG)],
    });
    expect(blindRes.status).toBe(400);
    expect(await errorOf(blindRes)).toBe(
      "harness 'blind' has no image-attachment capability (its adapter declares no image/imageInput/imageDelivery field)",
    );

    // droid HAS capability now, but only for png/jpeg — the refusal is the format's
    const gifRes = await call(cfg, BUILTIN_ADAPTERS, "/api/tasks", {
      repoPath: repo,
      prompt: "with a gif",
      harness: "droid",
      attachments: [item("anim.gif", GIF)],
    });
    expect(gifRes.status).toBe(400);
    expect(await errorOf(gifRes)).toContain("accepts only png and jpeg — this is image/gif");

    const typeRes = await call(cfg, { imgbash: imgBash }, "/api/tasks", {
      repoPath: repo,
      prompt: "not a file wisp stores",
      harness: "imgbash",
      attachments: [item("notes.bin", BINARY)],
    });
    expect(typeRes.status).toBe(400);
    expect(await errorOf(typeRes)).toContain("not a supported attachment (magic-byte sniff)");

    expect(listTasks(true).length).toBe(before); // validation runs before createTask
  });

  test("attachments: [] on a harness without capability is a no-op, not a rejection", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-att-repo-"));
    const res = await call(cfg, BUILTIN_ADAPTERS, "/api/tasks", {
      repoPath: repo,
      prompt: "no files",
      harness: "droid",
      attachments: [],
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /api/tasks/:id/send attachments (S3)", () => {
  /** A done task with a real worktree dir, ready for a send. */
  function readyTask(): string {
    const task = createTask({
      id: newTaskId(),
      title: "attach probe",
      repo_path: "/tmp/repo",
      harness: "imgbash",
      model: null,
      slot: freeSlot(),
    });
    setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-att-wt-")) });
    transition(task.id, "done", "setup done");
    return task.id;
  }
  const adapters = { imgbash: imgBash };

  async function untilSettled(taskId: string, ms = 8000): Promise<void> {
    const deadline = Date.now() + ms;
    for (;;) {
      const t = turnsFor(taskId).at(-1);
      if (t && t.status !== "running") return;
      if (Date.now() > deadline) throw new Error("turn never settled");
      await Bun.sleep(50);
    }
  }

  test("happy path: files stored under turn-<n>, the note is the log's first line", async () => {
    const id = readyTask();
    const res = await call(cfg, adapters, `/api/tasks/${id}/send`, {
      message: "what color?",
      attachments: [item("red.png", PNG), item("shot.jpg", JPEG)],
    });
    expect(res.status).toBe(200);
    await untilSettled(id);

    const dir = join(TASKS_DIR, id, "attachments", "turn-1");
    expect(readFileSync(join(dir, "red.png"))).toEqual(PNG);
    expect(existsSync(join(dir, "shot.jpg"))).toBe(true);

    const turn = turnsFor(id)[0]!;
    expect(turn.status).toBe("done");
    const log = readFileSync(turn.log_file, "utf8");
    // the attach note lands BEFORE any harness output — the stream's honest line
    expect(log.split("\n")[0]).toBe("· attached: red.png (320 B), shot.jpg (32 B)");
    expect(log).toContain("turn-ran");
  });

  test("A1c: a delivery harness gets the stored PATH in its prompt, and argv is untouched", async () => {
    // this harness echoes its prompt positional back, so the log IS the prompt
    const pathBash: AdapterDef = {
      bin: "bash",
      exec: ["-c", 'printf "%s" "$0"'],
      imageDelivery: "read-tool-path",
      parse: { format: "text" },
      attach: null,
    };
    const task = createTask({
      id: newTaskId(),
      title: "path delivery",
      repo_path: "/tmp/repo",
      harness: "pathbash",
      model: null,
      slot: freeSlot(),
    });
    setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-att-wt-")) });
    transition(task.id, "done", "setup done");
    const res = await call(cfg, { pathbash: pathBash }, `/api/tasks/${task.id}/send`, {
      message: "what color?",
      attachments: [item("red.png", PNG)],
    });
    expect(res.status).toBe(200);
    await untilSettled(task.id);

    const stored = join(TASKS_DIR, task.id, "attachments", "turn-1", "red.png");
    const log = readFileSync(turnsFor(task.id)[0]!.log_file, "utf8");
    // the bytes stay where every other attachment lives — nothing is copied
    // into the worktree, where it would show up in the task's own diff
    expect(log).toContain(stored);
    expect(log).toContain("Read it with your file-reading tool before answering:");
    // the load-bearing half: an unread file is a wrong answer, so the prompt
    // asks for a plain "I cannot see it" rather than a guess
    expect(log).toContain("If you cannot see the image, say so plainly");
    // the user's own message still ends the prompt
    expect(log.trimEnd().endsWith("what color?")).toBe(true);
    // and nothing went on argv: the echoed prompt is the whole harness input
    expect(log).not.toContain("-i ");
  });

  test("A1d: a non-image rides the prompt while the image rides argv", async () => {
    // this harness dumps every argv element, so the log shows BOTH channels
    const mixedBash: AdapterDef = {
      bin: "bash",
      exec: ["-c", 'printf "%s\\n" "$0" "$@"'],
      image: ["-i", "{path}", "--"],
      parse: { format: "text" },
      attach: null,
    };
    const task = createTask({
      id: newTaskId(),
      title: "mixed delivery",
      repo_path: "/tmp/repo",
      harness: "mixedbash",
      model: null,
      slot: freeSlot(),
    });
    setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-att-wt-")) });
    transition(task.id, "done", "setup done");
    const res = await call(cfg, { mixedbash: mixedBash }, `/api/tasks/${task.id}/send`, {
      message: "reconcile these",
      attachments: [item("red.png", PNG), item("orders.csv", CSV)],
    });
    expect(res.status).toBe(200);
    await untilSettled(task.id);

    const dir = join(TASKS_DIR, task.id, "attachments", "turn-1");
    const log = readFileSync(turnsFor(task.id)[0]!.log_file, "utf8");
    // the csv is named in the prompt, with the type and size the harness needs
    // to pick a tool, and the png is NOT — it went to the model through -i
    expect(log).toContain("A file is attached to this message on disk.");
    expect(log).toContain(`${join(dir, "orders.csv")} (text/plain,`);
    expect(log).not.toContain("(image/png,");
    // …and argv carried the image, exactly where the template puts it
    expect(log).toContain("-i\n");
    expect(log).toContain(join(dir, "red.png"));
  });

  test("A1d: an attached video says plainly that nobody can watch it", async () => {
    const pathBash: AdapterDef = {
      bin: "bash",
      exec: ["-c", 'printf "%s" "$0"'],
      parse: { format: "text" },
      attach: null,
    };
    const task = createTask({
      id: newTaskId(),
      title: "video delivery",
      repo_path: "/tmp/repo",
      harness: "videobash",
      model: null,
      slot: freeSlot(),
    });
    setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-att-wt-")) });
    transition(task.id, "done", "setup done");
    // no image capability at all, and a video still gets through: path delivery
    // is a fact about the prompt rather than a channel the CLI has to declare
    const res = await call(cfg, { videobash: pathBash }, `/api/tasks/${task.id}/send`, {
      message: "what happens at the end?",
      attachments: [item("clip.mp4", MP4)],
    });
    expect(res.status).toBe(200);
    await untilSettled(task.id);

    const log = readFileSync(turnsFor(task.id)[0]!.log_file, "utf8");
    expect(log).toContain(join(TASKS_DIR, task.id, "attachments", "turn-1", "clip.mp4"));
    expect(log).toContain("You cannot watch a video directly");
    expect(log).toContain("ffmpeg/ffprobe");
    expect(log.trimEnd().endsWith("what happens at the end?")).toBe(true);
  });

  test("validation failures are named 400s and spawn no turn", async () => {
    const id = readyTask();
    const cases: [unknown, string][] = [
      [
        [item("red.png", PNG), item("red.png", BINARY)],
        "attachments[1] (red.png): not a supported attachment (magic-byte sniff) — wisp takes png/jpeg/gif/webp images, pdf, utf-8 text, and mp4/mov/webm video",
      ],
      ["oops", "attachments must be an array of {name, dataBase64}, got string"],
    ];
    for (const [attachments, want] of cases) {
      const res = await call(cfg, adapters, `/api/tasks/${id}/send`, { message: "go", attachments });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe(want);
    }
    expect(turnsFor(id)).toEqual([]);
    // nothing was written to disk either
    expect(existsSync(join(TASKS_DIR, id))).toBe(false);
  });

  test("a harness without capability gets the named 400 on send too", async () => {
    const task = createTask({
      id: newTaskId(),
      title: "blind send",
      repo_path: "/tmp/repo",
      harness: "blind",
      model: null,
      slot: freeSlot(),
    });
    setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-att-wt-")) });
    transition(task.id, "done", "setup done");
    const res = await call(cfg, { blind: blindBash }, `/api/tasks/${task.id}/send`, {
      message: "go",
      attachments: [item("red.png", PNG)],
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain("harness 'blind' has no image-attachment capability");
  });

  test("a plain send (no attachments) writes no note and no files", async () => {
    const id = readyTask();
    const res = await call(cfg, adapters, `/api/tasks/${id}/send`, { message: "just text" });
    expect(res.status).toBe(200);
    await untilSettled(id);
    const log = readFileSync(turnsFor(id)[0]!.log_file, "utf8");
    expect(log).not.toContain("· attached:");
    expect(existsSync(join(TASKS_DIR, id))).toBe(false);
    // A1a: no manifest either — NULL, not "[]", so a turn cannot claim a
    // feature it never used
    expect(turnsFor(id)[0]!.attachments_json).toBeNull();
  });

  test("the manifest lands on the turn row and is served parsed, never raw", async () => {
    const id = readyTask();
    await call(cfg, adapters, `/api/tasks/${id}/send`, {
      message: "look",
      attachments: [item("red.png", PNG), item("shot.jpg", JPEG)],
    });
    await untilSettled(id);

    expect(JSON.parse(turnsFor(id)[0]!.attachments_json!)).toEqual([
      { name: "red.png", size: 320, mediaType: "image/png" },
      { name: "shot.jpg", size: 32, mediaType: "image/jpeg" },
    ]);

    const detail = await get(cfg, adapters, `/api/tasks/${id}`);
    const body = (await detail.json()) as { turns: Record<string, unknown>[] };
    expect(body.turns[0]!.attachments).toEqual([
      { name: "red.png", size: 320, mediaType: "image/png" },
      { name: "shot.jpg", size: 32, mediaType: "image/jpeg" },
    ]);
    expect(body.turns[0]).not.toHaveProperty("attachments_json");
  });
});

describe("GET /api/tasks/:id/attachments/:turn/:name (A1a)", () => {
  const adapters = { imgbash: imgBash };

  /** A task with one settled turn carrying red.png + shot.jpg. */
  async function taskWithImages(): Promise<string> {
    const task = createTask({
      id: newTaskId(),
      title: "bytes route",
      repo_path: "/tmp/repo",
      harness: "imgbash",
      model: null,
      slot: freeSlot(),
    });
    setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-att-wt-")) });
    transition(task.id, "done", "setup done");
    await call(cfg, adapters, `/api/tasks/${task.id}/send`, {
      message: "look",
      attachments: [item("red.png", PNG), item("shot.jpg", JPEG)],
    });
    for (const deadline = Date.now() + 8000; ; ) {
      const t = turnsFor(task.id).at(-1);
      if (t && t.status !== "running") break;
      if (Date.now() > deadline) throw new Error("turn never settled");
      await Bun.sleep(50);
    }
    return task.id;
  }

  /**
   * SEC-08: these bytes are deleted on archive or cancel, so the browser must
   * not be told it may keep serving them for a year. The old header was
   * `immutable, max-age=31536000`, which outlived the deletion it was supposed
   * to respect.
   */
  test("serves the bytes with the SNIFFED type and no browser-side storage", async () => {
    const id = await taskWithImages();
    const res = await get(cfg, adapters, `/api/tasks/${id}/attachments/1/red.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(PNG));
  });

  test("the media type comes from the bytes, not the name — a .png holding JPEG serves image/jpeg", async () => {
    const id = await taskWithImages();
    // shot.jpg is JPEG bytes; ask for it and the response must not echo a guess
    const res = await get(cfg, adapters, `/api/tasks/${id}/attachments/1/shot.jpg`);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  test("a name that is not in the turn's manifest is a named 404, and traversal cannot be expressed", async () => {
    const id = await taskWithImages();
    for (const name of ["ghost.png", "..%2F..%2Fconfig.json", "%2Fetc%2Fpasswd"]) {
      const res = await get(cfg, adapters, `/api/tasks/${id}/attachments/1/${name}`);
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toContain("has no attachment named");
    }
  });

  test("a turn that does not exist, and a task that does not exist, are named 404s", async () => {
    const id = await taskWithImages();
    expect((await get(cfg, adapters, `/api/tasks/${id}/attachments/9/red.png`)).status).toBe(404);
    expect((await get(cfg, adapters, `/api/tasks/tnope9/attachments/1/red.png`)).status).toBe(404);
  });

  test("A1d: a text attachment serves as text, and never inline", async () => {
    const task = createTask({
      id: newTaskId(),
      title: "text bytes",
      repo_path: "/tmp/repo",
      harness: "imgbash",
      model: null,
      slot: freeSlot(),
    });
    setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-att-wt-")) });
    transition(task.id, "done", "setup done");
    await call(cfg, adapters, `/api/tasks/${task.id}/send`, {
      message: "read this",
      attachments: [item("orders.csv", CSV), item("clip.mp4", MP4)],
    });
    for (const deadline = Date.now() + 8000; ; ) {
      const t = turnsFor(task.id).at(-1);
      if (t && t.status !== "running") break;
      if (Date.now() > deadline) throw new Error("turn never settled");
      await Bun.sleep(50);
    }

    const csv = await get(cfg, adapters, `/api/tasks/${task.id}/attachments/1/orders.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    // pasted content must never render on the daemon's own origin
    expect(csv.headers.get("content-disposition")).toBe('attachment; filename="orders.csv"');
    expect(await csv.text()).toBe(CSV.toString("utf8"));

    const video = await get(cfg, adapters, `/api/tasks/${task.id}/attachments/1/clip.mp4`);
    expect(video.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await video.arrayBuffer())).toEqual(new Uint8Array(MP4));
  });

  test("archiving keeps image bytes and manifests available", async () => {
    const id = await taskWithImages();
    const archived = await call(cfg, adapters, `/api/tasks/${id}/archive`, {});
    expect(archived.status).toBe(200);
    expect(JSON.parse(turnsFor(id)[0]!.attachments_json!)).toHaveLength(2);
    const res = await get(cfg, adapters, `/api/tasks/${id}/attachments/1/red.png`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(PNG));
  });
});
