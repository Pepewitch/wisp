/**
 * Installed and upstream versions.
 *
 * **Probe before pin, same rule as the adapters.** Every source below was
 * confirmed by fetching it and matching the version it reports against the
 * locally installed CLI on 2026-09-06 — not taken from a README:
 *
 *  - claude  npm @anthropic-ai/claude-code → 2.1.261, and the package's own
 *            `bin` entry is `claude`
 *  - codex   npm @openai/codex             → 0.153.4, `bin` entry `codex`
 *  - droid   formulae.brew.sh cask 'droid' → 0.213.0. Install-method
 *            specific: it is the truth for a Homebrew install, which is how
 *            droid arrives on macOS, and honest noise otherwise.
 *  - cursor  NONE FOUND. cursor.com's agent-cli-download endpoint answers
 *            HTML, and the bundled CLI carries no version endpoint. Recorded
 *            as absent rather than guessed — a wrong "latest" is worse than a
 *            missing one, because it would report drift that does not exist.
 */
import type { ModelProbeSpawnFn } from "../../src/adapters";

export type UpstreamSource =
  | { kind: "npm"; pkg: string }
  | { kind: "brew-cask"; token: string }
  | { kind: "none"; why: string };

export const UPSTREAM_SOURCES: Record<string, UpstreamSource> = {
  claude: { kind: "npm", pkg: "@anthropic-ai/claude-code" },
  codex: { kind: "npm", pkg: "@openai/codex" },
  droid: { kind: "brew-cask", token: "droid" },
  cursor: {
    kind: "none",
    why: "cursor publishes no machine-readable version endpoint (its download API answers HTML)",
  },
};

export function describeSource(source: UpstreamSource): string {
  if (source.kind === "npm") return `npm ${source.pkg}`;
  if (source.kind === "brew-cask") return `homebrew cask ${source.token}`;
  return source.why;
}

/**
 * The version string out of `<bin> --version`, tolerating the three shapes the
 * installed CLIs actually print ("0.213.0", "codex-cli 0.153.4",
 * "2.1.261 (Claude Code)", "2026.09.02-c22c1a3").
 */
export function parseVersionOutput(text: string): string | null {
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|\d{4}\.\d{2}\.\d{2}(?:-[0-9A-Za-z]+)?)/.exec(line)?.[1] ?? null;
}

export interface InstalledVersion {
  version: string | null;
  /** Set when the binary is absent or refused to report — never a throw. */
  error: string | null;
}

export async function installedVersion(bin: string, spawn: ModelProbeSpawnFn): Promise<InstalledVersion> {
  try {
    const res = await spawn([bin, "--version"]);
    if (res.exitCode !== 0) {
      return { version: null, error: `'${bin} --version' exited ${res.exitCode}` };
    }
    const version = parseVersionOutput(`${res.stdout}\n${res.stderr}`);
    return version ? { version, error: null } : { version: null, error: `'${bin} --version' printed no version` };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { version: null, error: /ENOENT|not found/i.test(message) ? `'${bin}' not found on PATH` : message };
  }
}

export type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * Latest upstream version, or null with a reason. Network failure degrades to
 * "unknown" and never crashes the report: the offline half of `harness:check`
 * is the half that always has to work.
 */
export async function latestVersion(
  source: UpstreamSource,
  fetchFn: FetchFn,
): Promise<{ version: string | null; error: string | null }> {
  if (source.kind === "none") return { version: null, error: source.why };
  const url =
    source.kind === "npm"
      ? `https://registry.npmjs.org/${source.pkg}/latest`
      : `https://formulae.brew.sh/api/cask/${source.token}.json`;
  try {
    const res = await fetchFn(url);
    if (!res.ok) return { version: null, error: `${url} answered ${res.status}` };
    const data: unknown = JSON.parse(await res.text());
    const version = (data as { version?: unknown })?.version;
    if (typeof version !== "string") return { version: null, error: `${url} returned no version field` };
    return { version, error: null };
  } catch (e) {
    return { version: null, error: e instanceof Error ? e.message : String(e) };
  }
}
