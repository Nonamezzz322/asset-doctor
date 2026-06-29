# AB-R4 — user-chosen scale-tier suffixes (safe-charset relax, build-side only)

## What changed

Before R4, `validateTiers` (`packages/fix/src/scale.ts`) accepted ONLY resolution-shaped suffixes via
`RESOLUTION_TOKEN` (`/^[_-](\d{2,4}p|@?\d+x|hd|sd)$/i`). A user who wanted to name a scale level `_mobile`,
`_lq`, or `_hidpi` was hard-rejected, and the profile panel in `apps/web/src/App.tsx` blocked the run.

R4 adds an exported `isSafeSuffix(s)` (+ `SUFFIX_TOKEN`) in `packages/fix/src/scale.ts`. It is a **superset**
of the legacy rule:

- Every currently-valid suffix (`_720p`, `@2x`, `_hd`, `_sd`, every `DEFAULT_SCALE_TIERS` entry) stays valid —
  the default build path is **byte-identical**.
- A safe **free-form** suffix is now also accepted: a leading separator `[_-]`, a leading body char from
  `[A-Za-z0-9]`, then 0..23 more chars from `[A-Za-z0-9_-]` (`SUFFIX_TOKEN`), AND the body is not a format
  name (`png`/`webp`/`avif`/`jpg`/`jpeg`, case-insensitive).

Rejected fail-closed (still): empty suffix, no leading separator (`mobile`), a dot (`_a.b` — would fake an
extension in `variantManifestName`), a slash (`_a/b` — would inject a directory), `@` in the free-form branch,
an empty/underscore-led body (`_`, `__`), an over-long body (>24 chars), and a format-name body (`_png`,
`_webp`, `_avif`, `_jpeg`, `_JPG`) — which would collide with the multi-format token (`EXT`) and the `stemOf`
format-peel. Plus all the unchanged tier guards: case-insensitive dup-suffix, no-top-tier (a `scale === 1`
tier is required), no-upscale / bad-scale, and the stable high→low sort.

## The honest re-ingest trade (DELIBERATELY NOT clustered)

Variant clustering in `packages/analysis/src/variants.ts` is **intentionally NOT touched** by R4.

- **Resolution-shaped suffixes** (`_720p`/`@2x`/`_hd`/…) still cluster on re-analysis exactly as before: when
  the optimized output is later re-ingested, all tiers of one asset collapse into ONE variant group so the
  loaded-VRAM footprint is counted once per device (invariant 5).
- **Custom non-resolution suffixes** (e.g. `_mobile`) are **not** recognized as tier-variants on re-ingest. If
  the built folder is later re-analyzed, a `banner_mobile.png` tier shows up as a SEPARATE asset from
  `banner_1080p.png` (whose `_1080p` is a resolution token and still peels/clusters). This is a
  **conservative over-count** of the advisory `variants` WARN finding — it never fabricates a cluster and never
  affects the hard VRAM gate (the gate sums real per-asset footprints; an un-clustered tier is counted, not
  hidden).

### Why not just widen the clustering recognizer too?

Teaching `variants.ts` (`TOKEN`/`RES_TOKEN`/`stemOf`/`hasResolutionToken`) to peel any free-form suffix would
make `banner` + `banner_mobile` cluster — but it would ALSO falsely cluster two genuinely-different files that
merely share a stem-plus-suffix shape, e.g. `icon_blue.png` + `icon_red.png`, claiming only one loads per
device when both genuinely do. That is a fabricated, optimistic cluster — the dishonest direction.

We choose the conservative direction: a custom-suffix tier set is **over-counted** (shown as separate assets,
inflating an advisory warning) rather than **under-counted** (falsely merged). Build-side relaxation is the
contained, honest scope; clustering stays keyed to the resolution shapes it can recognize without guessing.

## Scope

- `packages/fix/src/scale.ts` — `isSafeSuffix` + `SUFFIX_TOKEN` + `FORMAT_TOKEN_BODY`; `validateTiers` uses
  `isSafeSuffix` instead of the inline `RESOLUTION_TOKEN.test`. `RESOLUTION_TOKEN` stays exported.
- `apps/web/src/App.tsx` — the profile panel validity check uses `isSafeSuffix`.
- `packages/i18n` — `fix.tier.badSuffix` + `fix.profile.tierBadSuffix` reworded (safe-suffix wording) across
  all 9 catalogs; no new keys.
- The worker is UNCHANGED — it consumes `tier.suffix` verbatim via `tieredName` / `variantManifestName`, both
  charset-safe for the accepted set.
- `packages/analysis` is UNTOUCHED — all existing analysis/variants tests pass unchanged.
