# Rotation-packing v2 — design (skeptic-vetted, PROCEED-with-care)

Status: **DESIGNED 2026-07-18** — impl is a dedicated round (fresh context). The fix's repack packs sprites
UNrotated; allowing a 90° rotation lets the packer fit a landscape sprite into a portrait gap, shrinking the
sheet (real disk + VRAM). This is a LARGE, corruption-prone feature (a wrong rotation direction silently
corrupts every rotated sprite in-engine), so it is designed here first and implemented in careful slices with
a hard correctness test — never started casually.

## Current infrastructure (what's built vs the two gaps)

BUILT + TESTED:
- `pack.ts` implements `allowRotation` (line ~107 tries the sprite rotated when `ih ≤ fr.w && iw ≤ fr.h`;
  emits `Placement.rotated`). The MaxRects geometry already produces rotated placements.
- The manifest emit/parse round-trip for rotated frames is TESTED (`atlas-transcode.test.ts` "rotated frame
  round-trips"): `manifest.ts` emits the frame w/h UN-ROTATED (`rotated ? {w: frame.h, h: frame.w}`) + sets
  `rotated:true`; `parsers/atlas.ts` reads it back to the PLACED frame (`rotated ? {w: raw.h, h: raw.w}`).
- The CONVENTION is fixed and consistent: `Sprite.frame` is stored AS PLACED (on-page footprint, w/h swapped
  when rotated); `sourceSize` stays UN-rotated. Placed = source rotated 90° CW ⇒ on-page `w = sourceSize.h`,
  on-page `h = sourceSize.w`. PixiJS Spritesheet builds `Rectangle(x, y, rect.h, rect.w)` for a rotated frame.

THE TWO GAPS:
1. **`repack.ts` drops the packer's rotation decision.** It emits `rotate90: false` unconditionally (line
   ~318) and `frame: {w: p.w, h: p.h}` with `rotated: s.rotated` (the SOURCE rotation, NOT the packer's
   `p.rotated`). So even if `pack()` places a sprite rotated, repack ignores it.
2. **The compose never applies a 90° pixel rotation.** `fix.worker.ts` handles `from.rotated` (a source
   region already stored rotated) defensively and gates extrude off for rotated blits, but there is NO
   `ctx.rotate` / transform that draws a source region rotated 90° into the destination for a `rotate90` blit.

## v2 scope (bounded to keep the geometry single-rotation)

- **RECT repack path only** (`repackAtlases`). NOT the polygon packer (mask nesting + mesh rotation is a
  separate, harder problem) and NOT merge (multi-source compose already complex). Polygon/merge stay unrotated.
- **Only rotate sprites that are UNROTATED in source** (`s.rotated === false`). A source-rotated sprite packs
  verbatim (as today). This bounds the compose to exactly ONE 90° rotation — no double-rotation / XOR math,
  which is where corruption hides.
- **Only UNTRIMMED sprites are rotation-eligible** in v1 of v2 (trim + rotation interact: the trim bbox is in
  source coords, the placement is rotated — the existing `spriteSourceSizeFrom` rotated-guard already bails
  trim for rotated sprites; keep rotation and trim mutually exclusive for the first cut). A trimmed OR
  rotation-candidate sprite picks at most one transform.
- **MEASURED gate (honesty).** Pack the group twice — `allowRotation:false` and `allowRotation:true` — and use
  the rotated result ONLY when its bin(s) are strictly smaller in Σ w·h·4 VRAM (the `polygonWins` precedent:
  gate on measured footprint, never intra-bin area). If rotation doesn't shrink the sheet, pack verbatim. So a
  rotated sprite is only ever emitted when it produces a real, measured win.

## The compose rotation (the ONE risky piece — get the direction right)

For a `rotate90` blit, the destination on-page frame is `{x, y, w: srcH, h: srcW}` (source rotated 90° CW).
The canvas draw must place the source region so that a loader reading `rotated:true` + `Rectangle(x,y,h,w)` +
rotating CCW to display recovers the ORIGINAL sprite. TexturePacker rotates 90° CW on the page, loaders rotate
CCW to restore. So the compose:
```
ctx.save();
ctx.translate(destX + srcH, destY);   // top-right of the destination box
ctx.rotate(Math.PI / 2);              // 90° CW
ctx.drawImage(sourceBitmap, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);
ctx.restore();
```
(The exact translate offset + rotation sign MUST be pinned by the identity test below — do NOT ship on
reasoning alone; a 180°/mirror error is invisible until an engine renders it.)

## Correctness verification (mandatory — no ship without it)

1. **Compose+un-rotate identity (the load-bearing test).** In a browser harness (e2e, like `fix-polygon-run`):
   pack a fixture with rotation ON, compose the atlas, read back the rotated frame's on-page region via
   getImageData, apply the INVERSE rotation (CCW), and assert the pixels equal the source sprite EXACTLY. This
   proves the compose direction matches the manifest `rotated:true` the loader will read. This is the test that
   catches a wrong rotation sign.
2. **Manifest round-trip** — already tested; extend with a repack-produced rotated sprite (emit → parseAtlas →
   placed frame w/h swapped correctly, sourceSize un-rotated).
3. **Fixture where rotation strictly helps** — e.g. a set of tall + wide sprites that only fit a smaller POT
   bin when some are rotated; assert the rotated pack's VRAM < the unrotated pack's, and 8/8 frames reconstruct.
4. **Honesty**: the receipt's "N sprites rotated · M% tighter" uses the MEASURED VRAM delta only; rotation is
   applied only when it wins the gate; a no-win group packs verbatim (byte-identical to today).

## Slice plan

1. `repack.ts` (pure): propagate `p.rotated` for eligible (untrimmed, source-unrotated) sprites → emit
   `rotate90: true`, `rotated: true`, `frame: {x, y, w: p.w, h: p.h}` (placed). Add the twice-pack measured
   gate (`rotationWins`). Pure unit tests (rotate90 propagation, gate, verbatim fallback). NO compose yet ⇒
   the plan is inert until slice 2 (guarded so a rotate90 blit without compose support never emits).
2. `fix.worker.ts` compose: implement the 90° `ctx.rotate` draw for `rotate90` blits. Pin the direction with
   the identity harness. Extrude stays gated off for rotated blits (v1 — the honest no-op is already surfaced).
3. Enable `allowRotation:true` in the repack options behind the measured gate; receipt copy + i18n.
4. Fixture + e2e (`fix-rotation-run.mjs`): the identity test + the VRAM-win assertion. Wire as an e2e scenario.
5. Optionally un-ABORT the N4 rotation-opportunity DETECTION (now the fix HAS a remedy) — a separate analysis
   round.

## Risk assessment

- **Corruption risk: HIGH if the compose direction is wrong** — mitigated ENTIRELY by the identity test
  (slice 4). Do not ship slice 2 without it green.
- **Value: modest-incremental** — the polygon packer already gives the bigger concave win; rotation helps
  aspect-ratio-diverse rect atlases. Real but not dramatic; the measured gate means it only ever helps.
- **Trim × rotation** deliberately deferred (mutually exclusive in this cut) to avoid the compounded geometry.
- **ABORT criterion**: if the compose identity test cannot be made green cleanly (the direction/offset proves
  loader-dependent beyond the Pixi/TP convention), ABORT and keep rotation off — a tighter sheet is never
  worth a corrupted sprite (invariant 3).
