import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { chmod, mkdir, open, rename, rm, symlink } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import {
  compareVersions,
  isReleaseVersion,
} from "../../shared/release-version";
import type { SpawnResult } from "./doctor";
import {
  isHomebrewServiceProcess,
  isSupervisordServiceProcess,
} from "./update-supervisor";
import { API_PROTOCOL_VERSION, BUILD_DIRTY, VERSION } from "./version";

export { compareVersions } from "../../shared/release-version";
export {
  isHomebrewServiceProcess,
  isSupervisordServiceProcess,
} from "./update-supervisor";

const DAEMON_CHANNEL_URL =
  "https://raw.githubusercontent.com/Pepewitch/homebrew-tap/main/updates/wisp-daemon.json";
const RELEASE_URL = "https://github.com/Pepewitch/wisp/releases/download";
const MANAGED_INSTALL_MARKER = "wisp-managed-install-v1";
const RELEASE_CACHE_MS = 6 * 60 * 60 * 1000;
const RESTART_DELAY_MS = 500;
const MAX_CHANNEL_BYTES = 16 * 1024;
const MAX_ARTIFACT_BYTES = 250 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

export type InstallMethod = "homebrew" | "managed-linux" | "unsupported";
export type UpdateState = "up-to-date" | "available" | "installing" | "restarting" | "failed" | "unavailable";

export interface UpdateStatus {
  currentVersion: string;
  currentApiProtocolVersion: number;
  latestVersion: string | null;
  latestApiProtocolVersion: number | null;
  state: UpdateState;
  installMethod: InstallMethod;
  canAutoUpdate: boolean;
  message: string | null;
  checkedAt: string | null;
}

export interface ReleaseInfo {
  version: string;
  tag: string;
  publishedAt: string;
  apiProtocolVersion: number | null;
}

interface DaemonUpdateChannel {
  schemaVersion: 1;
  product: "wisp";
  version: string;
  apiProtocolVersion: number;
  publishedAt: string;
}

interface LinuxManifest {
  schemaVersion: 1;
  product: "wisp";
  version: string;
  apiProtocolVersion?: number;
  commit: string;
  dirty: false;
  target: {
    os: "linux";
    arch: "x86_64";
    libc: "glibc";
  };
  artifact: {
    file: string;
    sha256: string;
    size: number;
  };
}

interface Installation {
  method: InstallMethod;
  supervised: boolean;
  reason: string | null;
  installRoot?: string;
}

export type CommandResult = SpawnResult;

export interface UpdateManagerOptions {
  fetch?: typeof fetch;
  run?: (cmd: string[]) => Promise<CommandResult>;
  detectInstallation?: () => Installation;
  restart?: () => void;
  now?: () => Date;
  currentVersion?: string;
  executablePath?: string;
  dirty?: boolean;
  releaseCacheMs?: number;
  restartDelayMs?: number;
}

function output(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8").trim();
}

