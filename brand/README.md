# brand

Every asset here is **generated** except the 3D source art in `source/`. Do not
hand-edit generated assets; edit the generator and re-run it:

```
bun run brand            # rewrite brand/ and the app's favicon
bun run brand:check      # fail if anything is stale (what CI runs)
```

The generator lives in [`scripts/brand/`](../scripts/brand/):

| file | what it owns |
|---|---|
| `mark.ts` | S1, the spirit's silhouette and face: the flat mark, the favicon, the vector spirit and the lockup |
| `cli-icon.ts` | the Finder icon for a `wisp` binary, emitted as PDF without a rasteriser |
| `wordmark-data.ts` | "Wisp" in Geist 600, converted to outlines once |
| `build.ts` | writes this directory; composes the PNGs from `source/` with Chrome |

## The name

The product is **Wisp**. The command, the config directory, the branch prefix and
every filename in here stay lowercase `wisp`, because those are literal data
rather than the name — `skills/wisp-dev/references/frontend.md` §3 applied to the brand itself.

(Where this file says "the wisp" in lower case, it means the common noun: a
will-o'-the-wisp, the thing the mark is a picture of.)

## The idea

**Start the work. Wisp follows through.**

Wisp is a companion that carries the work on while you get on with yours, so
the mark is the thing its name is: a will-o'-the-wisp, a small flame spirit lit
from inside. The old mark held that flame in a violet glass icosahedron. This
one lets it out.

It has a face because it is a companion, and only two eyes because a calm face
is the whole personality.

## The character

Six rules. The character sheet that shows them is internal; these are binding.

1. **Two eyes, no mouth.** Glossy beads, one catchlight each. No brows, no
   mouth: the face stays calm, and clear of every other fire spirit.
2. **Flame only above the eyes.** The round base is calm light. The flame rises
   from the top and the back of the head, never across the face.
3. **One silhouette, S1.** A tongue swept back as if it were moving, and a small
   flick on the right shoulder. The sweep and the flick are what keep it from
   reading as a drop of water: a drop is symmetric and has one point.
4. **Lit from inside.** A hot heart low and forward, fading to the body colour,
   and a rim of light at the edge. Never a gloss on the body: a gloss is what
   liquid does, and it reads as jelly.
5. **3D from 64px up, flat below.** See the next section.
6. **Never in the working UI.** Not in task rows, the transcript or the
   composer. A status dot stays a dot; the brand enters the app as motion
   (`frontend.md` §5l).

Its moods follow the app's state colours: running (violet, embers rising),
needs you (amber, wide eyes), stuck (coral, `> <`), done (green, `^ ^`, a burst
of sparks) and idle (grey, asleep, the flame burning low).

## Two renderings, one character

**The 3D spirit** is the hero: a raymarched model, lit from inside, its top a real
flame that licks and sheds sparks. The app icon, the home-screen icons, the
README header and the social preview are composed from it.

**The flat spirit** is S1 as two fills: the body and the eyes. Below 64px the 3D
turns to a glowing blob, so the favicon, the app's header mark and the Finder
icon are flat. They read as one character because the silhouette and the face
are identical.

The flat body is not `--primary` (#AF87F1) itself. One favicon serves a dark tab
bar and a white one, and #AF87F1 is a pale smudge on white; a third of the way
down toward `VIOLET.mid` holds on both. The favicon's eyes are 30% larger than
S1's, because at 16px the true size closes them.

A lighter heart low in the flat body was tried, to carry the lit-from-inside
read into the flat form. It read as a muzzle and was dropped. The light from
inside belongs to the 3D and the vector spirit.

Verified at **true 16px and 32px** on four grounds (`#0b0b0d`, `#35363a`,
`#dee1e6`, `#ffffff`) and inspected magnified. Never by shrinking a preview: a
downscaled 96px SVG flatters everything, which is why so many favicons ship
broken.

### The 3D sources

`source/` holds three renders, made outside this repository and committed the
way a designer's exported artwork would be:

| file | what it is |
|---|---|
| `spirit-3d-icon.png` | 1024×1024, the icon master: the spirit on `PALETTE.plate`, inside the central 80% circle |
| `spirit-3d-og.png` | 2560×1280, the spirit on the right of a stage with a floor and its reflection |
| `spirit-3d-readme.png` | 1600×520, the same stage, the spirit left of centre to leave room for the wordmark |

Their ground is exactly `PALETTE.plate` with no vignette, so the generator can
put them on a plate of that colour without a seam. Replacing one means rendering
it again at the same size and framing; everything built from it follows on the
next `bun run brand`.

## Bloom is ground-dependent

A violet halo behind the spirit is what makes it glow on the void, and on white
the same halo reads as a printing artifact. So bloom is a parameter, not a
constant, and the light-ground assets ship with it at zero. The halo is centred
in its square and fades out inside it: a halo that runs past the viewBox is cut
off in a visible square on the ground behind it.

## The assets

| file | size | where it goes |
|---|---|---|
| `favicon.svg` | 32 viewBox | inlined into `web/index.html` as a data URI |
| `wisp-mark.svg` | 96 viewBox | the vector spirit, tuned for light grounds, no bloom — safe on any ground |
| `wisp-mark-glow.svg` | 96 viewBox | the vector spirit with bloom, for dark grounds |
| `wisp-mark-flat.svg` | 64 viewBox | the flat spirit, for small or flat use |
| `wisp-logo-dark.svg` | 72 tall | lockup for dark grounds (bloom, light wordmark) |
| `wisp-logo-light.svg` | 72 tall | lockup for light grounds (no bloom, dark wordmark) |
| `readme-header.png` | 1600×520 | the README's header: the 3D spirit and the wordmark on a card with rounded, transparent corners, drawn at 800×260 |
| `apple-touch-icon.png` | 180×180 | iOS home screen — opaque plate on purpose |
| `pwa-icon-192.png` | 192×192 | web app installation, opaque plate |
| `pwa-icon-512.png` | 512×512 | web app installation and Android maskable icon |
| `og.png` | 2560×1280 | GitHub social preview (rendered at 1280×640, shipped 2×) |
| `cli-icon.pdf` | 512pt | Finder icon for an installed `wisp` binary |
| `cli-icon-dev.pdf` | 512pt | the same, inverted onto light violet, for a local build |

`desktop/src-tauri/icons/icon.png` (1024×1024, the macOS app icon master) is
composed here too: the 3D master on Apple's rounded 824pt plate, filling it a
little past its edges so the Dock shows the spirit rather than the plate.

The two lockups use **distinct gradient id prefixes** (`ld`, `ll`). As separate
files on GitHub they could safely share ids, but anyone inlining both into one
page would otherwise have the second one's gradients resolve to the first one's
definitions.

Two more generated files live outside this directory, and `brand:check` covers
them both:

| file | what it is |
|---|---|
| `web/index.html` | the favicon `<link>`, inlined as a data URI between markers |
| `web/src/components/wisp-mark.tsx` | the flat spirit as a React component, for the app header and gallery |

The app draws the mark at 17–24px, which is flat territory. Emitting that
component from the generator rather than hand-copying its paths is what keeps
the app's mark and `brand/` from drifting apart.

The two CLI icons are vector PDFs for small Finder and System Settings rows.
See [legacy CLI file icons](#legacy-cli-file-icons) below and
[macOS permissions](../docs/INSTALL-MACOS.md#macos-permissions).

`og.png` is **not** served by the daemon and is not referenced by the app. It has
to be uploaded by hand, once, at
*Settings → General → Social preview → Upload an image*. Nothing in the repo can
do that for you, and nothing breaks if it is never done.

### Why the favicon is a data URI

The application remains a single file — `wispd/tests/web.test.ts` asserts that
`/vendor/*` and friends 404, and that `web/ui-dist/` contains only `index.html`.
The favicon rides in the `<head>`. Home-screen installation additionally needs
fetchable PNGs: the daemon embeds the touch icon and two PWA icons behind a
fixed allowlist of routes, alongside the manifest and service worker.
`build.ts` writes that `<link>` between markers in `web/index.html`, and a
test asserts the generated bytes served by the daemon match
`brand/favicon.svg`. CI generates `ui-dist` from source before that test; the
directory itself is ignored and must never be committed.

The supported web, test, and release commands regenerate the bundle after a
brand change. The tracked source asset still has to pass `bun run brand:check`.

The PWA plate keeps the spirit inside the central mask-safe circle and lets
the launcher supply its own corner shape. To regenerate just these PNGs using
a particular Chrome/Chromium binary, set `CHROME_PATH` and run
`bun run scripts/brand/build.ts --pwa-only`. Add `--check` to verify them without
rewriting. This also checks the shared generated SVGs and favicon.

The check compares PNGs by their decoded pixels and metadata chunks, not their
bytes: Chrome compresses the same image differently on Linux and macOS. It does
not forgive a different pixel, and Chrome on Linux may resample the 3D master
slightly differently from Chrome on macOS, where the committed PNGs were
rendered; regenerate them on one platform.

## Legacy CLI file icons

Current publishable macOS releases put the daemon in a signed `Wisp Daemon.app`, so
Homebrew installs its durable icon automatically. For an old unbundled release
or a local development build, generate the icons and stamp the binary on macOS:

```sh
bun run brand
bash scripts/macos/stamp-icon.sh
bash scripts/macos/stamp-icon.sh --dev dist/wisp
```

The production icon uses a dark background; the development icon uses light
violet. Reopen System Settings to refresh the display. An upgrade of an old
unbundled release replaces the file and its icon, so stamp again if wanted. To
remove an icon, use
`bash scripts/macos/stamp-icon.sh --clear /path/to/wisp`.

Stamping writes a resource fork, not the Mach-O code directory. Ordinary
`codesign --verify` still passes, but `codesign --verify --strict` rejects the
resource fork as detritus. The script therefore refuses `dist/release/`.
Never stamp artifacts for publication. An icon does not change the binary's
code-signing identity or permissions.

## Typeface

Geist Sans, weight 600, converted to outlines. Outlines rather than a webfont
because GitHub does not load ours, and committed path data rather than reading
the `.woff2` at build time because that would put woff2 decompression and a glyph
outliner into the dependency graph of a logo that changes approximately never.
Provenance for regenerating it is in the header of `wordmark-data.ts`.

The word is **Wisp**, and the capital sets the alignment: the mark centres on
the **cap band** rather than the x-height band. Centring a capital on x-height
leaves the mark visibly low.

Geist is OFL 1.1; the licence text already rides along in `web/licenses/`.

## Using it elsewhere

The mark's alignment inside the lockup is **optical, not metric**: it centres on
the cap band, nudged 4% for the descender. Keep the ratios (`fontRatio` 0.56,
`gap` 0.04, tracking −2%) rather than re-eyeballing them at a new size; S1 is
taller than it is wide and leans left, so its square already carries air on the
right, which is why the gap is so small.

For a single-colour context (a stamp, a sticker die-cut, a mark on a photo),
`markSvg({ body: "#eaeaee", eyes: "<the ground>" })` gives the body that one
colour and cuts the eyes back to the ground.
