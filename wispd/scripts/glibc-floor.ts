#!/usr/bin/env bun
// The Linux artifact is the pinned Bun runtime with the bundle appended, so
// its glibc floor is a property of the toolchain rather than of Wisp's source.
// Reading it out of the ELF keeps the floor quoted by README.md and
// docs/INSTALL.md a derived fact: a Bun upgrade that raises it fails the
// release build instead of silently invalidating the install guide.
import { closeSync, openSync, readSync } from "node:fs";

const ELF_MAGIC = 0x464c457f; // "\x7fELF" read little-endian
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const SHT_GNU_VERNEED = 0x6ffffffe;
const EHDR_SIZE = 64;
const SHDR_SIZE = 64;
const VERNEED_SIZE = 16;
const VERNAUX_SIZE = 16;
const GLIBC_VERSION = /^GLIBC_(\d+)\.(\d+)(?:\.(\d+))?$/;
/** A corrupt or hostile header must not turn into a multi-gigabyte read. */
const MAX_SECTION_BYTES = 64 * 1024 * 1024;

interface Section {
  type: number;
  offset: number;
  size: number;
  link: number;
}

function readAt(fd: number, offset: number, length: number, what: string): Buffer {
  if (length > MAX_SECTION_BYTES) throw new Error(`${what} is implausibly large (${length} bytes)`);
  const buffer = Buffer.alloc(length);
  if (readSync(fd, buffer, 0, length, offset) !== length) throw new Error(`truncated ${what}`);
  return buffer;
}

/** Byte offsets are ELF64 little-endian, the only shape this artifact has. */
function readU64(buffer: Buffer, offset: number, what: string): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${what} exceeds a safe file offset`);
  return Number(value);
}

function sections(fd: number): Section[] {
  const ehdr = readAt(fd, 0, EHDR_SIZE, "ELF header");
  if (ehdr.readUInt32LE(0) !== ELF_MAGIC) throw new Error("not an ELF file");
  if (ehdr[4] !== ELFCLASS64 || ehdr[5] !== ELFDATA2LSB) throw new Error("not a little-endian 64-bit ELF file");
  const shoff = readU64(ehdr, 0x28, "section header offset");
  const shentsize = ehdr.readUInt16LE(0x3a);
  const shnum = ehdr.readUInt16LE(0x3c);
  if (shentsize !== SHDR_SIZE) throw new Error(`unexpected section header size ${shentsize}`);
  if (shoff === 0 || shnum === 0) throw new Error("ELF file has no section headers");
  const table = readAt(fd, shoff, shnum * SHDR_SIZE, "section header table");
  const parsed: Section[] = [];
  for (let i = 0; i < shnum; i++) {
    const at = i * SHDR_SIZE;
    parsed.push({
      type: table.readUInt32LE(at + 4),
      offset: readU64(table, at + 0x18, "section offset"),
      size: readU64(table, at + 0x20, "section size"),
      link: table.readUInt32LE(at + 0x28),
    });
  }
  return parsed;
}

function stringAt(strings: Buffer, offset: number): string {
  if (offset >= strings.length) throw new Error("version name points outside its string table");
  const end = strings.indexOf(0, offset);
  return strings.toString("utf8", offset, end === -1 ? strings.length : end);
}

/** Every versioned symbol requirement the binary records, e.g. `GLIBC_2.17`. */
export function versionRequirements(path: string): string[] {
  const fd = openSync(path, "r");
  try {
    const parsed = sections(fd);
    const verneed = parsed.find((section) => section.type === SHT_GNU_VERNEED);
    if (!verneed) return [];
    const strtab = parsed[verneed.link];
    if (!strtab) throw new Error("version requirements reference a missing string table");
    const entries = readAt(fd, verneed.offset, verneed.size, ".gnu.version_r");
    const strings = readAt(fd, strtab.offset, strtab.size, "dynamic string table");
    const names: string[] = [];
    for (let at = 0; at + VERNEED_SIZE <= entries.length; ) {
      const count = entries.readUInt16LE(at + 2);
      const auxOffset = entries.readUInt32LE(at + 8);
      const next = entries.readUInt32LE(at + 12);
      for (let i = 0, aux = at + auxOffset; i < count && aux + VERNAUX_SIZE <= entries.length; i++) {
        names.push(stringAt(strings, entries.readUInt32LE(aux + 8)));
        const auxNext = entries.readUInt32LE(aux + 12);
        if (auxNext === 0) break;
        aux += auxNext;
      }
      if (next === 0) break;
      at += next;
    }
    return names;
  } finally {
    closeSync(fd);
  }
}

/** Lexicographic on major, minor, patch — 2.3 sorts below 2.17, not above it. */
function compareParts(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Highest `GLIBC_x.y[.z]` symbol version the binary needs, as `x.y[.z]`. */
export function glibcFloor(path: string): string {
  let best: { text: string; parts: number[] } | null = null;
  for (const name of versionRequirements(path)) {
    const match = GLIBC_VERSION.exec(name);
    if (!match) continue;
    const parts = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
    if (!best || compareParts(parts, best.parts) > 0) best = { text: name.slice("GLIBC_".length), parts };
  }
  if (!best) throw new Error(`no GLIBC symbol versions found in ${path}`);
  return best.text;
}

if (import.meta.main) {
  try {
    const [path, ...rest] = process.argv.slice(2);
    if (!path || rest.length > 0) throw new Error("usage: glibc-floor.ts <elf-binary>");
    console.log(glibcFloor(path));
  } catch (error) {
    console.error(`glibc-floor: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
