/** Every tool the top bar can open into the tool panel, in the bar's order. */
export const TOOL_NAMES = ["terminal", "changes", "autopilot", "subtasks", "workflows"] as const
export type ToolName = (typeof TOOL_NAMES)[number]
/** The tools that take the panel's one slot. The Terminal docks below whichever of them is open. */
export type PanelTool = Exclude<ToolName, "terminal">

/**
 * The tools this daemon offers, from its features: Terminal and Changes
 * always, the rest only where the daemon has them. Null while the features
 * have not answered — "unknown", which is not the same as "none".
 */
export function availableTools(
  features: { taskAutopilot?: boolean; subtasks?: boolean; taskWorkflows?: boolean } | undefined,
  failed: boolean,
): ToolName[] | null {
  if (!features) return failed ? ["terminal", "changes"] : null
  return TOOL_NAMES.filter(
    (name) =>
      (name !== "autopilot" || features.taskAutopilot === true) &&
      (name !== "subtasks" || features.subtasks === true) &&
      (name !== "workflows" || features.taskWorkflows === true),
  )
}
