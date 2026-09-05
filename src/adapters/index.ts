/**
 * The adapter layer's public surface: exactly the names the rest of wisp
 * imports from "./adapters". Helpers shared between two adapter modules stay
 * out of here — a module that needs one imports it from its module directly.
 */
export type {
  AdapterDef,
  ActivityEvent,
  ActivityStatus,
  CompactCtx,
  CompactResult,
  CompactStrategy,
  ContextBreakdown,
  ErrorStrategy,
  EventFormatter,
  HarnessUsageReport,
  ImageInputStrategy,
  ModelDiscovery,
  ModelDiscoveryFn,
  ModelProbeSpawnFn,
  ParsedTurn,
  ParseStrategy,
  ProbeCommand,
  ProbeCtx,
  ProbeIo,
  ProbeReport,
  ProbeSpawnFn,
  ProbeStrategy,
  RpcFactory,
  RpcSession,
  SkillCtx,
  SkillDiscoveryResult,
  SkillEntry,
  SkillStrategy,
  UsageSummary,
} from "./types";
export { BUILTIN_ADAPTERS } from "./builtins";
export { ACTIVITY_NORMALIZERS, createActivityFormatter } from "./activity";
export { createEventFormatter, EVENT_FORMATTERS, formatEvent } from "./format";
export { PARSE_STRATEGIES, parseOutput } from "./parse";
export { USAGE_FORMATTERS, formatUsage } from "./usage";
export { IMAGE_DELIVERY_STRATEGIES, IMAGE_INPUT_STRATEGIES } from "./images";
export { ERROR_STRATEGIES, errorDetail, isLimitError, isTransientError } from "./errors";
export { buildArgv, buildAttachArgv } from "./argv";
export { loadAdapters, validateAdapters } from "./validate";
export { discoverModels, DROID_MODEL_PROBE_SENTINEL, MODEL_DISCOVERY } from "./discovery";
export { PROBE_STRATEGIES, ProbeError, probeCommands, runProbe } from "./probe";
export { discoverSkills, scanSkillDirs, SKILL_STRATEGIES } from "./skills";
export { COMPACT_STRATEGIES, runCompact } from "./compact";
