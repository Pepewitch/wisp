import { describe, expect, test } from "bun:test";
import { renderDaemonUpdateChannel } from "../scripts/render-daemon-update-channel";
import type { ReleaseManifest } from "../wispd/scripts/release-linux";

function manifest(): ReleaseManifest {
  return {
    schemaVersion: 1,
    product: "wisp",
    version: "0.5.1",
    apiProtocolVersion: 2,
    commit: "a".repeat(40),
    dirty: false,
    target: { os: "linux", arch: "x86_64", libc: "glibc" },
    supportedBaseline: "Ubuntu 24.04 LTS (x86_64)",
    artifact: {
      file: "wisp-v0.5.1-linux-x86_64",
      sha256: "b".repeat(64),
      size: 42,
    },
  };
}

describe("daemon update channel", () => {
  test("renders the promoted version and protocol from verified release metadata", () => {
    expect(
      JSON.parse(
        renderDaemonUpdateChannel(
          manifest(),
          "2026-09-09T12:00:00.000Z",
        ),
      ),
    ).toEqual({
      schemaVersion: 1,
      product: "wisp",
      version: "0.5.1",
      apiProtocolVersion: 2,
      publishedAt: "2026-09-09T12:00:00.000Z",
    });
  });

  test("rejects an invalid manifest or publication time", () => {
    const wrongArtifact = manifest();
    wrongArtifact.artifact.file = "another-file";
    expect(() =>
      renderDaemonUpdateChannel(
        wrongArtifact,
        "2026-09-09T12:00:00.000Z",
      ),
    ).toThrow("not a valid Wisp daemon release");
    expect(() =>
      renderDaemonUpdateChannel(manifest(), "not-a-date"),
    ).toThrow("invalid publication time");
    expect(() => renderDaemonUpdateChannel(manifest(), null)).toThrow(
      "invalid publication time",
    );
  });
});
