const IDENTIFIER = /^[0-9A-Za-z-]+$/;

interface ParsedVersion {
  core: [string, string, string];
  prerelease: string[] | null;
}

function parseVersion(value: string): ParsedVersion | null {
  const match =
    /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return null;
  const core = [match[1]!, match[2]!, match[3]!] as const;
  if (core.some((part) => part.length > 1 && part.startsWith("0"))) return null;
  const prerelease = match[4]?.split(".") ?? null;
  if (
    prerelease?.some(
      (part) =>
        !IDENTIFIER.test(part) ||
        (/^[0-9]+$/.test(part) &&
          part.length > 1 &&
          part.startsWith("0")),
    )
  ) {
    return null;
  }
  return { core: [...core], prerelease };
}

export function isReleaseVersion(value: string): boolean {
  return parseVersion(value) !== null;
}

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/** SemVer precedence without accepting ranges or partial versions. */
export function compareVersions(left: string, right: string): number {
  const parsed = parseVersion(left);
  const other = parseVersion(right);
  if (!parsed || !other) {
    throw new Error(`invalid release version comparison: ${left}, ${right}`);
  }
  for (let index = 0; index < parsed.core.length; index++) {
    const difference = compareNumeric(
      parsed.core[index]!,
      other.core[index]!,
    );
    if (difference !== 0) return difference;
  }
  const leftPre = parsed.prerelease;
  const rightPre = other.prerelease;
  if (leftPre === null || rightPre === null) {
    return leftPre === rightPre ? 0 : leftPre === null ? 1 : -1;
  }
  for (
    let index = 0;
    index < Math.max(leftPre.length, rightPre.length);
    index++
  ) {
    const a = leftPre[index];
    const b = rightPre[index];
    if (a === undefined || b === undefined) {
      return a === b ? 0 : a === undefined ? -1 : 1;
    }
    if (a === b) continue;
    const aNumeric = /^[0-9]+$/.test(a);
    const bNumeric = /^[0-9]+$/.test(b);
    if (aNumeric && bNumeric) return compareNumeric(a, b);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}
