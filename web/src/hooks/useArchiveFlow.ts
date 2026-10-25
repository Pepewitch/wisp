import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useArchiveTask } from "@/hooks/mutations";
import { failureReason } from "@/lib/api";
import { familyPlan, refusedSubtasks, withConsent, type FamilyConsents, type FamilyMember, type FamilyStep, type RefusedSubtask } from "@/lib/archive-family";
import { autopilotArchiveWords } from "@/lib/autopilot-words";
import { useDaemonRuntime } from "@/lib/runtime";
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
 * (components/archive-flow.tsx) renders them verbatim. The one sentence asked
 * here first is autopilot's, from the task's own status (the daemon asks the
 * same last, for other clients): its confirm consents to that and nothing else.
 *
 * A parent with live subtasks is refused until asked to take them along, and
 * then each child that cannot go as it is gets named (`family`). Taking them,
 * forcing them, and stopping their autopilot are three separate yeses, sent
 * as `subtasks` and `stopAutopilot`, and each one given is kept for the next
 * attempt: the parent's own refusal after them does not undo them.
 *
 * The daemon has one `stopAutopilot` for the whole batch. So a yes to the
 * parent's own autopilot sentence also covers its children's, and the family
 * list says so for each child it reaches ("its autopilot is switched off")
 * before the Archive click that sends it.
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
  /**
   * The reason is that auto-merge / auto-fix is still watching a PR. Its
   * confirm switches them off and waives nothing else: unsaved work or a
   * running turn still gets its own refusal after it.
   */
  stopsAutopilot: boolean;
  /** the parent's subtasks are in the way: every one named, and the one yes asked next */
  family: { members: FamilyMember[]; next: FamilyStep } | null;
  /** the family confirm: gives `family.next` and tries again */
  confirmFamily: () => void;
  pending: boolean;
  dismiss: () => void;
}

const NO_CONSENTS: FamilyConsents = { stopAutopilot: false };

export function useArchiveFlow(task: ApiTask | null): ArchiveFlow {
  const archiveTask = useArchiveTask();
  const client = useQueryClient();
  const { qk } = useDaemonRuntime();
  const [reason, setReason] = useState<string | null>(null);
  const [stopsAutopilot, setStopsAutopilot] = useState(false);
  const [refused, setRefused] = useState<RefusedSubtask[] | null>(null);
  const [consents, setConsents] = useState<FamilyConsents>(NO_CONSENTS);
  const [force, setForce] = useState(false);

  const reset = () => { setReason(null); setStopsAutopilot(false); setRefused(null); setConsents(NO_CONSENTS); setForce(false); };
  const send = (forced: boolean, given: FamilyConsents) => {
    if (!task) return;
    setForce(forced);
    setConsents(given);
    archiveTask.mutate(
      { id: task.id, force: forced, stopAutopilot: given.stopAutopilot, ...(given.subtasks ? { subtasks: given.subtasks } : {}) },
      {
        onSuccess: reset,
        // a 409 is the expected refusal; anything else is a real error, and
        // both are the same decision from here — the daemon said no and said why
        onError: (e) => {
          const children = refusedSubtasks(e);
          setRefused(children);
          setReason(children ? null : failureReason(e));
          setStopsAutopilot(false);
        },
      },
    );
  };
  // read at the moment of asking: the dialog names the family the list shows now
  const family = task && refused
    ? familyPlan(task.id, client.getQueryData<ApiTask[]>(qk.tasksList(false)) ?? [], refused, consents)
    : null;
  return {
    request: (forced: boolean) => {
      if (!task) return;
      // the confirm of the autopilot sentence is that consent alone
      if (forced && stopsAutopilot) return send(force, { ...consents, stopAutopilot: true });
      const autopilot = forced || consents.stopAutopilot ? null : autopilotArchiveWords(task.autopilot);
      if (autopilot) {
        setReason(autopilot);
        setStopsAutopilot(true);
        return;
      }
      send(forced, forced ? consents : NO_CONSENTS);
    },
    reason,
    stopsAutopilot,
    family,
    confirmFamily: () => {
      if (family) send(force, withConsent(consents, family.next));
    },
    pending: archiveTask.isPending,
    dismiss: reset,
  };
}
