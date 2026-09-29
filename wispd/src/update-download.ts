/**
 * Reading what the self-updater downloads: every body is bounded before it is
 * parsed or written, and every release response must have been served from
 * GitHub's release hosts over https, whatever redirects led there.
 */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export const MAX_ARTIFACT_BYTES = 250 * 1024 * 1024;
/**
 * Where a release download may end up after redirects: GitHub answers the
 * release URL itself and redirects the bytes to its asset hosts.
 */
const RELEASE_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

/**
 * The URL a response was finally served from, after every redirect, must be
 * https on GitHub's release hosts. A response without one (never the case for
 * a real fetch) is refused rather than trusted.
 */
export function assertReleaseDownloadUrl(response: Response, what: string): void {
  let url: URL;
  try {
    url = new URL(response.url);
  } catch {
    throw new Error(`${what} response has no final URL`);
  }
  if (url.protocol !== "https:" || !RELEASE_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new Error(`${what} was served from ${url.protocol}//${url.host}, not a GitHub release download host`);
  }
}

/** A body read up to `maxBytes`, refused as soon as it is larger, before it is parsed. */
export async function readBoundedText(response: Response, maxBytes: number, what: string): Promise<string> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && !(Number(advertised) >= 0 && Number(advertised) <= maxBytes)) {
    throw new Error(`${what} is too large`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error(`${what} is too large`);
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function downloadVerifiedArtifact(
  response: Response,
  path: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<void> {
  if (!response.body) throw new Error("release artifact response has no body");
  const advertisedSize = response.headers.get("content-length");
  if (advertisedSize !== null) {
    const size = Number(advertisedSize);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARTIFACT_BYTES) {
      throw new Error("release artifact Content-Length is invalid or too large");
    }
  }
  const file = await open(path, "wx", 0o755);
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > expectedSize || size > MAX_ARTIFACT_BYTES) {
        throw new Error("release artifact is larger than its manifest");
      }
      hash.update(chunk.value);
      let offset = 0;
      while (offset < chunk.value.byteLength) {
        const written = await file.write(chunk.value.subarray(offset));
        if (written.bytesWritten < 1) throw new Error("could not write the release artifact");
        offset += written.bytesWritten;
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
    await file.close();
  }
  if (size !== expectedSize) throw new Error("release artifact size does not match its manifest");
  if (hash.digest("hex") !== expectedSha256) {
    throw new Error("release artifact checksum does not match its manifest");
  }
}
