import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { glibcFloor, versionRequirements } from "../scripts/glibc-floor";
import { assertGlibcFloor, MINIMUM_GLIBC } from "../scripts/release-linux";

const EHDR_SIZE = 64;
const SHDR_SIZE = 64;
const SHT_STRTAB = 3;
const SHT_GNU_VERNEED = 0x6ffffffe;

interface Need {
  /** Library name; only its version list matters to the reader. */
  file: string;
  versions: string[];
}

/**
 * The smallest ELF64 the reader accepts: a string table plus the version
 * requirements it indexes. Real binaries are the contract, but only a
 * synthetic one can exercise the entry walk deterministically on any host.
 */
function elfWithVersionNeeds(needs: Need[] | null): string {
  const strtab: string[] = ["\0"];
  const intern = (value: string): number => {
    const offset = strtab.join("").length;
    strtab.push(`${value}\0`);
    return offset;
  };
  const entries = needs?.map((need) => ({
    file: intern(need.file),
    versions: need.versions.map((version) => intern(version)),
  }));
  const dynstr = Buffer.from(strtab.join(""), "utf8");

  const verneed = Buffer.alloc((entries ?? []).reduce((sum, entry) => sum + 16 + entry.versions.length * 16, 0));
  let at = 0;
  for (const [index, entry] of (entries ?? []).entries()) {
    const size = 16 + entry.versions.length * 16;
    verneed.writeUInt16LE(1, at); // vn_version
    verneed.writeUInt16LE(entry.versions.length, at + 2); // vn_cnt
    verneed.writeUInt32LE(entry.file, at + 4); // vn_file
    verneed.writeUInt32LE(16, at + 8); // vn_aux, relative to this entry
    verneed.writeUInt32LE(index === (entries ?? []).length - 1 ? 0 : size, at + 12); // vn_next
    for (const [i, name] of entry.versions.entries()) {
      const aux = at + 16 + i * 16;
      verneed.writeUInt32LE(name, aux + 8); // vna_name
      verneed.writeUInt32LE(i === entry.versions.length - 1 ? 0 : 16, aux + 12); // vna_next
    }
    at += size;
  }

  const dynstrOffset = EHDR_SIZE;
  const verneedOffset = dynstrOffset + dynstr.length;
  const shoff = verneedOffset + verneed.length;
  const count = entries ? 3 : 2;
  const shdrs = Buffer.alloc(count * SHDR_SIZE);
  const writeShdr = (index: number, type: number, offset: number, size: number, link: number): void => {
    const base = index * SHDR_SIZE;
    shdrs.writeUInt32LE(type, base + 4);
    shdrs.writeBigUInt64LE(BigInt(offset), base + 0x18);
    shdrs.writeBigUInt64LE(BigInt(size), base + 0x20);
    shdrs.writeUInt32LE(link, base + 0x28);
  };
  writeShdr(1, SHT_STRTAB, dynstrOffset, dynstr.length, 0);
  if (entries) writeShdr(2, SHT_GNU_VERNEED, verneedOffset, verneed.length, 1);

  const ehdr = Buffer.alloc(EHDR_SIZE);
  ehdr.write("\x7fELF", 0, "binary");
  ehdr[4] = 2; // ELFCLASS64
  ehdr[5] = 1; // ELFDATA2LSB
  ehdr.writeBigUInt64LE(BigInt(shoff), 0x28);
  ehdr.writeUInt16LE(SHDR_SIZE, 0x3a);
  ehdr.writeUInt16LE(count, 0x3c);

  const path = join(mkdtempSync(join(tmpdir(), "wisp-elf-")), "artifact");
  writeFileSync(path, Buffer.concat([ehdr, dynstr, verneed, shdrs]));
  return path;
}

describe("glibc floor", () => {
  test("reads every requirement across libraries", () => {
    const path = elfWithVersionNeeds([
      { file: "libc.so.6", versions: ["GLIBC_2.2.5", "GLIBC_2.17"] },
      { file: "libm.so.6", versions: ["GLIBC_2.29"] },
    ]);
    expect(versionRequirements(path)).toEqual(["GLIBC_2.2.5", "GLIBC_2.17", "GLIBC_2.29"]);
    expect(glibcFloor(path)).toBe("2.29");
  });

  test("orders minor versions numerically, not lexically", () => {
    const path = elfWithVersionNeeds([{ file: "libc.so.6", versions: ["GLIBC_2.9", "GLIBC_2.17", "GLIBC_2.3"] }]);
    expect(glibcFloor(path)).toBe("2.17");
  });

  test("ignores requirements from other version namespaces", () => {
    const path = elfWithVersionNeeds([
      { file: "libstdc++.so.6", versions: ["GLIBCXX_3.4.32", "CXXABI_1.3"] },
      { file: "libc.so.6", versions: ["GLIBC_2.14"] },
    ]);
    expect(glibcFloor(path)).toBe("2.14");
  });

  test("refuses to guess when a binary records no glibc requirement", () => {
    const path = elfWithVersionNeeds(null);
    expect(versionRequirements(path)).toEqual([]);
    expect(() => glibcFloor(path)).toThrow("no GLIBC symbol versions found");
  });

  test("the release gate accepts the documented floor and refuses a raised one", () => {
    expect(() =>
      assertGlibcFloor(elfWithVersionNeeds([{ file: "libc.so.6", versions: [`GLIBC_${MINIMUM_GLIBC}`] }])),
    ).not.toThrow();
    expect(() =>
      assertGlibcFloor(elfWithVersionNeeds([{ file: "libc.so.6", versions: ["GLIBC_2.38"] }])),
    ).toThrow(`artifact requires glibc 2.38, not the documented floor ${MINIMUM_GLIBC}`);
  });

  test("rejects a file that is not a 64-bit little-endian ELF", () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-elf-"));
    const text = join(dir, "not-elf");
    writeFileSync(text, "#!/bin/sh\nexit 0\n".padEnd(128, " "));
    expect(() => glibcFloor(text)).toThrow("not an ELF file");

    const wide = join(dir, "elf32");
    const header = Buffer.alloc(128);
    header.write("\x7fELF", 0, "binary");
    header[4] = 1; // ELFCLASS32
    header[5] = 1;
    writeFileSync(wide, header);
    expect(() => glibcFloor(wide)).toThrow("not a little-endian 64-bit ELF file");
  });
});
