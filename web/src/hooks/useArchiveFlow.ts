import { useState } from "react";

import { useArchiveTask } from "@/hooks/mutations";
import { failureReason } from "@/lib/api";
import type { ApiTask } from "@/lib/types";

/**
 * Archive, once, for the three places that offer it: the overflow menu, the
 * sidebar row's hover control (D2) and the `/archive` command.
 *
 * The shape is the whole point. The first attempt is ALWAYS unforced, because
 * the daemon's 409 names what is unsaved and what the remedies are — and that
 * sentence is the confirm dialog's entire value. A generic "are you sure?"
 * would throw away the one thing the user needs in order to decide, so
 * `reason` is the daemon's own words and `ArchiveConfirmDialog`
 * (components/archive-flow.tsx) renders them verbatim.
 *
 * It lives in hooks/ rather than beside that dialog because a `.tsx` file may
 * only export components (the react-refresh rule this repo lints as an error),
 * and a hook is not one.
 */
export interface ArchiveFlow {
  /** unforced first, always; `true` is what the dialog's confirm sends */
  request: (force: boolean) => void;
  /** the daemon's refusal, or null when there is nothing to decide */
  reason: string | null;
  pending: boolean;
  dismiss: () => void;
}

export function useArchiveFlow(task: ApiTask | null): ArchiveFlow {
  const archiveTask = useArchiveTask();
  const [reason, setReason] = useState<string | null>(null);

  return {
    request: (force: boolean) => {
      if (!task) return;
      archiveTask.mutate(
        { id: task.id, force },
        {
          onSuccess: () => setReason(null),
          // a 409 is the expected refusal; anything else is a real error, and
          // both are the same decision from here — the daemon said no and said why
          onError: (e) => setReason(failureReason(e)),
        },
      );
    },
    reason,
    pending: archiveTask.isPending,
    dismiss: () => setReason(null),
  };
}
