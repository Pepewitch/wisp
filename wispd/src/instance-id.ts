import { createHash } from "node:crypto";
import { chmodSync, closeSync, fstatSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { hostname } from "node:os";

const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isInstanceId(value: string): boolean {
  return INSTANCE_ID.test(value);
}

/**
 * The create-exclusive sidecar serializes the one migration loadConfig cannot
 * serialize itself: two daemons starting against a legacy config at once.
 * config.json remains the human-visible mirror, and disagreement is corruption
 * rather than permission to rotate an identity clients may have pinned.
 *
 * The sidecar is written whole into a temp file first and then linked into
 * place, which is atomic and still fails with EEXIST for the loser of a race:
 * a kill or a full disk can no longer leave an empty file behind.
 */
export function loadOrCreateInstanceId(path: string, configured: string | undefined): string {
  placeInstanceId(path, configured ?? crypto.randomUUID(), (temporary) => {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  });
  chmodSync(path, 0o600);
  let sidecar = readInstanceIdFile(path);
  if (!isInstanceId(sidecar.value)) {
    // Not an identity. Older releases created the file and wrote it in two
    // steps, so an interrupted first start left it empty, and every start
    // since has thrown right here: no process ever loaded an identity from it.
    // config.json's copy, when there is one, IS the home's identity; without
    // one there is nothing any client can have pinned, so a new one is made.
    const repaired = configured ?? derivedInstanceId(path, sidecar.stat);
    console.warn(
      `[wisp] ${path} held no valid identity; ${configured === undefined ? "created a new one" : "restored it from config.json"}`,
    );
    placeInstanceId(path, repaired, (temporary) => renameSync(temporary, path));
    sidecar = readInstanceIdFile(path);
    if (!isInstanceId(sidecar.value)) throw new Error(`instance-id: ${path} must hold a UUID`);
  }
  if (configured !== undefined && sidecar.value !== configured) {
    throw new Error("config.json: instanceId does not match the Wisp home identity");
  }
  return sidecar.value;
}

/** Write the identity to a fresh temp file, fsync it, and let `place` move it into position. */
function placeInstanceId(path: string, value: string, place: (temporary: string) => void): void {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(fd, `${value}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    place(temporary);
  } finally {
    rmSync(temporary, { force: true });
  }
}

interface SidecarFile {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

/** The sidecar's value and the file it came from, read through one descriptor. */
function readInstanceIdFile(path: string): { value: string; stat: SidecarFile } {
  const fd = openSync(path, "r");
  try {
    return { stat: fstatSync(fd, { bigint: true }), value: readFileSync(fd, "utf8").trim() };
  } finally {
    closeSync(fd);
  }
}

/**
 * A replacement identity for a broken sidecar that every process repairing
 * THAT file computes alike, so starts racing to repair it agree without a
 * lock. It comes from attributes of the broken file that never change (not
 * its times: chmod moves ctime), formatted as an RFC 9562 version-8 UUID.
 */
function derivedInstanceId(path: string, broken: SidecarFile): string {
  const h = createHash("sha256")
    .update([path, hostname(), broken.dev, broken.ino, broken.birthtimeNs].join("\0"))
    .digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
