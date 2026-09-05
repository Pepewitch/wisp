import { formatTokens } from "@/lib/format";
import type { Turn, UsageSummary } from "@/lib/types";

const USAGE_FIELDS = [
  { key: "inputTokens", label: "in" },
  { key: "outputTokens", label: "out" },
  { key: "cachedInputTokens", label: "cached" },
  { key: "cacheWriteTokens", label: "cache write" },
  { key: "reasoningTokens", label: "reasoning", omitZero: true },
] as const satisfies readonly {
  key: keyof UsageSummary;
  label: string;
  omitZero?: boolean;
}[];

/** A missing report is not a zero-token turn. */
export function reportedUsageTurns(turns: Turn[] | undefined): (Turn & { usage: UsageSummary })[] {
  return (turns ?? []).filter((turn): turn is Turn & { usage: UsageSummary } => turn.usage !== null);
}

/** Compact field labels in the one canonical display order. */
export function usageParts(usage: UsageSummary): string[] {
  const parts: string[] = [];
  for (const field of USAGE_FIELDS) {
    const value = usage[field.key];
    if (value === undefined || ("omitZero" in field && field.omitZero && value === 0)) continue;
    parts.push(`${formatTokens(value)} ${field.label}`);
  }
  return parts;
}

/** Sum only fields at least one turn actually reported. */
export function totalUsage(usages: UsageSummary[]): UsageSummary {
  const total: UsageSummary = {};
  for (const usage of usages) {
    for (const { key } of USAGE_FIELDS) {
      const value = usage[key];
      if (value !== undefined) total[key] = (total[key] ?? 0) + value;
    }
  }
  return total;
}
