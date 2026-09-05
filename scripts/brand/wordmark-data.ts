/**
 * The word "Wisp" set in Geist 600, converted to outlines.
 *
 * The product is written **Wisp**. The command, the config directory, the branch
 * prefix and the package name stay lowercase `wisp`, because those are literal
 * data rather than the name — skills/wisp-dev/references/frontend.md §3 applied to the brand.
 *
 * Committed as path data ON PURPOSE. The alternative — reading the woff2 at
 * build time — would put a font toolchain (woff2 decompression plus a glyph
 * outliner) in the dependency graph of a logo that changes approximately never,
 * and this repo has zero npm runtime deps. Outlines also mean the README logo
 * renders identically on GitHub, which does not load our webfont.
 *
 * Provenance — regenerate only if the wordmark itself changes:
 *   bun add fontkit wawoff2   # dev-only, in a scratch dir
 *   woff2.decompress(web/ui/node_modules/@fontsource-variable/geist/files/
 *                    geist-latin-wght-normal.woff2)  ->  geist-latin.ttf
 *   fontkit.openSync(ttf).getVariation({ wght: 600 }).layout("Wisp")
 *   then glyph.path.toSVG() per glyph, with the pen x from run.positions.
 *
 * Coordinates are font units in a 1000-unit em, y UP from the baseline.
 * Geist is OFL 1.1; the licence text already rides along in web/ui/licenses/.
 */

/** Units per em of the source font — every coordinate below is in these units. */
export const UPEM = 1000;

/**
 * Vertical metrics of Geist 600, for aligning the mark to the wordmark.
 *
 * `capHeight` is the load-bearing one now that the word starts with a capital:
 * the mark centres on the cap band rather than the x-height band. The dot on the
 * i tops out at 719, nine units above the W, which is close enough that the two
 * read as a single line.
 */
export const METRICS = {
  xHeight: 534,
  capHeight: 710,
  /** top of the dot on the i — the tallest ink in "Wisp", barely */
  iDotTop: 719,
  /** bottom of the descender on the p */
  descender: -150,
} as const;

export type Glyph = {
  char: string;
  /** pen position of this glyph, font units from the start of the word */
  x: number;
  advance: number;
  minX: number; maxX: number; minY: number; maxY: number;
  d: string;
};

/** Total advance width of "Wisp" before tracking, in font units. */
export const ADVANCE = 2389.2;

export const GLYPHS: Glyph[] = [
  { char: "W", x: 0, advance: 966.1999999999999, minX: 37, maxX: 954, minY: 0, maxY: 710,
    d: "M227 0L37 710L174 710L304 180L435 710L556 710L687 180L816 710L954 710L764 0L620 0L496 486L372 0Z" },
  { char: "i", x: 966.1999999999999, advance: 258.8, minX: 68, maxX: 201, minY: 0, maxY: 719,
    d: "M70 0L70 534L198 534L198 0ZM68 605L68 719L201 719L201 605Z" },
  { char: "s", x: 1225, advance: 543.2, minX: 39, maxX: 514, minY: -12, maxY: 546,
    d: "M287 -12Q206 -12 152.5 11Q99 34 71 75Q43 116 39 168L170 174Q177 132 204 109Q231 86 288 86Q333 86 356.5 100.5Q380 115 380 146Q380 164 371.5 176Q363 188 338.5 197Q314 206 267 215Q186 229 140 249.5Q94 270 75.5 301Q57 332 57 378Q57 453 114.5 499.5Q172 546 283 546Q360 546 409.5 521.5Q459 497 484.5 456.5Q510 416 514 366L384 360Q383 385 372 405Q361 425 339 436.5Q317 448 281 448Q236 448 212.5 430Q189 412 189 382Q189 361 198.5 347Q208 333 231 324.5Q254 316 294 309Q376 297 424 276Q472 255 492.5 223.5Q513 192 513 148Q513 71 451.5 29.5Q390 -12 287 -12Z" },
  { char: "p", x: 1768.2, advance: 621, minX: 70, maxX: 582, minY: -150, maxY: 546,
    d: "M70 -150L70 534L193 534L196 420L183 426Q203 485 248.5 515.5Q294 546 355 546Q431 546 481.5 508Q532 470 557 407Q582 344 582 267Q582 190 556.5 127Q531 64 480.5 26Q430 -12 354 -12Q314 -12 279.5 2Q245 16 220.5 42Q196 68 186 103L198 113L198 -150ZM324 92Q382 92 415.5 138.5Q449 185 449 267Q449 349 415.5 395.5Q382 442 324 442Q285 442 257 422.5Q229 403 213.5 364Q198 325 198 267Q198 209 213 170Q228 131 256.5 111.5Q285 92 324 92Z" },
];
