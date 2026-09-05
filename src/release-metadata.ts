const RELEASE_URL = "https://github.com/Pepewitch/wisp/releases/download";
const RELEASE_PROTOCOL_TIMEOUT_MS = 3_000;

interface ReleaseIdentity {
  version: string;
  tag: string;
}

/**
 * Every supported Wisp release includes the Linux manifest, so it is the
 * canonical release-level protocol record on every daemon platform. Older
 * releases have no field; absence is unknown, never inferred from SemVer.
 */
export async function fetchReleaseApiProtocolVersion(
  fetcher: typeof fetch,
  release: ReleaseIdentity,
): Promise<number | null> {
  try {
    const response = await fetcher(`${RELEASE_URL}/${release.tag}/release-manifest.json`, {
      signal: AbortSignal.timeout(RELEASE_PROTOCOL_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const value = body as Record<string, unknown>;
    const target = value.target;
    if (
      value.schemaVersion !== 1 ||
      value.product !== "wisp" ||
      value.version !== release.version ||
      !Number.isSafeInteger(value.apiProtocolVersion) ||
      (value.apiProtocolVersion as number) < 1 ||
      typeof value.commit !== "string" ||
      !/^[0-9a-f]{40}$/.test(value.commit) ||
      value.dirty !== false ||
      !target ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      (target as Record<string, unknown>).os !== "linux" ||
      (target as Record<string, unknown>).arch !== "x86_64" ||
      (target as Record<string, unknown>).libc !== "glibc"
    ) {
      return null;
    }
    return value.apiProtocolVersion as number;
  } catch {
    return null;
  }
}
