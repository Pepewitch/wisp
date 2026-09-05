# brand

Every asset here is **generated**. Do not hand-edit generated assets; edit the
generator and re-run it:

```
bun run brand            # rewrite brand/ and the app's favicon
bun run brand:check      # fail if anything is stale (what CI runs)
```

The generator lives in [`scripts/brand/`](../scripts/brand/):

| file | what it owns |
|---|---|
| `geometry.ts` | the icosahedron, its edges, and the projection — derived, not typed |
| `mark.ts` | the lantern, its flat reduction, the favicon, and the lockup |
| `wordmark-data.ts` | "Wisp" in Geist 600, converted to outlines once |
| `build.ts` | writes this directory; rasterises the two PNGs with Chrome |

## The name

The product is **Wisp**. The command, the config directory, the branch prefix and
every filename in here stay lowercase `wisp`, because those are literal data
rather than the name — `skills/wisp-dev/references/frontend.md` §3 applied to the brand itself.

(Where this file says "the wisp" in lower case, it means the common noun: a
will-o'-the-wisp, the thing the mark is a picture of.)

## The idea

**A spirit held in violet glass.**

A regular icosahedron seen down a 3-fold symmetry axis, so its silhouette is a
hard hexagon. Its faces are translucent — the far side and the edges behind it
show through — and its edges are traced in **light**. Inside it burns a flame,
taller than wide and sitting a little high.

That flame is the wisp. The solid is only the vessel: a will-o'-the-wisp is a
light in the dark, and the mark is that light, contained.

## Three rules the mark is built on

**1. The material is violet, full stop.** Not graphite with a violet accent. The
greys in this project are the dark theme, not the brand, so they are not in the
logo. `VIOLET.brand` is `--primary` from `web/ui/src/index.css`; the rest of the
ramp is that same hue carried down to near-black and up to near-white, so the
whole family moves together if the hue ever does.

**2. Not one black line.** Facets are separated by tone and gradient alone. Each
facet's fill is a gradient between its darkest and brightest corner, computed
from *smooth* vertex normals — lighting a flat triangle at its corners is what
makes it read as a polished plane instead of a paper cut-out, and it means
adjacent facets differ in tone along their shared edge, so the edge reads without
anything being drawn on it. Where edges *are* drawn, they are luminous: a dark
seam reads as folded cardboard, a bright one reads as light caught on glass.

**3. Asymmetry is what reads as alive.** The core is an ellipse taller than it is
wide, sitting slightly above centre. A symmetric radial glow reads as a lamp.

### Why an icosahedron

This started as a dodecahedron and read as a sphere. Face count was not the
problem — **small facets** were. Twenty large triangles down the right axis give
a hard hexagonal silhouette and a handful of big planes, which is an angular read
that a pile of little pentagons could not hold.

Down the 3-fold axis the visible edges form a triangular star around a central
triangle, a structure that survives being made small. The 2-fold axis also gives
a hexagon but its edges cross the middle as a horizontal seam, which reads as two
halves stuck together. The 5-fold axis gives a decagon: the roundest of the
three, and the one to avoid.

## Two forms, one mark

**The lantern** is the hero: translucent shell, luminous edges, the flame, and an
optional bloom. Use it wherever there are pixels to spend.

**The reduction** is the same solid on the same axis with the glass taken out —
flat fills, no gradients, no filters, no strokes. Below roughly 24px the
translucency and the edge tracing fall under a pixel and turn to noise.

They read as one mark because both put their brightest tone in the middle.

### The reduction's tone mapping is the most delicate thing here

Map lambert straight onto the ramp and most facets climb to near-white; at 16px
the mark becomes a pale smudge and vanishes on paper. It was built that way once
and caught in the 16px proof. So:

- lambert is squeezed into a **narrow band low in the ramp** (`lo: 0.10`,
  `hi: 0.55`), keeping the mark unmistakably violet, with deep violet shadows and
  highlights that stop short of white
- a **centre boost** (`0.26`) brightens facets near the middle of the
  silhouette, which puts the brightest tone where the hero's flame is

That is how the reduction keeps the lit-from-inside read using flat fills only —
no overlay, no filter, nothing that turns to mush at four pixels wide.

Verified by rendering at **true 16px** on four grounds (`#0b0b0d`, `#35363a`,
`#dee1e6`, `#ffffff`) and inspecting magnified. Never by shrinking a preview: a
downscaled 96px SVG flatters everything, which is why so many favicons ship
broken.

## Bloom is ground-dependent

A blurred violet halo behind the solid is what makes it glow on the void, and on
white the same halo reads as a printing artifact. So bloom is a parameter, not a
constant, and the light-ground assets ship with it at zero rather than hunting
for one value that suits both.

## The assets

| file | size | where it goes |
|---|---|---|
| `favicon.svg` | 32 viewBox | inlined into `web/ui/index.html` as a data URI |
| `wisp-mark.svg` | 96 viewBox | the lantern, no bloom — safe on any ground |
| `wisp-mark-glow.svg` | 96 viewBox | the lantern with bloom, for dark grounds |
| `wisp-mark-flat.svg` | 64 viewBox | the reduction, for small or flat use |
| `wisp-logo-dark.svg` | 72 tall | lockup for dark grounds (bloom, light wordmark) |
| `wisp-logo-light.svg` | 72 tall | lockup for light grounds (no bloom, dark wordmark) |
| `apple-touch-icon.png` | 180×180 | iOS home screen — opaque plate on purpose |
| `og.png` | 2560×1280 | GitHub social preview (rendered at 1280×640, shipped 2×) |

The two lockups use **distinct gradient id prefixes** (`ld`, `ll`). As separate
files on GitHub they could safely share ids, but anyone inlining both into one
page would otherwise have the second one's gradients resolve to the first one's
definitions.

Two more generated files live outside this directory, and `brand:check` covers
them both:

| file | what it is |
|---|---|
| `web/ui/index.html` | the favicon `<link>`, inlined as a data URI between markers |
| `web/ui/src/components/wisp-mark.tsx` | the reduction as a React component, for the app header and gallery |

The app draws the mark at 17–24px, which is reduction territory. Emitting that
component from the generator rather than hand-copying its paths is what keeps the
app's mark and `brand/` from drifting apart.

`og.png` is **not** served by the daemon and is not referenced by the app. It has
to be uploaded by hand, once, at
*Settings → General → Social preview → Upload an image*. Nothing in the repo can
do that for you, and nothing breaks if it is never done.

### Why the favicon is a data URI

The daemon serves exactly one file and no asset routes — `tests/web.test.ts`
asserts that `/vendor/*` and friends 404, and that `web/ui-dist/` contains only
`index.html`. So a favicon cannot be a sibling file; it rides in the `<head>`.
`build.ts` writes that `<link>` between markers in `web/ui/index.html`, and a
test asserts the bytes served match `brand/favicon.svg`, the same way another
test asserts `ui-dist` matches `web/ui`. Generated-and-committed is fine here;
generated-and-drifting is not.

A web change that ships still needs `bun run build:ui` in the same commit, brand
changes included.

## Typeface

Geist Sans, weight 600, converted to outlines. Outlines rather than a webfont
because GitHub does not load ours, and committed path data rather than reading
the `.woff2` at build time because that would put woff2 decompression and a glyph
outliner into the dependency graph of a logo that changes approximately never.
Provenance for regenerating it is in the header of `wordmark-data.ts`.

The word is **Wisp**, and the capital moved the alignment: the mark now centres
on the **cap band** rather than the x-height band. Centring a capital on
x-height leaves the mark visibly low.

Geist is OFL 1.1; the licence text already rides along in `web/ui/licenses/`.

## Using it elsewhere

The mark's alignment inside the lockup is **optical, not metric**: centring on
the x-height band leaves it looking low, because the i's dot and the p's
descender put more ink above the x-height than below the baseline. The band is
stretched 18% past the x-height before centring. Keep the ratios (`fontRatio`
0.60, `gap` 0.20, tracking −2%) rather than re-eyeballing them at a new size.

For a single-colour context (a stamp, a sticker die-cut, a mark on a photo),
`markSvg({ flat: "#eaeaee" })` gives every facet that one colour and separates
them by **opacity** instead of tone. One opaque fill for all ten would erase the
facet boundaries and leave a plain hexagon.
