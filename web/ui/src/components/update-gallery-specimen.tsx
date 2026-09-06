import { UpdateCenter } from "@/components/update-control"
import { Eyebrow, Rule } from "@/components/primitives"
import { UPDATE_SPECIMEN } from "@/components/gallery-fixtures"
import type { DesktopUpdaterContextValue } from "@/lib/desktop-updater"

const DESKTOP: DesktopUpdaterContextValue = {
  status: {
    channel: "alpha",
    configured: true,
    currentVersion: "0.4.0-alpha.8",
    latestVersion: "0.4.0-alpha.9",
    phase: "available",
    releaseNotes: "Signed, notarized application update with updater verification.",
    publishedAt: "2026-09-06T12:00:00Z",
    checkedAt: "2026-09-06T12:01:00Z",
    downloadedBytes: 0,
    totalBytes: 42_000_000,
    message: null,
  },
  pending: false,
  error: null,
  checkAfterLaunch: true,
  check: async () => undefined,
  installAndRelaunch: async () => undefined,
  relaunch: async () => undefined,
  setCheckAfterLaunch: () => undefined,
}

export function UpdateGallerySpecimen() {
  return (
    <section className="mt-9">
      <div className="mb-4 flex items-center gap-3">
        <Eyebrow>Updates — one indicator, two explicit owners</Eyebrow>
        <Rule />
      </div>
      <div className="flex min-h-[330px] justify-end rounded-xl border border-border bg-surface p-5">
        <UpdateCenter
          desktop={DESKTOP}
          daemonStatus={UPDATE_SPECIMEN}
          daemonError={null}
          daemonOperation={null}
          connectionId="local"
          connectionName="Local"
          supportedApiProtocols={[1]}
          onUpdateDaemon={() => undefined}
          defaultOpen
        />
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
        Desktop is global; the daemon row follows the selected connection.
        Their actions, progress, failures, and versions never collapse into one
        ambiguous update button.
      </p>
    </section>
  )
}
