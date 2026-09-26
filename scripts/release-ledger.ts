// The qualification ledger (docs/v<major>.<minor>/QUALIFICATION.md) is the
// public record of what each release proved. Every publication entry has the
// same shape, so release:closeout writes the mechanical parts from the release
// workflow and the promotion receipt, and leaves TODO markers only where
// judgment is needed. Each edit to existing text is a targeted replacement;
// when the expected wording is missing, the edit becomes a TODO (which
// docs:check refuses) instead of a silent skip that would leave two releases
// both claiming to be the latest.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPOSITORY, TAP_REPOSITORY, ledgerPath, minorLine } from "./release-github";

export const LIMITS_HEADING = "Still unqualified or outside scope";
const LIMITS_ANCHOR = "still-unqualified-or-outside-scope";

export interface PublicationFacts {
  version: string;
  previousVersion: string;
  commit: string;
  /** Null when the merge could not be attributed; the entry gets a TODO. */
  pullRequest: number | null;
  /** ISO 8601, from the GitHub release. */
  publishedAt: string;
  prerelease: boolean;
  /** Whether GitHub reports this release as the latest one. */
  latest: boolean;
  releaseRunUrl: string;
  releaseRunAttempt: number;
  /** Set when promotion finished in a separate recovery run. */
  promotionRunUrl: string | null;
  candidateRunUrl: string | null;
  /** Labels of the release PR's passed checks, in SOURCE_CHECK_LABELS order. */
  sourceChecks: string[];
  /** ISO 8601, from the promotion receipt. */
  promotedAt: string;
  tapCommit: string;
  migrations: number[];
  /** What the PNG brand assets are drawn from that changed since the previous release. */
  pngInputChanges: string[];
}

/** Release PR checks named in the ledger, in the order the ledger lists them. */
export const SOURCE_CHECK_LABELS: ReadonlyArray<readonly [check: string, label: string]> = [
  ["test", "test"],
  ["browser-security", "browser-security"],
  ["linux-contract", "Linux-contract"],
  ["supply-chain", "supply-chain"],
  ["update-verifier", "update-verifier"],
  ["public-promotion-dry-run", "public-promotion dry-run"],
];

/**
 * The jobs whose success the gate table describes. If the release workflow's
 * job list changes, the table no longer states what ran, so the closeout
 * refuses to write it until this list and the table are updated together.
 */
export const RELEASE_JOBS = [
  "release-source",
  "release-linux",
  "macos-repro (a)",
  "macos-repro (b)",
  "macos-trusted",
  "publish",
  "promote",
] as const;

export interface LedgerEdit {
  text: string;
  /** Edits that could not be made mechanically, phrased as instructions. */
  manual: string[];
}

/**
 * Greedy word wrap that never starts a line with Markdown block syntax and
 * never breaks a link's text across lines.
 */
