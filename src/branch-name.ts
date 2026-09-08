/**
 * Branch names, derived from the task id and nothing else.
 *
 * Branches used to carry a slug of the task title, which is the first 80
 * characters of the user's raw prompt. That put whatever someone typed —
 * "i-am-x-pls-read-the" — onto a ref that shows up in `git branch -a`, in
 * pull requests, and on the shared remote, where it long outlives the moment
 * it was typed. A branch is the most public and least editable name wisp
 * mints, so it is the one name that must not be a copy of the prompt.
 *
 * The id alone would fix that and be unreadable: a column of `wisp/tk9zdy`,
 * `wisp/ta3f9j` is a column of noise you have to decode one at a time. So the
 * id gets a pronounceable tag — `wisp/tk9zdy-gilded-otter` — chosen for how
 * fast a person can find one row again in a list, not for what the task is
 * about. The task title carries the meaning, and unlike a branch it can be
 * renamed at any time.
 *
 * The tag is a pure function of the id, never random. Two consequences worth
 * relying on: the same task always names the same branch (no state to store,
 * nothing to keep in sync with the database), and the words add no collision
 * surface of their own — ids are already unique, so branches stay unique even
 * when two of them land on `gilded-otter`.
 */

/**
 * FNV-1a, 32-bit, written out rather than reached for from a library.
 *
 * The mapping from id to words is a naming decision that shows up in git
 * history forever; pinning it to code in this repo means a Bun or dependency
 * upgrade can never quietly rename what the next branch would have been.
 * `Math.imul` keeps the multiply in 32-bit territory — a plain `*` overflows
 * into float precision and stops being FNV after a few characters.
 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * 64 adjectives × 64 nouns = 4096 tags.
 *
 * Both lists are powers of two so the two picks read distinct bit ranges of
 * one hash without modulo bias. They are deliberately plain — concrete,
 * short, unambiguous to spell out loud — because the whole job of a tag is to
 * be recognized at a glance in a list of refs.
 */
const ADJECTIVES = [
  "amber", "ancient", "bold", "brave", "brisk", "bronze", "calm", "clever",
  "cobalt", "coral", "cosmic", "crimson", "crisp", "curious", "dapper", "deft",
  "eager", "fabled", "fleet", "gentle", "gilded", "golden", "hardy", "hidden",
  "humble", "ivory", "jade", "jolly", "keen", "lively", "lucid", "lunar",
  "mellow", "merry", "mighty", "misty", "noble", "olive", "patient", "placid",
  "plucky", "polar", "quiet", "rapid", "rosy", "rugged", "russet", "sage",
  "scarlet", "silent", "silver", "sleepy", "solar", "spry", "stout", "sunny",
  "swift", "tidy", "valiant", "velvet", "vivid", "wistful", "witty", "zesty",
] as const;

const NOUNS = [
  "otter", "badger", "falcon", "heron", "marten", "lynx", "ibex", "tapir",
  "gecko", "wren", "finch", "raven", "magpie", "puffin", "osprey", "walrus",
  "narwhal", "seal", "dolphin", "manatee", "beaver", "marmot", "ferret", "weasel",
  "stoat", "lemur", "gibbon", "macaw", "toucan", "kestrel", "harrier", "plover",
  "curlew", "snipe", "egret", "stork", "crane", "bison", "moose", "elk",
  "caribou", "vicuna", "alpaca", "okapi", "kudu", "oryx", "gazelle", "jackal",
  "dingo", "quokka", "wombat", "numbat", "possum", "pangolin", "aardvark", "meerkat",
  "mongoose", "civet", "genet", "serval", "caracal", "ocelot", "margay", "jaguar",
] as const;

/** The word half of a branch name, e.g. `gilded-otter`. */
export function branchWords(taskId: string): string {
  const h = fnv1a32(taskId);
  const adjective = ADJECTIVES[h % ADJECTIVES.length]!;
  const noun = NOUNS[(h >>> 6) % NOUNS.length]!;
  return `${adjective}-${noun}`;
}

/** The full ref a worktree task's branch is created under. */
export function branchFor(taskId: string): string {
  return `wisp/${taskId}-${branchWords(taskId)}`;
}

/** Exported for the wordlist invariants the tests assert. */
export const BRANCH_WORDS = { ADJECTIVES, NOUNS } as const;
