/** Versioned workflow API and executable-plugin contract, shared by all clients. */
export type WorkflowValue = string | number | boolean;
export type WorkflowParams = Record<string, WorkflowValue>;
export interface WorkflowParameter {
  key: string;
  label: string;
  description: string;
  type: "string" | "number" | "boolean";
  default: WorkflowValue;
  required?: boolean;
  multiline?: boolean;
  min?: number;
  max?: number;
}
export interface WorkflowDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  parameters: WorkflowParameter[];
  custom?: boolean;
}
export type WorkflowState = "active" | "paused" | "completed";
export interface Workflow {
  id: string;
  taskId: string;
  type: string;
  version: string;
  params: WorkflowParams;
  state: WorkflowState;
  reason: string;
  revision: number;
  contextN: number;
  wakeCount: number;
  checkCount: number;
  lastCheckedAt: string | null;
  nextCheckAt: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}
export interface WorkflowHistory {
  id: number;
  at: string;
  kind: string;
  detail: string;
  messageId: string | null;
}
export interface WorkflowDetail {
  workflow: Workflow;
  history: WorkflowHistory[];
}
export interface WorkflowDecision {
  action: "wait" | "wake" | "complete" | "pause";
  reason: string;
  checkpoint: Record<string, unknown>;
  /** Stable identity of actionable evidence, not the time it was polled. */
  key?: string;
  message?: string;
}
