/**
 * The app's one relative clock.
 *
 * dayjs owns the arithmetic and the thresholds; we own the vocabulary. Wisp's
 * voice is terse, so the English locale is rewritten rather than accepting
 * "5 minutes ago" / "a day ago", and the suffix is a function so "just now"
 * is never read back as "just now ago".
 *
 * Thresholds FLOOR rather than round: 90 minutes is "1h ago", never "2h ago".
 * A clock that rounds up overstates work you just watched happen.
 */
import dayjs from "dayjs"
import relativeTime from "dayjs/plugin/relativeTime"
import updateLocale from "dayjs/plugin/updateLocale"
import utc from "dayjs/plugin/utc"

const JUST_NOW = "just now"

dayjs.extend(utc)
dayjs.extend(updateLocale)
dayjs.extend(relativeTime, {
  rounding: Math.floor,
  // A row without `d` reuses the unit measured by the row above it, which is
  // how each unit gets its own "1x" wording without a plural rule.
  thresholds: [
    { l: "s", r: 59, d: "second" },
    { l: "m", r: 119 },
    { l: "mm", r: 59, d: "minute" },
    { l: "h", r: 119 },
    { l: "hh", r: 23, d: "hour" },
    { l: "d", r: 47 },
    { l: "dd", r: 29, d: "day" },
    { l: "M", r: 59 },
    { l: "MM", r: 11, d: "month" },
    { l: "y", r: 23 },
    { l: "yy", d: "year" },
  ],
})

dayjs.updateLocale("en", {
  relativeTime: {
    future: (out: string) => (out === JUST_NOW ? out : `in ${out}`),
    past: (out: string) => (out === JUST_NOW ? out : `${out} ago`),
    s: JUST_NOW,
    m: "1 min",
    mm: "%d min",
    h: "1h",
    hh: "%dh",
    d: "1d",
    dd: "%dd",
    M: "1mo",
    MM: "%dmo",
    y: "1y",
    yy: "%dy",
  },
})

/**
 * "just now" / "5 min ago" / "3h ago" / "2d ago" — an instant read against the
 * present. `now` is a parameter rather than a `Date.now()` call so a caller
 * owning the tick (`useTick`) hands every reader the same instant, and so this
 * is testable without faking the clock. `""` for an instant we cannot parse.
 */
export function fromNow(iso: string, now: number = Date.now()): string {
  const at = dayjs(iso)
  return at.isValid() ? at.from(now) : ""
}

/**
 * The same instant said exactly: `2026-09-06T12:34:56Z`. UTC because the point
 * of asking is to match it against a log line, and milliseconds because
 * nothing a person reads needs them — so they are dropped.
 */
export function utcIso(iso: string): string {
  const at = dayjs(iso)
  return at.isValid() ? at.utc().format("YYYY-MM-DDTHH:mm:ss[Z]") : ""
}
