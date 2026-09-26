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

type Filter = 0 | 1 | 2 | 3 | 4;

/** The PNG spec's predictor from the byte to the left (a), above (b), and above-left (c). */
function predict(filter: Filter, a: number, b: number, c: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return a;
    case 2:
      return b;
    case 3:
      return Math.floor((a + b) / 2);
    case 4: {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
  }
}

/** An RGB PNG whose every scanline uses `filter` (0 none, 1 sub, 2 up, 3 average, 4 Paeth). */
function encode(width: number, height: number, pixels: Buffer, filter: Filter, level: number, extra: Buffer[] = []): Buffer {
  const stride = width * 3;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 ? pixels[y * stride + x]! : 0);
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      raw[y * (stride + 1) + 1 + x] = (at(x, y) - predict(filter, at(x - 3, y), at(x, y - 1), at(x - 3, y - 1))) & 0xff;
    }
  }
  return png(width, height, raw, level, extra);
}

/** An RGB PNG around scanlines that are already filtered. */
function png(width: number, height: number, raw: Buffer, level = 9, extra: Buffer[] = []): Buffer {
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

  test("average and Paeth scanlines decode to the pixels they encode", () => {
    for (const filter of [3, 4] as const) {
      const encoded = encode(WIDTH, HEIGHT, PIXELS, filter, 6);
      expect(decodePng(encoded)!.pixels.equals(PIXELS)).toBe(true);
      expect(samePng(encoded, encode(WIDTH, HEIGHT, PIXELS, 0, 9))).toBe(true);
    }
  });

  test("Paeth breaks a tie toward left, then above, before above-left", () => {
    // In each bottom-right pixel the estimate is equally far from two
    // neighbours, and preferring above-left would decode 15 instead of 35.
    const leftWins = Buffer.from([0, 10, 10, 10, 0, 0, 0, 4, 20, 20, 20, 5, 5, 5]); // left 30, above 0, above-left 10
    const aboveWins = Buffer.from([0, 10, 10, 10, 30, 30, 30, 4, 246, 246, 246, 5, 5, 5]); // left 0, above 30, above-left 10
    expect([...decodePng(png(2, 2, leftWins))!.pixels]).toEqual([10, 10, 10, 0, 0, 0, 30, 30, 30, 35, 35, 35]);
    expect([...decodePng(png(2, 2, aboveWins))!.pixels]).toEqual([10, 10, 10, 30, 30, 30, 0, 0, 0, 35, 35, 35]);
  });

  test("a truncated or corrupt PNG compares unequal instead of throwing", () => {
    const whole = encode(WIDTH, HEIGHT, PIXELS, 4, 9);
    const idat = whole.indexOf("IDAT") - 4;
    const overrun = Buffer.from(whole);
    overrun.writeUInt32BE(whole.length, idat);
    const broken = [
      whole.subarray(0, whole.length - 20), // cut inside IDAT
      whole.subarray(0, whole.length - 12), // IEND missing
      overrun, // a chunk longer than the file
      Buffer.concat([whole.subarray(0, idat), chunk("IDAT", Buffer.from("not zlib")), chunk("IEND", Buffer.alloc(0))]),
    ];
    for (const file of broken) {
      expect(decodePng(file)).toBeNull();
      expect(samePng(whole, file)).toBe(false);
    }
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
