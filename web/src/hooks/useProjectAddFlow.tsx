import { useState } from "react"

import {
  AddProjectDialog,
  ProjectPickerErrorDialog,
} from "@/components/project-add-dialogs"
import { useAddProject } from "@/hooks/mutations"
import { useDesktopConnections } from "@/lib/desktop-connections"
import { addPickedLocalProject } from "@/lib/projects"

/**
 * Whose filesystem the typed path is on. The remote sentence is the dialog's
 * own default; the browser needs its own, because the daemon serving the page
 * is very often THIS computer and "not on this computer" would be a lie.
 */
const BROWSER_PATH_HINT =
  "This path is resolved by the Wisp daemon serving this page, not by your browser."

export function useProjectAddFlow() {
  const desktop = useDesktopConnections()
  const addProject = useAddProject()
  const [pathOpen, setPathOpen] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  /**
   * Three clients, two mechanisms. Only Desktop-on-Local has a filesystem this
   * process can show a picker for; a remote tab and the browser both register
   * a path the DAEMON resolves, through the same dialog. The browser used to
   * have neither — a disabled button and a sentence telling you to go and run
   * `wisp project add`, which made the web UI unusable from zero without a
   * terminal, phones included.
   */
  const onAddProject = () => {
    addProject.reset()
    setPickerError(null)
    // The mutation belongs to the initiating provider. A tab switch can
    // unmount it, but cannot retarget a picker completion to a remote.
    if (desktop && desktop.active.metadata.kind === "local") {
      void addPickedLocalProject(
        desktop.pickLocalProject,
        addProject.mutateAsync
      ).catch((error: unknown) =>
        setPickerError(error instanceof Error ? error.message : String(error))
      )
      return
    }
    setPathOpen(true)
  }
  const dialogs = (
    <>
      <AddProjectDialog
        open={pathOpen}
        connectionName={desktop?.active.metadata.name ?? "the daemon host"}
        hint={desktop ? undefined : BROWSER_PATH_HINT}
        pending={addProject.isPending}
        error={addProject.error}
        onClose={() => {
          setPathOpen(false)
          addProject.reset()
        }}
        onSubmit={async (path) => {
          await addProject.mutateAsync(path)
          setPathOpen(false)
        }}
      />
      <ProjectPickerErrorDialog
        error={pickerError}
        onClose={() => setPickerError(null)}
      />
    </>
  )
  return { desktop, onAddProject, pending: addProject.isPending, dialogs }
}