export function wrap(paragraph: string, width = 80): string {
  const words = (paragraph.match(/\S*?\[[^\]]*\]\([^)\s]*\)\S*|\S+/g) ?? []).map((word) => word.replace(/\s+/g, " "));
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const opensBlock = /^(?:[#>|=+*-]|\d+[.)]$)/.test(word);
    if (line && line.length + 1 + word.length > width && !opensBlock) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

/** A literal phrase that may be re-wrapped across lines. */
function flexible(phrase: string): string {
  return phrase
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
}

function utcDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function utcTime(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

export function migrationSentence(version: string, previousVersion: string, migrations: readonly number[]): string {
  if (migrations.length === 0) return `${version} adds no database migration.`;
  const noun = migrations.length === 1 ? "migration" : "migrations";
  return (
    `${version} adds database ${noun} ${list(migrations.map(String))}, so a ${previousVersion} daemon ` +
    `cannot reopen a profile that ${version} has opened.`
  );
}

export function renderPublicationSection(facts: PublicationFacts, manual: readonly string[] = []): string {
  const site = `https://github.com/${REPOSITORY}`;
  const published = utcDate(facts.publishedAt);
  const promoted = utcDate(facts.promotedAt);
  const when =
    published === promoted
      ? `**Published and promoted on ${published}.**`
      : `**Published on ${published} and promoted on ${promoted}.**`;
  const standing = facts.prerelease
    ? "a GitHub prerelease (`draft: false`, `prerelease: true`)"
    : `${facts.latest ? "the latest" : "a"} regular GitHub release (\`draft: false\`, \`prerelease: false\`)`;
  const through = facts.pullRequest
    ? `[PR #${facts.pullRequest}](${site}/pull/${facts.pullRequest})`
    : `TODO link the pull request that carried ${facts.commit.slice(0, 7)}`;
  const identity = wrap(
    `[Wisp ${facts.version}](${site}/releases/tag/v${facts.version}) is ${standing}, published at ` +
      `${utcTime(facts.publishedAt)} UTC with ten release assets. The annotated tag resolves to clean main commit ` +
      `[\`${facts.commit}\`](${site}/commit/${facts.commit}), landed through ` +
      `${through}. It carries TODO the two or three changes a ` +
      `user would notice, each linked like ([#123](${site}/pull/123)), and the other changes listed in the ` +
      `release notes since ${facts.previousVersion}.`,
  );

  const run = `[release workflow](${facts.releaseRunUrl})`;
  let outcome: string;
  if (facts.promotionRunUrl) {
    outcome =
      `The ${run} published the release, and its promotion finished in a separate ` +
      `[recovery run](${facts.promotionRunUrl}). TODO say why the first promotion failed and what changed ` +
      "before the recovery. The publication gates passed:";
  } else if (facts.releaseRunAttempt > 1) {
    outcome =
      `The ${run} completed every job successfully on attempt ${facts.releaseRunAttempt}, after TODO name ` +
      "the job that failed first and why rerunning it was safe:";
  } else {
    outcome = `The ${run} completed every job successfully on its first run:`;
  }

  const labels = facts.sourceChecks.length > 0 ? list(facts.sourceChecks) : "TODO the release PR's passed";
  const candidate = facts.candidateRunUrl
    ? `the exact-main [release candidate](${facts.candidateRunUrl})`
    : "TODO link the exact-main release candidate run, which";
  const table = [
    "| Gate | Result |",
    "|---|---|",
    `| Source checks | Release PR ${labels} checks passed; ${candidate} also passed Linux-contract and update-verifier before tagging |`,
    "| Release identity and reproducibility | Clean annotated main tag; full-history Gitleaks; shared UI, Linux daemon, macOS daemon, and two clean unsigned Desktop rebuilds matched byte for byte |",
    "| Linux installation | Published-artifact installer and fixture activation contracts passed |",
    "| macOS trust | Developer ID signing, Apple notarization and staples, and Gatekeeper passed for both the public daemon app and Desktop; daemon entitlement checks, the Desktop updater signature, and altered-archive rejection passed |",
    `| Public assets | All ten assets matched all three checksum sets, and anonymous public downloads of clean tagged commit \`${facts.commit.slice(0, 7)}\` were verified |`,
    "| Homebrew installability | The Formula and Cask were audited offline before publication, and the published Formula was installed the way a user does before the tap advanced |",
  ].join("\n");

  const promotion = [
    `Promotion completed at ${utcTime(facts.promotedAt)} UTC with Homebrew tap commit`,
    `[\`${facts.tapCommit}\`](https://github.com/${TAP_REPOSITORY}/commit/${facts.tapCommit}).`,
    wrap(`The Formula, Cask, daemon update channel, and Desktop update channel all serve ${facts.version}.`),
  ].join("\n");

  // release:check renders the PNGs only when an input changed, and no CI job
  // renders them at all, so the closeout cannot know whether a render passed.
  const png =
    facts.pngInputChanges.length === 0
      ? `No PNG asset or brand-generator input changed since ${facts.previousVersion}, so the PNG assets were not re-rendered.`
      : `TODO ${list(facts.pngInputChanges.map((input) => `\`${input}\``))} changed since ${facts.previousVersion}; ` +
        "say whether release:check rendered and verified the PNG assets.";
  const limits = wrap(
    `${migrationSentence(facts.version, facts.previousVersion, facts.migrations)} ${png} This is a fully automated ` +
      "publication: no maintainer qualification — fresh-install or upgrade receipts, a Desktop updater journey " +
      "across this version, the token-spending harness probes, or the paid evaluator panel — was performed, and " +
      "this record does not claim them. The published assets and release body remain immutable; this ledger " +
      "records the completed outcome separately.",
  );
  const releaseSpecific = wrap(
    "TODO add to the list above any check specific to this release that nobody ran (for example a live run " +
      "of its headline change against the published daemon), then delete this line.",
  );

  return [
    `## ${facts.version} publication`,
    ...manual.map((instruction) => wrap(`TODO ${instruction}`)),
    [when, identity].join("\n"),
    wrap(outcome),
    table,
    promotion,
    limits,
    releaseSpecific,
  ].join("\n\n");
}