async function runCommand(cmd: string[]): Promise<CommandResult> {
  const child = Bun.spawn({
    cmd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function commandFailure(cmd: string[], result: CommandResult): Error {
  const detail = result.stderr || result.stdout;
  return new Error(`${cmd.join(" ")} exited ${result.exitCode}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
}

function runSync(cmd: string[]): CommandResult {
  const result = Bun.spawnSync({ cmd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
  };
}

function homebrewInstallation(): Installation | null {
  if (platform() !== "darwin" || !Bun.which("brew") || !Bun.which("launchctl")) return null;
  const prefix = runSync(["brew", "--prefix", "wisp"]);
  if (prefix.exitCode !== 0 || !prefix.stdout) return null;
  const installed = realpathSync(resolve(prefix.stdout, "bin/wisp"));
  if (installed !== realpathSync(process.execPath)) return null;
  if (typeof process.getuid !== "function") {
    return { method: "homebrew", supervised: false, reason: "cannot identify the launchd user" };
  }
  const supervised = isHomebrewServiceProcess(process.getuid(), process.pid);
  return {
    method: "homebrew",
    supervised,
    reason: supervised ? null : "this Homebrew installation is not running under its launchd service",
  };
}

function managedLinuxInstallation(): Installation | null {
  if (platform() !== "linux") return null;
  const installRoot = resolve(process.env.WISP_INSTALL_ROOT ?? join(homedir(), ".local/share/wisp"));
  const marker = join(installRoot, ".managed-by-wisp");
  const current = join(installRoot, "current");
  if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== MANAGED_INSTALL_MARKER) return null;
  if (!existsSync(current) || !lstatSync(current).isSymbolicLink()) return null;
  if (realpathSync(current) !== realpathSync(process.execPath)) return null;
  if (isSupervisordServiceProcess(process.pid)) {
    return { method: "managed-linux", supervised: true, reason: null, installRoot };
  }
  if (!Bun.which("systemctl")) {
    return {
      method: "managed-linux",
      supervised: false,
      reason: "automatic updates require systemd, but systemctl is not available",
      installRoot,
    };
  }
  const service = runSync(["systemctl", "--user", "show", "wisp.service", "--property=MainPID", "--value"]);
  const supervised = service.exitCode === 0 && Number(service.stdout) === process.pid;
  return {
    method: "managed-linux",
    supervised,
    reason: supervised
      ? null
      : "automatic updates require the running daemon to be managed by wisp.service",
    installRoot,
  };
}

export function detectInstallation(): Installation {
  if (BUILD_DIRTY || process.env.WISP_COMMAND_NAME === "wisp-dev") {
    return { method: "unsupported", supervised: false, reason: "source and development builds update manually" };
  }
  try {
    return (
      homebrewInstallation() ??
      managedLinuxInstallation() ?? {
        method: "unsupported",
        supervised: false,
        reason: "Wisp does not recognize this installation",
      }
    );
  } catch (error) {
    return {
      method: "unsupported",
      supervised: false,
      reason: `could not inspect this installation: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function parseDaemonUpdateChannel(value: unknown): ReleaseInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("daemon update channel is not an object");
  }
  const channel = value as Partial<DaemonUpdateChannel>;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "apiProtocolVersion",
    "product",
    "publishedAt",
    "schemaVersion",
    "version",
  ];
  const publishedAt =
    typeof channel.publishedAt === "string" ? new Date(channel.publishedAt) : new Date(NaN);
  if (
    JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
    channel.schemaVersion !== 1 ||
    channel.product !== "wisp" ||
    typeof channel.version !== "string" ||
    !isReleaseVersion(channel.version) ||
    !Number.isSafeInteger(channel.apiProtocolVersion) ||
    (channel.apiProtocolVersion as number) < 1 ||
    Number.isNaN(publishedAt.valueOf()) ||
    publishedAt.toISOString() !== channel.publishedAt
  ) {
    throw new Error("daemon update channel is invalid");
  }
  return {
    version: channel.version,
    tag: `v${channel.version}`,
    publishedAt: channel.publishedAt,
    apiProtocolVersion: channel.apiProtocolVersion as number,
  };
}

async function downloadVerifiedArtifact(
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

function validateLinuxManifest(value: unknown, release: ReleaseInfo): asserts value is LinuxManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("release manifest is not an object");
  const manifest = value as LinuxManifest;
  const artifact = `wisp-v${release.version}-linux-x86_64`;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.product !== "wisp" ||
    manifest.version !== release.version ||
    (manifest.apiProtocolVersion !== undefined &&
      (!Number.isSafeInteger(manifest.apiProtocolVersion) || manifest.apiProtocolVersion < 1)) ||
    typeof manifest.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(manifest.commit) ||
    manifest.dirty !== false ||
    manifest.target?.os !== "linux" ||
    manifest.target.arch !== "x86_64" ||
    manifest.target.libc !== "glibc" ||
    manifest.artifact?.file !== artifact ||
    typeof manifest.artifact.size !== "number" ||
    !Number.isSafeInteger(manifest.artifact.size) ||
    manifest.artifact.size < 1 ||
    manifest.artifact.size > MAX_ARTIFACT_BYTES ||
    typeof manifest.artifact.sha256 !== "string" ||
    !SHA256.test(manifest.artifact.sha256)
  ) {
    throw new Error("release manifest does not match the supported Linux artifact");
  }
}

export class UpdateManager {
  private readonly fetcher: typeof fetch;
  private readonly run: (cmd: string[]) => Promise<CommandResult>;
  private readonly detector: () => Installation;
  private readonly restart: () => void;
  private readonly now: () => Date;
  private readonly currentVersion: string;
  private readonly executablePath: string;
  private readonly dirty: boolean;
  private readonly releaseCacheMs: number;
  private readonly restartDelayMs: number;
  private release: ReleaseInfo | null = null;
  private checkedAt: Date | null = null;
  private etag: string | null = null;
  private releaseRefresh: Promise<void> | null = null;
  private releaseRefreshForced = false;
  private installation: Installation | null = null;
  private operation: Promise<void> | null = null;
  private starting = false;
  private state: UpdateState | null = null;
  private message: string | null = null;
  private target: ReleaseInfo | null = null;

  constructor(options: UpdateManagerOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.run = options.run ?? runCommand;
    this.detector = options.detectInstallation ?? detectInstallation;
    this.restart = options.restart ?? (() => process.kill(process.pid, "SIGTERM"));
    this.now = options.now ?? (() => new Date());
    this.currentVersion = options.currentVersion ?? VERSION;
    this.executablePath = options.executablePath ?? process.execPath;
    this.dirty = options.dirty ?? BUILD_DIRTY;
    this.releaseCacheMs = options.releaseCacheMs ?? RELEASE_CACHE_MS;
    this.restartDelayMs = options.restartDelayMs ?? RESTART_DELAY_MS;
  }

  private status(installation: Installation): UpdateStatus {
    const release = this.target ?? this.release;
    const available = release !== null && compareVersions(release.version, this.currentVersion) > 0;
    const canAutoUpdate = !this.dirty && installation.supervised && installation.method !== "unsupported";
    const state =
      this.state ??
      (this.checkedAt === null
        ? "unavailable"
        : available
          ? "available"
          : "up-to-date");
    const message =
      this.message ??
      (available && !canAutoUpdate
        ? installation.reason ?? "this installation must be updated manually"
        : null);
    return {
      currentVersion: this.currentVersion,
      currentApiProtocolVersion: API_PROTOCOL_VERSION,
      latestVersion: release?.version ?? null,
      latestApiProtocolVersion: release?.apiProtocolVersion ?? null,
      state,
      installMethod: installation.method,
      canAutoUpdate,
      message,
      checkedAt: this.checkedAt?.toISOString() ?? null,
    };
  }

  private detectedInstallation(): Installation {
    this.installation ??= this.detector();
    return this.installation;
  }

  private async performReleaseRefresh(force: boolean): Promise<void> {
    const now = this.now();
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": `wisp/${this.currentVersion}`,
    };
    if (force) {
      headers["cache-control"] = "no-cache";
      headers.pragma = "no-cache";
    } else if (this.etag) {
      headers["if-none-match"] = this.etag;
    }
    const url = force
      ? `${DAEMON_CHANNEL_URL}?refresh=${now.getTime()}`
      : DAEMON_CHANNEL_URL;
    const response = await this.fetcher(url, {
      cache: force ? "no-store" : "default",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 304) {
      this.checkedAt = now;
      return;
    }
    if (!response.ok) throw new Error(`daemon update channel returned ${response.status}`);
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_CHANNEL_BYTES) {
      throw new Error("daemon update channel is too large");
    }
    let channel: unknown;
    try {
      channel = JSON.parse(body);
    } catch {
      throw new Error("daemon update channel is not valid JSON");
    }
    const release = parseDaemonUpdateChannel(channel);
    this.release =
      compareVersions(release.version, this.currentVersion) >= 0 ? release : null;
    this.checkedAt = now;
    this.etag = response.headers.get("etag");
  }

  private async fetchLatest(force: boolean): Promise<void> {
    const now = this.now();
    if (!force && this.checkedAt && now.getTime() - this.checkedAt.getTime() < this.releaseCacheMs) return;
    for (;;) {
      if (this.releaseRefresh) {
        const pending = this.releaseRefresh;
        const satisfiesRequest = !force || this.releaseRefreshForced;
        await pending;
        if (satisfiesRequest) return;
        continue;
      }
      this.releaseRefreshForced = force;
      const refresh = this.performReleaseRefresh(force);
      this.releaseRefresh = refresh;
      try {
        await refresh;
        return;
      } finally {
        if (this.releaseRefresh === refresh) {
          this.releaseRefresh = null;
          this.releaseRefreshForced = false;
        }
      }
    }
  }

  private async readStatus(force: boolean): Promise<UpdateStatus> {
    if (this.operation) return this.status(this.detectedInstallation());
    try {
      await this.fetchLatest(force);
      if (this.state === "unavailable") {
        this.state = null;
        this.message = null;
      }
    } catch (error) {
      this.state = "unavailable";
      this.message = `could not check for updates: ${error instanceof Error ? error.message : String(error)}`;
    }
    return this.status(this.detectedInstallation());
  }

  async getStatus(): Promise<UpdateStatus> {
    return this.readStatus(false);
  }

  /** An explicit person-initiated check bypasses the normal release cache. */
  async refreshStatus(): Promise<UpdateStatus> {
    return this.readStatus(true);
  }

  async start(expectedVersion: unknown): Promise<UpdateStatus> {
    if (this.operation || this.starting || this.state === "restarting") {
      throw new Error("an update is already in progress");
    }
    if (typeof expectedVersion !== "string" || !isReleaseVersion(expectedVersion)) {
      throw new Error("version must name a complete Wisp release");
    }
    this.starting = true;
    try {
      try {
        await this.fetchLatest(true);
      } catch (error) {
        throw new Error(`could not refresh releases: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
      if (!this.release || compareVersions(this.release.version, this.currentVersion) <= 0) {
        throw new Error("Wisp is already up to date");
      }
      if (this.release.version !== expectedVersion) {
        throw new Error(`latest release changed to ${this.release.version}; review it before updating`);
      }
      const installation = this.detectedInstallation();
      if (this.dirty) throw new Error("dirty builds cannot update themselves");
      if (installation.method === "unsupported" || !installation.supervised) {
        throw new Error(installation.reason ?? "this installation cannot update automatically");
      }
      this.target = this.release;
      this.state = "installing";
      this.message = null;
      this.operation = this.installAndRestart(installation, this.target).finally(() => {
        this.operation = null;
      });
      return this.status(installation);
    } finally {
      this.starting = false;
    }
  }

  private async installAndRestart(installation: Installation, release: ReleaseInfo): Promise<void> {
    try {
      if (installation.method === "homebrew") await this.installHomebrew(release);
      else if (installation.method === "managed-linux" && installation.installRoot) {
        await this.installLinux(release, installation.installRoot);
      } else {
        throw new Error("the installation changed before the update started");
      }
      this.state = "restarting";
      this.message = null;
      await Bun.sleep(this.restartDelayMs);
      this.restart();
    } catch (error) {
      this.state = "failed";
      this.message = `update failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async installHomebrew(release: ReleaseInfo): Promise<void> {
    const update = await this.run(["brew", "update"]);
    if (update.exitCode !== 0) throw commandFailure(["brew", "update"], update);
    const upgradeCommand = ["brew", "upgrade", "Pepewitch/tap/wisp"];
    const upgrade = await this.run(upgradeCommand);
    if (upgrade.exitCode !== 0) throw commandFailure(upgradeCommand, upgrade);
    const installed = await this.run(["brew", "--prefix", "wisp"]);
    if (installed.exitCode !== 0) throw commandFailure(["brew", "--prefix", "wisp"], installed);
    const versionCommand = [resolve(installed.stdout, "bin/wisp"), "version", "--json"];
    const identity = await this.run(versionCommand);
    if (identity.exitCode !== 0) throw commandFailure(versionCommand, identity);
    const body = JSON.parse(identity.stdout) as { version?: unknown; dirty?: unknown };
    if (body.version !== release.version || body.dirty !== false) {
      throw new Error(`Homebrew installed ${String(body.version)}, expected ${release.version}`);
    }
  }

  private async installLinux(release: ReleaseInfo, installRoot: string): Promise<void> {
    const manifestUrl = `${RELEASE_URL}/${release.tag}/release-manifest.json`;
    const manifestResponse = await this.fetcher(manifestUrl, { signal: AbortSignal.timeout(20_000) });
    if (!manifestResponse.ok) throw new Error(`release manifest returned ${manifestResponse.status}`);
    const manifest = (await manifestResponse.json()) as unknown;
    validateLinuxManifest(manifest, release);

    const versionDir = join(installRoot, "versions", release.version);
    const binary = join(versionDir, "wisp");
    const candidate = join(versionDir, `.wisp.installing.${process.pid}`);
    const current = join(installRoot, "current");
    const next = join(installRoot, `.current.update.${process.pid}`);
    const marker = join(installRoot, ".managed-by-wisp");
    if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== MANAGED_INSTALL_MARKER) {
      throw new Error("managed installation marker changed during the update");
    }
    if (
      !existsSync(current) ||
      !lstatSync(current).isSymbolicLink() ||
      realpathSync(current) !== realpathSync(this.executablePath)
    ) {
      throw new Error("managed current path changed during the update");
    }
    await mkdir(versionDir, { recursive: true, mode: 0o700 });
    await rm(candidate, { force: true });
    await rm(next, { force: true });
    try {
      const artifactUrl = `${RELEASE_URL}/${release.tag}/${manifest.artifact.file}`;
      const artifactResponse = await this.fetcher(artifactUrl, { signal: AbortSignal.timeout(120_000) });
      if (!artifactResponse.ok) throw new Error(`release artifact returned ${artifactResponse.status}`);
      await downloadVerifiedArtifact(
        artifactResponse,
        candidate,
        manifest.artifact.size,
        manifest.artifact.sha256,
      );
      await chmod(candidate, 0o755);
      const identityCommand = [candidate, "version", "--json"];
      const identity = await this.run(identityCommand);
      if (identity.exitCode !== 0) throw commandFailure(identityCommand, identity);
      const body = JSON.parse(identity.stdout) as { version?: unknown; commit?: unknown; dirty?: unknown };
      if (body.version !== release.version || body.commit !== manifest.commit || body.dirty !== false) {
        throw new Error("downloaded artifact identity does not match its release manifest");
      }
      if (existsSync(binary)) {
        const existing = await this.run([binary, "version", "--json"]);
        if (existing.exitCode !== 0 || existing.stdout !== identity.stdout) {
          throw new Error(`refusing to replace an existing ${release.version} installation`);
        }
        await rm(candidate, { force: true });
      } else {
        await rename(candidate, binary);
      }
      if (
        !lstatSync(current).isSymbolicLink() ||
        realpathSync(current) !== realpathSync(this.executablePath)
      ) {
        throw new Error("managed current path changed during the update");
      }
      await symlink(binary, next);
      await rename(next, current);
    } finally {
      await rm(candidate, { force: true });
      await rm(next, { force: true });
    }
  }
}
