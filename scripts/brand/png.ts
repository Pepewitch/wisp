/**
 * Whether two PNGs show the same image. Chrome's PNG encoder compresses
 * differently across builds and platforms (the committed PWA icons came from
 * Linux Chromium; macOS Chrome re-encodes the same pixels into different
 * bytes), so the brand check compares what a viewer sees: every non-IDAT
 * chunk byte for byte, and the decoded pixels.
 */
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export interface PngImage {
  /** Every chunk except IDAT, type and body, in file order. */
  chunks: Buffer;
  pixels: Buffer;
}

/**
 * An 8-bit, non-interlaced PNG's chunks and unfiltered pixels, or null for any
 * other PNG and for a truncated or corrupt file.
 */
export function decodePng(png: Uint8Array): PngImage | null {
  const data = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (data.length < SIGNATURE.length || !data.subarray(0, SIGNATURE.length).equals(SIGNATURE)) return null;
  const chunks: Buffer[] = [];
  const idat: Buffer[] = [];
  let header: Buffer | null = null;
  for (let at = SIGNATURE.length; ; ) {
    if (at + 12 > data.length) return null;
    const length = data.readUInt32BE(at);
    if (at + 12 + length > data.length) return null;
    const type = data.subarray(at + 4, at + 8);
    const body = data.subarray(at + 8, at + 8 + length);
    if (type.toString("latin1") === "IDAT") idat.push(body);
    else chunks.push(type, body);
    if (type.toString("latin1") === "IHDR") header = body;
    if (type.toString("latin1") === "IEND") break;
    at += 12 + length;
  }
  if (!header || header.length < 13) return null;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const channels = CHANNELS[header[9]!];
  if (!channels || header[8] !== 8 || header[12] !== 0) return null;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[row + x - channels]! : 0;
      const up = y > 0 ? pixels[row - stride + x]! : 0;
      const corner = x >= channels && y > 0 ? pixels[row - stride + x - channels]! : 0;
      let predicted: number;
      switch (filter) {
        case 0:
          predicted = 0;
          break;
        case 1:
          predicted = left;
          break;
        case 2:
          predicted = up;
          break;
        case 3:
          predicted = (left + up) >> 1;
          break;
        case 4: {
          const estimate = left + up - corner;
          const toLeft = Math.abs(estimate - left);
          const toUp = Math.abs(estimate - up);
          const toCorner = Math.abs(estimate - corner);
          predicted = toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
          break;
        }
        default:
          return null;
      }
      pixels[row + x] = (raw[line + x]! + predicted) & 0xff;
    }
  }
  return { chunks: Buffer.concat(chunks), pixels };
}

/** True when both files are the same image, however each was compressed. */
export function samePng(a: Uint8Array, b: Uint8Array): boolean {
  if (Buffer.from(a).equals(Buffer.from(b))) return true;
  const left = decodePng(a);
  const right = decodePng(b);
  return left !== null && right !== null && left.chunks.equals(right.chunks) && left.pixels.equals(right.pixels);
}
