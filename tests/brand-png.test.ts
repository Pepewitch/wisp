import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { decodePng, samePng } from "../scripts/brand/png";

function chunk(type: string, body: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(Bun.hash.crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** An RGB PNG whose every scanline uses `filter` (0 none, 1 sub, 2 up). */
function encode(width: number, height: number, pixels: Buffer, filter: 0 | 1 | 2, level: number, extra: Buffer[] = []): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const value = pixels[y * stride + x]!;
      const predicted = filter === 1 ? (x >= 3 ? pixels[y * stride + x - 3]! : 0) : filter === 2 ? (y > 0 ? pixels[(y - 1) * stride + x]! : 0) : 0;
      raw[y * (stride + 1) + 1 + x] = (value - predicted) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    ...extra,
    chunk("IDAT", deflateSync(raw, { level })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const WIDTH = 7;
const HEIGHT = 5;
const PIXELS = Buffer.from(Array.from({ length: WIDTH * HEIGHT * 3 }, (_, index) => (index * 37) % 256));

describe("samePng", () => {
  test("the same pixels compressed and filtered differently are the same image", () => {
    const a = encode(WIDTH, HEIGHT, PIXELS, 0, 9);
    const b = encode(WIDTH, HEIGHT, PIXELS, 1, 1);
    const c = encode(WIDTH, HEIGHT, PIXELS, 2, 6);
    expect(a.equals(b)).toBe(false);
    expect(samePng(a, b)).toBe(true);
    expect(samePng(a, c)).toBe(true);
    expect(decodePng(b)!.pixels.equals(PIXELS)).toBe(true);
  });

  test("one changed pixel is a different image", () => {
    const changed = Buffer.from(PIXELS);
    changed[20] = (changed[20]! + 1) & 0xff;
    expect(samePng(encode(WIDTH, HEIGHT, PIXELS, 0, 9), encode(WIDTH, HEIGHT, changed, 0, 9))).toBe(false);
  });

  test("a chunk that changes how the pixels display is a different image", () => {
    const gamma = chunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f]));
    expect(samePng(encode(WIDTH, HEIGHT, PIXELS, 0, 9), encode(WIDTH, HEIGHT, PIXELS, 0, 9, [gamma]))).toBe(false);
  });

  test("a committed icon re-encoded with other filters is the same image", () => {
    const committed = readFileSync(join(import.meta.dir, "../brand/pwa-icon-192.png"));
    const image = decodePng(committed);
    expect(image).not.toBeNull();
    expect(samePng(committed, encode(192, 192, image!.pixels, 0, 1))).toBe(true);
  });

  test("anything but an 8-bit, non-interlaced PNG only matches byte for byte", () => {
    expect(decodePng(Buffer.from("not a png"))).toBeNull();
    expect(samePng(Buffer.from("same"), Buffer.from("same"))).toBe(true);
    expect(samePng(Buffer.from("one"), Buffer.from("two"))).toBe(false);
  });
});
