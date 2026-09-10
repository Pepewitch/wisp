import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";

async function optionalFile(path: string): Promise<Buffer> {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0); throw error; }
}

/** SQLite's rolling WAL checksum, including the header and each committed frame. */
function checksum(bytes: Buffer, bigEndian: boolean, seed: [number, number]): [number, number] {
  let [a, b] = seed;
  for (let i = 0; i < bytes.length; i += 8) {
    const x = bigEndian ? bytes.readUInt32BE(i) : bytes.readUInt32LE(i);
    const y = bigEndian ? bytes.readUInt32BE(i + 4) : bytes.readUInt32LE(i + 4);
    a = (a + x + b) >>> 0;
    b = (b + y + a) >>> 0;
  }
  return [a, b];
}

/**
 * Materialize committed WAL pages in memory. Opening even a read-only SQLite
 * connection can create/update -shm; an immutable connection ignores the WAL.
 * Neither is acceptable for a strictly read-only report on a running home.
 */
function committedImage(main: Buffer, wal: Buffer): Buffer {
  if (wal.length < 32) return Buffer.from(main);
  const magic = wal.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) throw new Error("Unrecognized database WAL");
  const bigEndian = magic === 0x377f0683;
  const pageSize = wal.readUInt32BE(8);
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) throw new Error("Invalid WAL page size");
  let sum = checksum(wal.subarray(0, 24), bigEndian, [0, 0]);
  if (sum[0] !== wal.readUInt32BE(24) || sum[1] !== wal.readUInt32BE(28)) throw new Error("Invalid WAL header checksum");
  const frames: { page: number; offset: number }[] = [];
  let committed = 0, pages = 0;
  for (let offset = 32; offset + 24 + pageSize <= wal.length; offset += 24 + pageSize) {
    if (!wal.subarray(offset + 8, offset + 16).equals(wal.subarray(16, 24))) break;
    sum = checksum(wal.subarray(offset, offset + 8), bigEndian, sum);
    sum = checksum(wal.subarray(offset + 24, offset + 24 + pageSize), bigEndian, sum);
    if (sum[0] !== wal.readUInt32BE(offset + 16) || sum[1] !== wal.readUInt32BE(offset + 20)) break;
    const page = wal.readUInt32BE(offset);
    if (page === 0) throw new Error("Invalid WAL page");
    frames.push({ page, offset: offset + 24 });
    const size = wal.readUInt32BE(offset + 4);
    if (size) { committed = frames.length; pages = size; }
  }
  if (!committed) return Buffer.from(main);
  if (pages * pageSize > 512 * 1024 * 1024) throw new Error("Storage ledger exceeds the 512 MiB report snapshot limit");
  const image = Buffer.alloc(pages * pageSize);
  main.copy(image);
  for (const frame of frames.slice(0, committed)) {
    if (frame.page <= pages) wal.copy(image, (frame.page - 1) * pageSize, frame.offset, frame.offset + pageSize);
  }
  return image;
}

/** No SQLite handle ever opens the on-disk home, and no temporary copy is written. */
export async function readStorageLedger(path: string): Promise<Database | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const main = await optionalFile(path), wal = await optionalFile(`${path}-wal`);
    const nextMain = await optionalFile(path), nextWal = await optionalFile(`${path}-wal`);
    if (!main.equals(nextMain) || !wal.equals(nextWal)) continue;
    if (!main.length) return null;
    const image = committedImage(main, wal);
    // The deserialized database has no WAL file. Switch the image's read/write
    // format to rollback mode before SQLite inspects these in-memory pages.
    image[18] = 1; image[19] = 1;
    return Database.deserialize(image, { readonly: true });
  }
  throw new Error("The database changed during the storage snapshot. Retry when activity settles.");
}