function sectionRange(ledger: string, version: string): { start: number; end: number } | null {
  const heading = new RegExp(`^## ${flexible(version)} publication$`, "m").exec(ledger);
  if (!heading) return null;
  const next = ledger.slice(heading.index + heading[0].length).search(/^## /m);
  return { start: heading.index, end: next === -1 ? ledger.length : heading.index + heading[0].length + next };
}

export function recordsVersion(ledger: string, version: string): boolean {
  return sectionRange(ledger, version) !== null;
}

/** Put the new section above every earlier publication, newest first. */
export function insertSection(ledger: string, section: string): string {
  const first = ledger.search(/^## /m);
  if (first === -1) return `${ledger.trimEnd()}\n\n${section}\n`;
  return `${ledger.slice(0, first)}${section}\n\n${ledger.slice(first)}`;
}

/**
 * The previous release's entry keeps its evidence and loses only the claims
 * the new release made false: being the latest, and being what the tap serves.
 */
export function demoteRelease(ledger: string, file: string, previous: string, next: string): LedgerEdit {
  const range = sectionRange(ledger, previous);
  if (!range) {
    return { text: ledger, manual: [`${file} has no "${previous} publication" section to mark as superseded by ${next}; check it by hand, then delete this line.`] };
  }
  let section = ledger.slice(range.start, range.end);
  const manual: string[] = [];
  const latest = /is\s+the(\s+)latest\s+regular\s+GitHub\s+release/;
  if (latest.test(section)) section = section.replace(latest, "is a$1regular GitHub release");
  const serves = new RegExp(`all serve(\\s+)${flexible(previous)}\\.`);
  if (serves.test(section)) {
    section = section.replace(serves, `all served$1${previous} until ${next} was promoted.`);
  } else if (!section.includes(`until ${next} was promoted`)) {
    manual.push(`${file}: say in the ${previous} entry that the tap served ${previous} only until ${next} was promoted, then delete this line.`);
  }
  return { text: ledger.slice(0, range.start) + section + ledger.slice(range.end), manual };
}

/** The intro names the current release; move it from `previous` to `next`. */
export function advanceCurrentRelease(ledger: string, file: string, previous: string, next: string): LedgerEdit {
  const manual: string[] = [];
  let text = ledger;
  const minor = minorLine(next);

  const prepared = new RegExp(
    flexible(`${next} is prepared and not yet published; its publication record lands here after the tag's release workflow completes.`),
  );
  const current = new RegExp(`${flexible(`${previous} is the current release`)}([.;])`);
  if (prepared.test(text)) {
    text = text.replace(prepared, `${next} is the current release.`);
    const until = new RegExp(
      `${flexible("Until then, the tested limits, remaining platform gaps and native dependency advisory scope are those recorded for")}\\s+(\\S+)\\s+under\\s+(\\[${flexible(LIMITS_HEADING)}\\]\\([^)]+\\))\\.`,
    );
    if (until.test(text)) {
      text = text.replace(
        until,
        `The tested limits, remaining platform gaps and native dependency advisory scope\nrecorded for $1 under\n$2\nstill apply to ${next}.`,
      );
    } else {
      manual.push(`${file}: say in the intro which recorded limits still apply to ${next}, then delete this line.`);
    }
  } else if (current.test(text)) {
    text = text.replace(current, (_match, mark: string) =>
      mark === "."
        ? `${next} is the current release; earlier ${minor} records are retained\nbelow.`
        : `${next} is the current release;`,
    );
    const stillApply = new RegExp(`still apply to ${flexible(previous)}\\.`);
    if (stillApply.test(text)) text = text.replace(stillApply, `still apply to ${next}.`);
  } else {
    manual.push(`${file}: name ${next} as the current release in the intro, then delete this line.`);
  }
  return { text, manual };
}

/** A new minor line supersedes the previous ledger's current release. */
export function supersedeLedger(ledger: string, file: string, previous: string, next: string): LedgerEdit {
  const previousMinor = minorLine(previous);
  const minor = minorLine(next);
  const current = new RegExp(
    `${flexible(`${previous} is the current release`)}(;\\s+${flexible(`earlier ${previousMinor} records are retained below`)})?\\.`,
  );
  if (!current.test(ledger)) {
    return { text: ledger, manual: [`${file}: say in the intro that ${next} supersedes ${previous} and link the ${minor} ledger, then delete this line.`] };
  }
  const text = ledger.replace(current, (_match, earlier: string | undefined) =>
    `${previous} was the last ${previousMinor} release; ${next} supersedes it, and its record\n` +
    `is in [the ${minor} ledger](../v${minor}/QUALIFICATION.md).` +
    (earlier ? ` Earlier ${previousMinor} records are\nretained below.` : ""),
  );
  return { text, manual: [] };
}

/** A new minor line's ledger, written with its release notes before tagging. */
export function renderLedgerSkeleton(version: string, previousMinor: string, limitsMinor: string): string {
  const minor = minorLine(version);
  const kind = Number(version.split(".")[0]) < 1 ? "regular pre-1.0 releases" : "regular releases";
  return [
    `# Wisp ${minor} qualification`,
    wrap(
      `This ledger separates release evidence from the version label. The ${minor} releases are ${kind}, not a ` +
        `claim of exhaustive security or platform coverage. ${version} is prepared and not yet published; its ` +
        "publication record lands here after the tag's release workflow completes. " +
        `The ${previousMinor} records remain in [the ${previousMinor} ledger](../v${previousMinor}/QUALIFICATION.md).`,
    ),
    wrap(
      "Until then, the tested limits, remaining platform gaps and native dependency advisory scope are those " +
        `recorded for ${limitsMinor} under [${LIMITS_HEADING}](../v${limitsMinor}/QUALIFICATION.md#${LIMITS_ANCHOR}).`,
    ),
  ].join("\n\n") + "\n";
}

export interface LedgerSource {
  /** A repository file's text, or null when it does not exist. */
  read(path: string): string | null;
  /** Every ledger, for a new minor line's link to the standing limits. */
  ledgers(): Array<{ minor: string; text: string }>;
}

export interface LedgerWrite {
  path: string;
  text: string;
}

/** The ledgers in a checkout: `docs/v<major>.<minor>/QUALIFICATION.md`. */
export function diskLedgers(root: string): LedgerSource {
  return {
    read: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null),
    ledgers: () =>
      readdirSync(join(root, "docs"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^v\d+\.\d+$/.test(entry.name))
        .map((entry) => ({ minor: entry.name.slice(1), path: join(root, "docs", entry.name, "QUALIFICATION.md") }))
        .filter((entry) => existsSync(entry.path))
        .map((entry) => ({ minor: entry.minor, text: readFileSync(entry.path, "utf8") })),
  };
}

/**
 * Every ledger edit one publication needs: its own entry, the intro that names
 * the current release, and the previous entry's claims that are now false.
 * The first release of a minor line also marks the previous ledger superseded.
 */
export function recordPublication(
  source: LedgerSource,
  facts: PublicationFacts,
  instructions: readonly string[] = [],
): { writes: LedgerWrite[]; manual: string[] } {
  const file = ledgerPath(facts.version);
  const previousFile = ledgerPath(facts.previousVersion);
  const manual = [...instructions];
  let text = source.read(file);
  if (text === null) {
    const limits = limitsLedgerMinor(source.ledgers()) ?? minorLine(facts.previousVersion);
    text = renderLedgerSkeleton(facts.version, minorLine(facts.previousVersion), limits);
    manual.push(`${file} did not exist, so the closeout created it; read its introduction, then delete this line.`);
  }
  if (recordsVersion(text, facts.version)) throw new Error(`${file} already records the ${facts.version} publication`);

  const writes: LedgerWrite[] = [];
  const advanced = advanceCurrentRelease(text, file, facts.previousVersion, facts.version);
  text = advanced.text;
  manual.push(...advanced.manual);
  if (previousFile === file) {
    const demoted = demoteRelease(text, file, facts.previousVersion, facts.version);
    text = demoted.text;
    manual.push(...demoted.manual);
  } else {
    const previous = source.read(previousFile);
    if (previous === null) {
      manual.push(`${previousFile} is missing, so nothing says ${facts.version} supersedes ${facts.previousVersion}; check it by hand, then delete this line.`);
    } else {
      const superseded = supersedeLedger(previous, previousFile, facts.previousVersion, facts.version);
      const demoted = demoteRelease(superseded.text, previousFile, facts.previousVersion, facts.version);
      manual.push(...superseded.manual, ...demoted.manual);
      writes.push({ path: previousFile, text: demoted.text });
    }
  }
  writes.unshift({ path: file, text: insertSection(text, renderPublicationSection(facts, manual)) });
  return { writes, manual };
}

/** Every TODO marker in the proposed ledgers, as `path:line: text`. */
export function todoLocations(writes: readonly LedgerWrite[]): string[] {
  return writes.flatMap((write) =>
    write.text.split("\n").flatMap((line, index) => (/\bTODO\b/.test(line) ? [`${write.path}:${index + 1}: ${line.trim()}`] : [])),
  );
}

/** The newest ledger that carries the standing limits section. */
export function limitsLedgerMinor(ledgers: ReadonlyArray<{ minor: string; text: string }>): string | null {
  const carrying = ledgers
    .filter((ledger) => new RegExp(`^## ${flexible(LIMITS_HEADING)}$`, "m").test(ledger.text))
    .map((ledger) => ledger.minor)
    .sort((a, b) => {
      const [aMajor, aMinor] = a.split(".").map(Number);
      const [bMajor, bMinor] = b.split(".").map(Number);
      return aMajor! - bMajor! || aMinor! - bMinor!;
    });
  return carrying.at(-1) ?? null;
}
