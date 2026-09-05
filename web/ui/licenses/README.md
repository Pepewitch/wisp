# Font licenses

The design language (`skills/wisp-dev/references/frontend.md`) is Geist:
**Geist Sans** for UI
chrome and generated prose, **Geist Mono** for code, diffs, paths, and
terminal-ish data.

Both fonts ship as woff2 via the bundler-importable fontsource variable
packages (`@fontsource-variable/geist`, `@fontsource-variable/geist-mono`) —
vite inlines them into the committed single-file bundle
(`web/ui-dist/index.html`), preserving the zero-CDN invariant. Their
`@font-face` rules use `font-display: swap`.

Geist is published by Vercel under the SIL Open Font License 1.1. The full
license text rides along in `geist.OFL-1.1.txt` (copied verbatim from the
packages' `LICENSE` files; the Geist Sans and Geist Mono texts are identical
modulo the font filename in the copyright line).

## Terminal emulator (S3.5)

The terminal tab bundles `@xterm/xterm` and `@xterm/addon-fit` from npm —
vite inlines them into the committed single-file bundle, so the zero-CDN
invariant holds. Both packages are published by the xterm.js authors under
the MIT license; the full license text rides along in `xterm.MIT.txt` (copied
verbatim from the packages' `LICENSE` files).
