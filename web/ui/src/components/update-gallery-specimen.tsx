import { Gear, ZoomIn } from "@/components/icons"
import { UpdateCenter } from "@/components/update-control"
import { Button, Eyebrow, Rule } from "@/components/primitives"
import { ConnStatus } from "@/components/conn-indicator"
import { UPDATE_SPECIMEN } from "@/components/gallery-fixtures"
import type { DesktopUpdaterContextValue } from "@/lib/desktop-updater"
import type { UpdateStatus } from "@/lib/types"

const DESKTOP: DesktopUpdaterContextValue = {
  status: {
    channel: "alpha",
    configured: true,
    currentVersion: "0.4.0-alpha.8",
    latestVersion: "0.4.0-alpha.9",
    phase: "available",
    releaseNotes:
      "Signed, notarized application update with updater verification.",
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
  install: async () => undefined,
  relaunch: async () => undefined,
  setCheckAfterLaunch: () => undefined,
}

/** Nothing to install: the trigger with no dot at all. */
const DESKTOP_IDLE: DesktopUpdaterContextValue = {
  ...DESKTOP,
  status: { ...DESKTOP.status!, latestVersion: null, phase: "up-to-date" },
}

const DAEMON_IDLE: UpdateStatus = {
  ...UPDATE_SPECIMEN,
  latestVersion: null,
  state: "up-to-date",
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
          onUpdateDesktop={() => undefined}
          onUpdateDaemon={() => undefined}
          defaultOpen
        />
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
        Desktop is global; the daemon row follows the selected connection. Their
        actions, progress, failures, and versions never collapse into one
        ambiguous update button.
      </p>
    </section>
  )
}

/**
 * The top bar's right end, which is ONE cluster: what the app is doing, then
 * everything you can do TO it, 4px apart against the header's 10px (§5h).
 *
 * The update trigger is the real component in its three readings, because the
 * dot is the whole point of an icon-only trigger. Zoom and the gear are
 * stand-ins — the live zoom control needs the native bridge and the gallery has
 * no settings modal to open — the same way the connection specimen stands in
 * for its tabs.
 */
export function HeaderClusterSpecimen() {
  const readings = [
    { label: "Nothing waiting", desktop: DESKTOP_IDLE, daemon: DAEMON_IDLE, error: null },
    { label: "Two updates · amber", desktop: DESKTOP, daemon: UPDATE_SPECIMEN, error: null },
    {
      label: "One failed · destructive",
      desktop: DESKTOP_IDLE,
      daemon: UPDATE_SPECIMEN,
      error: "Homebrew exited 1",
    },
  ]
  return (
    <section className="mt-9">
      <div className="mb-4 flex items-center gap-3">
        <Eyebrow>The top bar's right end — one cluster, and a dot for the count</Eyebrow>
        <Rule />
      </div>
      <div className="space-y-3">
        {readings.map((reading) => (
          <div key={reading.label}>
            <Eyebrow>{reading.label}</Eyebrow>
            <div className="mt-2 flex h-9 items-center gap-2.5 rounded-lg border border-border bg-surface px-3">
              <span className="flex-1 text-[11.5px] text-faint">the header, from its middle out</span>
              <ConnStatus live />
              <div className="flex shrink-0 items-center gap-1">
                <UpdateCenter
                  desktop={reading.desktop}
                  daemonStatus={reading.daemon}
                  daemonError={reading.error}
                  daemonOperation={null}
                  connectionId="local"
                  connectionName="Local"
                  supportedApiProtocols={[1]}
                  onUpdateDesktop={() => undefined}
                  onUpdateDaemon={() => undefined}
                />
                <Button size="sm" icon aria-label="Zoom, 100%">
                  <ZoomIn />
                </Button>
                <Button size="sm" icon aria-label="Settings">
                  <Gear />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3">
        <Eyebrow>The drawer footer on touch · no top bar to carry it</Eyebrow>
        <div className="mt-2 flex items-center justify-end gap-1 rounded-lg border border-border bg-sidebar px-2 py-1.5">
          <span className="flex-1 text-[11.5px] text-faint">…show archived</span>
          <UpdateCenter
            desktop={DESKTOP}
            daemonStatus={UPDATE_SPECIMEN}
            daemonError={null}
            daemonOperation={null}
            connectionId="local"
            connectionName="Local"
            supportedApiProtocols={[1]}
            onUpdateDesktop={() => undefined}
            onUpdateDaemon={() => undefined}
            mobile
          />
          <Button size="lg" icon aria-label="Settings, touch">
            <Gear />
          </Button>
        </div>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
        Updates used to sit at the LEFT end, hard against the connection tabs: app news in the corner that answers
        "which daemon am I on", and the only labelled button in a bar of icons. It is a download glyph now, its count
        is a 6px dot — amber for an update waiting on you, destructive for one that failed — and its accessible name
        carries what the dot cannot say. The gear stays last, because the gear is the corner (§5g). On touch the
        trigger is the same glyph at the drawer footer's own 32px, so it and the gear beside it are one pair rather
        than a label squeezed to <span className="text-faint">Updat…</span> next to an icon.
      </p>
    </section>
  )
}
