import { isIOS } from "./platform"

/** `scheme:` as RFC 3986 spells it: what makes iOS read text as a URL. */
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/
/** Characters a URL can never hold, so text with one is prose, not a link. */
const NOT_A_BARE_URL = /[\s<>"{}|\\^`]/
const WORD_JOINER = "\u2060"

/**
 * The text to hand iOS so it pastes as itself.
 *
 * iOS offers copied plain text to other apps as a URL too, built with an
 * NSURL parser that (since iOS 17) percent-encodes whatever it cannot accept
 * instead of refusing it. Text that opens with something scheme-shaped —
 * `https://…` followed by instructions, or `Name: Joe` — becomes a "valid"
 * URL, and apps that prefer the URL (Messages, among others) paste
 * `https://…%0A%0A%5BReview%20instruction%5D…`. WebKit only patched the
 * selection-copy path; `navigator.clipboard.writeText` still takes this one.
 *
 * An invisible word joiner in front means the text no longer starts with a
 * scheme, so iOS offers no URL. It goes FIRST rather than before the colon so
 * a leading link stays a working link. A bare URL is left alone: there the
 * URL form is the right one, and nothing in it gets encoded.
 */
export function clipboardSafeText(text: string, ios = isIOS()): string {
  if (!ios || !SCHEME_PREFIX.test(text) || !NOT_A_BARE_URL.test(text)) return text
  return WORD_JOINER + text
}

export function writeClipboardText(text: string): Promise<void> {
  return navigator.clipboard.writeText(clipboardSafeText(text))
}
