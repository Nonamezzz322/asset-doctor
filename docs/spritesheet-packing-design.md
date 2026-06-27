All facts confirmed. `rotate:270` appears in 171 real `.atlas` files (the latent repack bug is real but pre-existing). The i18n convention uses both flat (`fix.mergeWarn`) and nested (`fix.settings.*`) keys; I'll resolve the duplication the skeptic flagged. 9 catalogs confirmed.

I have complete ground truth. Here is the final, implementation-ready plan.

---

# Asset Doctor — FEATURE 4 (FINAL): Packing RAW Loose Assets into Spritesheets

**Status:** implementation-ready, design-only. Composes additively with Part B (`docs/asset-builder-port-design.md`). Every contract verified against the actual sources and against **290 real production Spine skeletons** + **171 real `.atlas` files** in `raw/`/`assets/`.

---

## TL;DR

Feature 4 builds **new** spritesheets from loose images: (A) static loose PNGs → packed sheet(s) + TexturePacker Hash JSON; (B) a Spine animation's loose region PNGs → packed page(s) + a correct libGDX `.atlas`. It reuses `pack()`, the worker compose/encode/zip, and `emitTexturePackerJson`/`emitSpineAtlasText` **verbatim** — no new packer, no emitter edits. Net-new is three pure modules (`trim.ts`, `packLoose.ts`, an ingest grouping helper), a new `FixOp 'pack'`, and a worker `pack` handler. It is **reference-changing** (the game must load the sheet, not the loose files), gated behind its own explicit Pro toggle (not `aggressive`), and sets `FixReceipt.referencesChanged`.

**Six corrections from the skeptics (all verified true and now binding):**
1. `manifest.ts`/`spine-atlas.ts` are **NOT buggy** and stay **UNCHANGED** — they are already exact inverses (parser stores bottom-left `offset.y` at spine-atlas.ts:78, emitter writes it verbatim at manifest.ts:46). The Y-flip lives **only** in `trim.ts.spineOffsetFrom` + `packLoose` storing it into `spriteSourceSize.y` for `kind:'spine'`.
2. Grouping is **re-derived** dir-aware and re-applies `shouldAtlas.maxSpriteEdgePx` per image. It does **not** consume the `should-atlas` finding's `relatedRefs` (verified single flat global list, folder.ts:101-120).
3. Spine skeleton verifier handles **both** `skins` shapes (array — the real production form — and legacy object) and resolves regions **per attachment type** (region/mesh need a region; linkedmesh inherits from parent; clipping/point/boundingbox/path ignored). Reads `path` override, not attachment name.
4. Synthesized sheet/page/atlas paths are guaranteed collision-free vs every input and every other emitted path; `out` is **deduped by path** before `makeZip`.
5. Stem-collision = **two distinct loose files → one region name** only. Multiple slots sharing one region (9400 real cases) is normal and never flagged.
6. `packLoose` sorts sprites with `localeCompare` (matching the emitters, as repack.ts:96 does), not Part B's codepoint cmp. Pack-emit lives **in plan.ts**, after dedup pass 0a, guarded by a `packed` set exactly like `resized`/`dropped`.

---

## 1. Scope

**In:** (A) static loose → sheet + TP JSON (single & multi-page). (B) Spine loose regions → page(s) + one multi-page-aware `.atlas`. Trimming, padding-gutter, POT/maxSize spill, deterministic manifests, honest reference-changing surfacing, composition with Part B.

**Out (v1, documented):** rotation in packing (worker can't rotate a blit — verified); edge-extrude/bleed (deferred with an honest limitation note — §10); decoy exclusion (pack-all, §13 Q5).

**Reuse (no reinvention):**

| Need | Reused from | Change |
|---|---|---|
| MaxRects pack, POT, multi-page spill, single-oversize clamp | `pack.ts` `pack()` | none |
| Atlas[]+Blit[] build shape, multi-page imageRef, localeCompare sprite sort | pattern of `repackAtlases` (`repack.ts`) | `packLoose` is a sibling |
| TP JSON emit | `emitTexturePackerJson` | none |
| Spine `.atlas` emit | `emitSpineAtlasText` | **none** (already correct inverse) |
| Compose, encode, zip, pass-through | worker compose loop, `encodeCanvas`, `makeZip` | factor a shared compose-page helper |
| Per-asset encode options | `resolveOptions`/`scaleAwareQuality` (Part B) | none |
| Per-region alpha read | worker `getImageData` (extractSprite pattern) | new whole-image read |
| Dir-aware keying | `keyOf`/`normalizePath` (ingest) | none |
| Alpha threshold | `POLY_ALPHA_THRESHOLD` (=1) | none |
| Honesty flag | `referencesChanged` + `fix.mergeWarn` banner | sibling `fix.packWarn` |

**Net-new:** `packages/fix/src/trim.ts`, `packages/fix/src/packLoose.ts`, an ingest grouping helper, `core` additive types + `FixOp 'pack'` + `FixReceipt.packedSheets`, worker `pack` handler + spine verifier, UI control + i18n keys, fixtures.

---

## 2. Core / FixOp contract (exact TS, additive)

All additive to `packages/core/src/index.ts`; **no existing field changed**.

```ts
/* ── Feature 4: pack loose assets into spritesheets ───────────────────────────────────────────
 * Turns OWNED loose images into ONE logical sheet (TP JSON) or ONE logical Spine atlas (.atlas,
 * N page blocks). REFERENCE-CHANGING (FixReceipt.referencesChanged): the game must load the
 * sheet/atlas, not the loose files. Geometry is pure (trim.ts + packLoose); the worker supplies
 * each region's alpha bbox. v1 never rotates a blit, so rotated/rotate is always false/0. */

/** Trimmed-content bbox of a loose image, TOP-LEFT source px coords (the worker's alpha bbox).
 *  w/h = opaque extent. Fully transparent ⇒ caller decides sentinel/skip (never zero-size region). */
export interface TrimRect { x: number; y: number; w: number; h: number; }

/** One loose image to pack. `ref` = dir-aware ingest key (keyOf). `name` = the region/frame name
 *  the sheet exposes (relative-path stem, slash-preserved). `sourceSize` = FULL untrimmed size.
 *  `trim` (optional) = worker-measured opaque bbox; absent ⇒ pack untrimmed. */
export interface LooseRegion {
  ref: string;
  name: string;
  sourceSize: Size;
  trim?: TrimRect;
}

export type PackKind = 'static' | 'spine';

/** A deterministic grouping of loose refs → ONE sheet (static) or ONE .atlas (spine).
 *  `id` = stable group key (the sheet's output dir + stem). `root` = dir all region names are
 *  relative to. `outDir` = directory the sheet/JSON/.atlas is written to (= the dir meta.image /
 *  page-image basenames resolve against). Spine groups MAY carry the skeleton ref for verification. */
export interface PackGroup {
  id: string;
  kind: PackKind;
  root: string;
  outDir: string;
  stem: string;                 // sheet basename stem (no ext); collision-checked in the worker
  regions: LooseRegion[];
  skeletonRef?: string;         // spine only: the .json/.skel ref driving verification
}
```

Extend the `FixOp` union (additive arm):

```ts
  | { kind: 'pack';
      /** ONE PackGroup → ONE sheet (static) or ONE multi-page .atlas (spine). Carries only OWNED
       *  loose refs — never a dedup consumer scheduled for drop (enforced in plan.ts). */
      group: PackGroup;
      /** Sheet image target. Spine defaults to PNG (runtime-safe); static may use WebP/AVIF. */
      targetMime: ImageMime;
      /** Trim transparent margins (→ TP spriteSourceSize / Spine offset) before packing. */
      trim: boolean;
      padding: number;
      maxSize: number;
      /** ALWAYS false in v1 — the worker compose path cannot rotate a blit (verified). Typed literal. */
      allowRotation: false }
```

Extend `FixReceipt` (`apps/web/src/worker/fix-protocol.ts`, additive optional — absent ⇒ byte-identical to today):

```ts
  /** Feature 4: loose images packed into new sheets/atlases. `groups` = packs performed; `sheets` =
   *  emitted page images; `regions` = total loose files folded in (now dropped). Building a sheet is
   *  reference-changing ⇒ referencesChanged is also set (NOT a blind drop-in). */
  packedSheets?: { groups: number; sheets: number; regions: number };
  /** Spine path verification result (per pack op, accumulated). `verified` = attachment paths matched
   *  to a region; `unverified` = .skel/unrecognized-skins case (honest "paths not verified"). */
  packVerification?: { verified: number; unmatched: number; unverified: number };
```

**No new `Rule`.** Diagnosis still only says "N loose sprites should be atlased" (objectivity invariant 3); the fix decides packing.

---

## 3. Pure modules (`packages/fix`)

### 3a. `trim.ts` — alpha bbox → trim metadata (pure, Vitest)

```ts
import type { Rect, Size, TrimRect } from '@asset-doctor/core';
import type { RGBASource, Region } from './mask';
import { POLY_ALPHA_THRESHOLD } from './polygon-config';

/** Opaque bounding box of `region` in `src`, TOP-LEFT coords. A pixel counts when
 *  alpha >= POLY_ALPHA_THRESHOLD (=1; SAME threshold as mask/mesh — single source of truth).
 *  Fully transparent ⇒ null. Pure, integer-only, no canvas. */
export function alphaBBox(src: RGBASource, region: Region): TrimRect | null;

/** TexturePacker spriteSourceSize (TOP-LEFT) from untrimmed size + opaque bbox.
 *  = { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h }. */
export function spriteSourceSizeFrom(sourceSize: Size, bbox: TrimRect): Rect;

/** Spine `offset` (libGDX BOTTOM-LEFT origin) from untrimmed size + TOP-LEFT bbox.
 *  offsetX = bbox.x ; offsetY = sourceSize.h - (bbox.y + bbox.h)   ← the Y-FLIP.
 *  This is the ONLY place the flip lives. */
export function spineOffsetFrom(sourceSize: Size, bbox: TrimRect): { x: number; y: number };
```

`alphaBBox` reuses `RGBASource`/`Region`/`POLY_ALPHA_THRESHOLD` so the trim threshold cannot drift from mask/mesh. Threshold 1 keeps any alpha≥1 pixel (conservative — includes a 1-alpha halo; never clips needed pixels).

### 3b. `manifest.ts` / `spine-atlas.ts` — **UNCHANGED**

**No edit.** Verified: `parseSpineAtlasText` (spine-atlas.ts:78) stores the raw libGDX bottom-left `offset.y` into `spriteSourceSize.y`; `emitSpineAtlasText` (manifest.ts:46) writes `spriteSourceSize.y` back verbatim as `offset:`. They are exact inverses; the existing repack round-trip is byte-correct (proven by `fix.test.ts:181-185`).

**The field semantics differ by kind, and `packLoose` is the one place that honors it:**
- `kind:'static'` → `spriteSourceSize.y` = **top-left** trim offset (`spriteSourceSizeFrom`), what `emitTexturePackerJson` expects (TP convention).
- `kind:'spine'` → `spriteSourceSize.y` = **bottom-left** offset (`spineOffsetFrom`), so `emitSpineAtlasText` writes it verbatim and a re-parse recovers it.

(There is no "existing bug." Editing the emitter would double-flip an already-bottom-left value and break `spine-basic`.)

### 3c. `packLoose.ts` — loose images → Atlas[] + Blit[] (pure, Vitest)

```ts
import type { Atlas, Blit, ImageMime, LooseRegion, PackKind, Sprite } from '@asset-doctor/core';
import { pack, type PackItem } from './pack';
import { spriteSourceSizeFrom, spineOffsetFrom } from './trim';

export interface PackLooseOptions {
  kind: PackKind;           // controls imageRef ext default + spriteSourceSize.y origin (§3b)
  imageBase: string;        // sheet basename stem (= group.stem)
  targetMime: ImageMime;    // drives the image extension
  trim: boolean;            // pack trimmed content vs untrimmed
  padding: number;
  maxSize: number;
  allowRotation: false;     // v1 invariant — typed literal
  format?: string;          // Spine page `format:` (default RGBA8888) → Atlas.format
}

export interface PackLooseResult {
  atlases: Atlas[];         // 1 per POT bin (static: 1 JSON each; spine: N page blocks of ONE .atlas)
  blits: Blit[];            // worker compose contract (rotate90 ALWAYS false)
  vramBytesAfter: number;   // Σ w×h×4 of emitted sheets (honest GPU footprint of the new sheets)
  pageOfName: Map<string, number>;  // region name → bin index (lets the worker emit per-page; §6)
}

/** Pack loose images into POT sheet(s). PackItem dims = TRIMMED size when trim, else sourceSize.
 *  Sprites carry rotated:false; spriteSourceSize.y is TOP-LEFT (static) or BOTTOM-LEFT (spine). */
export function packLoose(regions: LooseRegion[], opts: PackLooseOptions): PackLooseResult;
```

**Mechanics** (mirrors `repackAtlases`; differences noted):
- `PackItem[]`: `id = region.name`; `w,h = (trim && region.trim) ? {region.trim.w, region.trim.h} : region.sourceSize`. **Pack the TRIMMED content, never the untrimmed size.**
- `pack(items, {maxSize, allowRotation:false, padding})` → bins (native multi-page spill).
- **Per-bin imageRef (ONE documented scheme, intentionally NOT repackAtlases's):** `i===0 ? \`${imageBase}${ext}\` : \`${imageBase}_${i}${ext}\``. Single page ⇒ **no suffix** (common case). (repackAtlases suffixes page 0 too when `bins.length>1`; we deliberately don't, since these are fresh names with no prior references. Documented divergence.)
- Per placement `p` (`r = byId(p.id)`):
  - `sourceSize = r.sourceSize`.
  - `trimmed = trim && r.trim && (r.trim.w !== sourceSize.w || r.trim.h !== sourceSize.h)`.
  - `frame = {x:p.x, y:p.y, w:p.w, h:p.h}` (rotated:false ⇒ no swap).
  - `spriteSourceSize` only when `trimmed`: static → `spriteSourceSizeFrom(sourceSize, r.trim)`; spine → `{ x: spineOffsetFrom(sourceSize, r.trim).x, y: spineOffsetFrom(...).y, w: p.w, h: p.h }`.
  - `Atlas.source.kind = kind === 'spine' ? 'spine' : 'texturepacker-hash'`.
  - `Blit`: `from.atlasRef = r.ref`, `from.rect = (trim && r.trim) ? r.trim : {x:0,y:0,w:sourceSize.w,h:sourceSize.h}`, `from.rotated:false`, `to = frame`, `rotate90:false`.
- **Sprite sort: `localeCompare`** (matches both emitters; repack.ts:96 does the same). `pageOfName` records which bin each region landed in.
- **Spine emit guard:** `packLoose` asserts every emitted sprite has `rotated === false` (fail-fast). `emitSpineAtlasText` is documented as `rotated:false`-only until the worker can rotate a blit.

**Determinism:** `pack` stable-sorts items; sprites sorted by `localeCompare` (== emitted order); imageRef suffix deterministic; emitters deterministic. Shuffled input → identical Atlas[] and identical bytes.

### 3d. Spine emission reuse

No new emitter. `packLoose(kind:'spine')` returns one `Atlas` per page; the worker calls `emitSpineAtlasText(page_i)` **per bin** and concatenates (blank line between blocks; each block's non-indented `size:` is the page boundary `parseSpineAtlasText` detects). **Critical:** each region must sit under ITS page's image header — never emit one atlas with all sprites under page 0 (would resolve spilled regions to the wrong image → garbage). `pageOfName` from `packLoose` makes per-page emission unambiguous. Straight-alpha pixels ⇒ no `pma`. v1 Spine header contract: `format: RGBA8888`, `filter: Linear,Linear`, `repeat: none`, no `pma`, `index: -1`, `rotate: 0`.

---

## 4. Grouping policy (deterministic; re-derived, not finding-driven)

A pure ingest helper (web + extension + worker agree). All keys dir-aware (`keyOf`/`normalizePath`).

**Re-derivation (binding correction):** The helper independently scans assets and **re-applies `shouldAtlas.maxSpriteEdgePx` per image** — a loose image is a pack candidate iff `max(w,h) <= shouldAtlas.maxSpriteEdgePx`, the exact predicate `shouldAtlasFinding` uses (folder.ts:103). It does **not** read the finding's flat global `relatedRefs`. The finding remains only the **UI trigger** ("you have N loose sprites — want to pack them?"). This packs exactly the population diagnosis would flag, even when a leaf folder mixes small + large images.

### 4a. Spine groups (detected first; correctness > efficiency)
A directory `D` is a **spine root** iff it (recursively within D) contains a skeleton:
- a `.skel` (binary), OR
- a `.json` whose top-level keys include `skeleton` AND `bones` AND `slots` (defensive parse — NOT `frames`/`meta.image`, which is TexturePacker), OR
- a folder convention `animations/<name>/` or `spine/<name>/` (configurable prefixes; matches the real `raw/raw/animations/<name>/` layout).

All candidate loose images under `D` (recursive, dir-aware) → one `PackGroup{kind:'spine', root:D}`. **Region name = path relative to D, extension stripped, `/`-separated** (`char/items/sword.png` under root `char` → `items/sword`). Never flatten. `outDir = D`, `stem = leaf(D)`, `skeletonRef =` the detected skeleton.

### 4b. Static groups (everything not in a spine root)
Default: **one sheet per leaf folder** (deterministic; matches common layout). Region/frame name = path relative to the group folder, ext stripped. A group with `< shouldAtlas.minLooseImages` candidates is skipped unless forced (no draw-call win from atlasing one sprite). Empty group → no op.

**Static frame keys are relative-path stems, not basenames** — a documented reference-changing decision surfaced in `fix.packWarn` ("frames are keyed by folder-relative path"). The per-leaf-folder default minimizes nesting so most keys ARE basenames.

### 4c. User influence (deterministic knobs, no free-text)
- **Mode:** `Auto` (spine where a skeleton is detected, static elsewhere) | `Force static` | `Force spine`.
- **Static granularity:** `per-leaf-folder` (default) | `one-sheet-for-all` | `per-top-level-bundle`.
- **Sheet output path per mode (pinned):** per-leaf-folder → `outDir` = that leaf folder; one-sheet-for-all → `outDir` = common ancestor of the candidates; per-bundle → `outDir` = the bundle root. The JSON/`.atlas` MUST sit in `outDir` (the dir meta.image / page-image basenames resolve against).

---

## 5. Spine correctness (region semantics, verifier, multi-page, math)

**Region naming:** relative path under spine root, ext stripped, slash-preserved (§4a). Equals the attachment's resolved `path` for from-scratch and path-override exports.

**Verifier (binding corrections — verified against 290 real skeletons):**
- **`skins` shape:** handle BOTH `skins` as an **array** of `{name, attachments}` (modern 3.8+ — the real production form, confirmed: `skins` is a list in every project skeleton) AND as a **legacy object** `{skinName: {slot: {att: {...}}}}`. If neither shape parses, emit the honest **"paths not verified"** warning (`packVerification.unverified++`) — never report a false `0-of-0 verified`.
- **Per-type resolution** (real type counts across project: region 44840, mesh 2740, linkedmesh 510, path 20, no clipping/point/boundingbox here but handle them):
  - `region`, `mesh` → REQUIRE a region named by `att.path ?? attName` (360 real `path` overrides exist — read `path`, not the attachment name).
  - `linkedmesh` → resolves its region from its **parent** mesh (`att.parent` in `att.skin ?? this skin`); it has no path of its own. Resolve via the parent's `path ?? parentName`.
  - `clipping`, `point`, `boundingbox`, `path` → need NO region; **ignore** (do not flag).
- For every required region, assert a packed region exists. Misses → `skipped[]` ("attachment 'X' path 'Y' has no matching region", `packVerification.unmatched++`) and **do not ship a silently broken atlas** for that region.
- `.skel` (binary) → cannot cheaply verify → pure stem-naming + honest "paths not verified".

**Stem-collision (binding correction):** collision = **two distinct loose source FILES → the same region name within one group** (e.g. `items/sword.png` and `items/sword.webp`). Surface in `skipped[]`; never overwrite; for spine this is fatal for the colliding region. **Multiple skeleton attachments/slots resolving to one region name is NORMAL** (9400 real cases) and is **never** flagged.

**Field math** (per emitted region, all `rotate:0` in v1):
- `xy` = `frame.x, frame.y`; `size` = `frame.w, frame.h` (un-rotated trimmed extent); `orig` = `sourceSize.w, sourceSize.h` (untrimmed; `orig==size` if not trimmed).
- `offset` (bottom-left) = `offsetX = bbox.x`, `offsetY = sourceSize.h - (bbox.y + bbox.h)` (§3a), stored into `spriteSourceSize.y` for spine (§3b) → emitted verbatim → re-parses correct.
- `index: -1`; `rotate: 0` always (fail-fast assert `rotated===false` at the emit boundary).

**Multi-page (binding correction):** one `.atlas` = N page blocks via per-bin `emitSpineAtlasText` concatenation (§3d). Each region under its correct page header (driven by `pageOfName`). Page images `${stem}.png`, `${stem}_1.png`, … Supported (a large animation can legitimately spill — unlike today's repack which skips multi-page spine).

**Rotation:** never `rotate:90/270`. The worker can't rotate a blit. Pre-existing repack bug noted separately (§ table).

---

## 6. Worker execution (impure half; reuses compose/encode/zip)

New `op.kind === 'pack'` branch in `fix.worker.ts`, alongside `repack`. Reuses `bitmapOf`, the `getImageData` read pattern, the compose loop, `encodeCanvas`, `out`/`replaced`/`dropped`/`skipped`, `makeZip`.

1. **Collision pre-check (binding):** synthesize the page/JSON/.atlas paths for `op.group`. Assert NONE collides with any input `files[].path` or any already-emitted `out[].path`. On collision → disambiguate `stem` to `${stem}.packed` (re-check) or, if still colliding, skip the group + `skipped[]` ("sheet name collides with existing file"). Never overwrite.
2. **Alpha bbox per region** (only when `op.trim`): `bitmapOf(region.ref)` → draw full image to OffscreenCanvas → ONE `getImageData` → `alphaBBox(src, {x:0,y:0,w,h})`. Same read pattern as `extractSprite`; cache by ref. Fully transparent → static: 1×1 sentinel; spine: skip + `skipped[]` (a transparent attachment is a decoy) — never a zero-size region.
3. **packLoose** → `{atlases, blits, vramBytesAfter, pageOfName}`.
4. **Compose each page:** `OffscreenCanvas(bin.w, bin.h)`; per blit `drawImage(bmp, from.rect…, to…)` — identical to the existing repack compose, straight drawImage, no rotation, no clip. `bitmapOf` failure → abort op honestly into `skipped[]`.
5. **Encode:** `encodeCanvas`. Spine → PNG default (WebP opt-in with a warning the loader must support WebP atlas pages). Static → effective target via `resolveOptions(group.outDir, kind, baseEffective, opts.overrides)` (Part B).
6. **Emit (per page) into `out`:**
   - static: `out.push({path:\`${outDir}/${imageBase}${ext}\`, …})` + `out.push({path:\`${outDir}/${imageBase}${i===0?'':'_'+i}.json\`, bytes: te.encode(emitTexturePackerJson(atlas_i))})`. `meta.image` = the sheet basename beside that JSON.
   - spine: each page image + ONE `.atlas` = `te.encode(emitSpineAtlasText(page_0) + '\n' + emitSpineAtlasText(page_1) + …)`, each region under its own page header (`pageOfName`). The skeleton `.json`/`.skel` is **passed through untouched** (region names already match attachment paths).
7. **Drop packed loose files:** `for (region of group.regions) dropped.add(pathByRef.get(region.ref))`.
8. **Honesty:** `referencesChanged = true`; accrue `packedSheets` + `packVerification`. VRAM: report `vramBytesAfter` of the new sheets vs the summed loose VRAM; **primary win is draw-call/bind reduction** (objective, packing-intrinsic); VRAM is presented as "may increase due to POT padding" with measured after-bytes — never a guaranteed saving (invariant 5; aligns with dedup upper-bound honesty).
9. **`out` path-dedup before zip (binding):** before `out.map(→ZipEntry)`, dedup `out` by path (last-write-wins for a deliberate replace; assert no accidental duplicate from a synthesized path — guarded by step 1). Then `makeZip`.

**Factor a shared `composePageEncodeEmit(blits, bin, target) → {imageBytes}` helper** that both the `repack` and `pack` branches call, to avoid drift (steps 4–5 are mechanically identical to fix.worker.ts:437-466).

---

## 7. Honesty (the central point)

Building a sheet from loose files is **reference-changing** and NOT drop-in:
- The game must load `sheet.json`/`.atlas` instead of the loose files; code that loaded loose files by name breaks.
- `FixReceipt.referencesChanged = true` (same flag atlas-merge uses, fix.worker.ts) → existing `fix.mergeWarn` banner fires, plus a dedicated `fix.packWarn`: "Packed N loose images into M sheets — your game must load the sheet manifest(s)/atlas instead of the individual files. Static frames are keyed by folder-relative path." Spine adds: "skeleton paths verified (K) / paths not verified (.skel binary)."
- **Contrast with drop-in repack:** the existing single-atlas repack keeps region names and the manifest file → drop-in → `referencesChanged` stays false. Feature 4 is the explicit opposite, behind its **own** Pro toggle (default OFF) so a default Pro run never silently reorganizes a folder.
- Spine skeleton is **not modified**. Unmatched attachment path → surfaced, not shipped broken.

---

## 8. Composition with Part B + op ordering

**Pack OWNERS only — enforced in plan.ts (binding correction).** Pack-emit is a new pass in `planFix` that runs **immediately after dedup pass 0a** (so `dropped`/`protectedOwners` are populated) and **before** pass 1. A `region.ref` already in `dropped` is excluded from the pack group (no double-drop); an owner is freely packable. The exclusion lives in plan.ts **only** (not "planFix or the worker") — single source of truth, no split-brain.

**Transcode guard (binding correction).** Build a `packed: Set<string>` of every ref consumed by a `pack` op during the pack pass. Guard pass-2 transcode with `!packed.has(f.assetRef)` exactly like the existing `!resized.has`/`!dropped.has` guards (plan.ts:120). A ref flagged by both `should-atlas` and `format` yields **exactly one pack op and zero transcode ops**.

**Spine cross-skeleton consumer (binding correction).** Verified: spine-pool dedup consumers are **already hard-kept** in Phase C (fix.worker.ts:642-646 "Spine cross-page dedup not drop-in — kept duplicate") — they are never dropped today. So "keep a spine region needed by its skeleton" is satisfied trivially; **no Part B change is needed for spine v1**. The misleading "let the other consumer repoint (Part B §3d)" is dropped (that path is for pixi atlas consumers). v1 just asserts in a test that a packed spine region is never in `dropped`.

**Settings apply to packed output.** trim/padding from the `pack` op; format/quality/effort/near-lossless from `resolveOptions(group.outDir, kind, baseEffective, opts.overrides)` (Part B) — same resolution the transcode/resize paths use.

**Op ordering (deterministic, plan.ts emission order):** dedup pass 0a (drop decisions) → **pack pass (after 0a, before pass 1)** → pass 0 atlas-merge → pass 1 repack/resize → pass 2 transcode (skips `packed`) → Phase C dedup rewrites/drops (worker) → `out` path-dedup → zip. A loose image is **either** folded into a sheet (encoded in the pack step, not re-transcoded) **or** transcoded — never both.

---

## 9. UI

New collapsible "Pack loose images into spritesheets" panel in `FixCard` (`App.tsx`), **Pro + explicit opt-in, default OFF**:
- **Mode:** Auto | Force static | Force spine.
- **Static grouping:** Per folder (default) | One sheet | Per bundle.
- **Trim transparent margins** (default ON).
- **Sheet format** reuses the existing target/quality/effort controls (Part B); note "Spine sheets are PNG by default for runtime safety."
- **Inline reference-changing warning** (not just post-run): "Packing rebuilds references — your game must load the new sheet/atlas, not the loose files. Not a drop-in replacement."
- Post-run receipt: `packedSheets` (groups/sheets/regions), `packVerification`, and `skipped[]` (unmatched attachment, transparent region, oversized-single, name collision).

**i18n (9 catalogs en/ru/de/es/pt/fr/it/zh/hi).** Resolve the namespace duplication (binding correction): panel controls nested under `fix.pack.*` (`fix.pack.title`, `fix.pack.mode.auto|static|spine`, `fix.pack.grouping.folder|one|bundle`, `fix.pack.trim`, `fix.pack.spinePng`, `fix.pack.inlineWarn`); the post-run banner is the flat **`fix.packWarn`** (sibling of `fix.mergeWarn`). **No `fix.pack.warn`** (eliminates the near-duplicate). `skipped[]` reasons stay engineering strings rendered as a localized count. Every key in all 9 catalogs with identical placeholder tokens before `pnpm test` (drift test); English authoritative; CLI stays EN.

---

## 10. Determinism contract + edge cases

**Determinism:** (a) group iteration sorted by `PackGroup.id`; (b) region order via `pack`'s stable item sort + **`localeCompare`** name sort (== emitted manifest order, repack.ts:96); (c) imageRef suffix `_${i}` deterministic; (d) emitters deterministic (sorted, fixed key order, no timestamps); (e) trim math integer-only. Shuffled input → identical sheets + identical JSON/.atlas bytes.

**Scope caveat (honest):** *manifest/.atlas bytes* are byte-stable **given identical decoded input bytes**. Trim rects derive from decoded alpha — deterministic for **losslessly-decoded** sources (PNG; all fixtures are PNG). For lossy-source loose images (WebP/JPEG) the decoded alpha — and thus the trim rect AND the manifest — can vary by decoder; this is surfaced, not claimed-away. Composed *pixels* (canvas drawImage) are not guaranteed cross-machine byte-identical (matches today's repack). No pixel-reproducibility claim in receipt/marketing.

**Extrude/bleed (binding decision — DEFER with honest note):** packed sheets use **padding-gutter only**, matching today's repack. Bleed at non-integer UV / mipmap / linear-filter boundaries is a **known v1 limitation**, documented (especially given `emitSpineAtlasText` hardcodes `filter: Linear,Linear`). A real edge-replicate extrude pass is a follow-up (§13 Q7). Not left implied — explicitly deferred.

**Edge cases:**
1. **Already-atlased input** in the same folder → repack path's concern; Feature 4 builds from loose only; don't fold an existing `.atlas` into a pack.
2. **Single image in a group** → skip unless forced; if forced, a 1-region sheet is valid.
3. **Oversized image** (trimmed dim > maxSize) → `pack` clamps it alone on its own page (pack.ts:163-166); warn (downscaling changes appearance; for spine `size` ≠ `orig`).
4. **NPOT loose** → packed into POT bins (the point); no special handling.
5. **Rotation** → always off v1; reserved field.
6. **Spine multi-page** → supported; each region under its page header.
7. **Missing skeleton** (no `.skel`/skeleton-json/convention) → not a spine group → static (or skipped if user forced spine).
8. **Loose image also a dedup consumer** → excluded from pack in plan.ts (already in `dropped`); spine consumers are hard-kept by Phase C so never double-dropped.
9. **Empty group** → no op.
10. **Stem collision** = two distinct loose files → one region name → `skipped[]`, never overwrite. Shared region across slots is NOT a collision.
11. **Fully-transparent region** → static: 1×1 sentinel (frame resolvable; `trimmed=true`, `sourceSize`=original); spine: skip + surface.
12. **Sheet name collides with an existing non-packed file** in `outDir` → disambiguate `${stem}.packed` or skip + surface (worker step 1).
13. **maxSize < untrimmed size but trim shrinks it under maxSize** → trim first, then pack (handled by packing trimmed dims).

---

## 11. Test plan

**Fixtures** (mirror `single-images`/`spine-basic`: tiny PNGs + `expected.json`):
- `fixtures/sample-projects/loose-static/` — loose PNGs with documented sizes (some transparent margins; a nested subfolder to exercise relative-path frame keys). Golden: one packed sheet + TP JSON that **re-parses via `parseAtlas`** to the expected frames; `meta.image` = sheet basename.
- `fixtures/sample-projects/spine-loose/` — region PNGs (≥1 with transparent margin; ≥1 nested e.g. `items/sword.png`) + a skeleton `.json` **in the modern `skins`-array form** whose attachment `path`s equal the stems (incl. `items/sword`), with: one region attachment using an explicit `path` override (name≠path), one region shared across two slots (legitimate, must NOT collide), one mesh attachment, one linkedmesh (parent-resolved), one clipping attachment (ignored). Golden: emitted `.atlas` re-parses via `parseSpineAtlasText` to a byte-equivalent Atlas; every required attachment path resolves.
- `fixtures/sample-projects/spine-loose-legacy/` — same skeleton with **legacy `skins`-object** form (verifier shape coverage).
- `fixtures/sample-projects/spine-loose-spill/` — enough regions with a forced small `maxSize` so a region lands on page 1 (multi-page).

**Pure golden tests (`packages/fix/test/`):**
1. `trim.test.ts`: `alphaBBox` on a known margined buffer → exact bbox; `spriteSourceSizeFrom` (top-left) + `spineOffsetFrom` (bottom-left Y-flip) numeric goldens; fully-transparent → null.
2. `packLoose.static.test.ts`: known sizes → expected `frame`/`sourceSize`/`spriteSourceSize`; `trimmed` only when bbox≠source; multi-page spill (forced small maxSize) → page0 JSON `meta.image`==page0 image basename, page1 JSON `meta.image`==`${imageBase}_1${ext}`, re-parse via `parseAtlas`; single page → NO suffix; Blit `from.rect`==trimmed bbox.
3. `packLoose.spine.test.ts`: region names preserve nested sub-path; `spriteSourceSize.y` carries bottom-left offset; **NEW-producer offset test** — feed a top-left bbox through `packLoose(kind:'spine')`, assert emitted `offset` is bottom-left (`sourceSize.h-(bbox.y+bbox.h)`) and re-parses to the correct region; multi-page → **each re-parsed region's `frame.xy` within ITS page's size AND region membership per `SpinePage`** (not merely "N blocks exist").
4. **Existing-round-trip guard:** assert the existing repack/`spine-basic` round-trip stays **byte-identical** (proves manifest.ts/spine-atlas.ts unchanged — no §3b regression).
5. **Determinism:** `packLoose` + emit twice deep-equal; shuffled input → identical Atlas[] + identical bytes; **assert `packLoose` sprite order === emitted manifest frame order** (localeCompare).
6. **1×1 sentinel:** static fully-transparent → 1×1 frame re-parses via `parseAtlas` with `trimmed=true`, `sourceSize`=original; assert occupancy/grid analysis doesn't divide-by-zero on a 1px frame.

**Plan/composition tests (`packages/fix/test/plan…`):**
7. A ref with **both** `should-atlas` and `format` findings → exactly **one** pack op, **zero** transcode ops (`packed` guard).
8. A loose ref that is a dedup consumer (in `dropped`) is **never** placed in a pack group.
9. Exactly **one** op touches any packed ref (no pack+transcode/resize double-emit), regardless of pass numbering.

**Worker/verifier tests:**
10. Spine verifier: modern `skins`-array fixture → all required paths resolve; legacy `skins`-object fixture → resolves; unrecognized shape / `.skel` → `packVerification.unverified`, honest warning (not false 0-of-0); attachment with no matching file → `skipped[]`, atlas not silently shipped for it; clipping/point/boundingbox ignored; linkedmesh resolved via parent; `path` override read (name≠path).
11. A packed spine region is **never** in `dropped` (Phase C hard-keep holds).
12. Collision: a loose file already named `${stem}.png` in `outDir` → sheet disambiguated/skipped + `skipped[]`; `out` has no duplicate path before `makeZip`.

---

## 12. Ordered task breakdown

| # | id | Title | Files | Tag | Deps | Acceptance |
|---|---|---|---|---|---|---|
| 1 | core-contract | Core + protocol additions | `packages/core/src/index.ts`, `apps/web/src/worker/fix-protocol.ts` | core | — | `TrimRect`, `LooseRegion`, `PackKind`, `PackGroup`, `FixOp 'pack'`, `FixReceipt.packedSheets`+`packVerification` compile; `typecheck` green; **no existing field changed**. |
| 2 | trim | `trim.ts` pure module | `packages/fix/src/trim.ts`, `packages/fix/src/index.ts` | pure | 1 | `alphaBBox`/`spriteSourceSizeFrom`/`spineOffsetFrom` pass §11.1; uses `RGBASource`/`POLY_ALPHA_THRESHOLD`. |
| 3 | packLoose | `packLoose.ts` pure orchestrator | `packages/fix/src/packLoose.ts`, `packages/fix/src/index.ts` | pure | 1,2 | Reuses `pack()`; emits Atlas[]+Blit[] (rotate90 false); `localeCompare` sort; `pageOfName`; spine offset bottom-left; **rotated===false assert**; §11.2/.3/.5 pass. **manifest.ts/spine-atlas.ts UNCHANGED.** |
| 4 | roundtrip-guard | Existing-round-trip + new-producer offset tests | `packages/fix/test/`, `packages/parsers/test/` | test | 3 | §11.3 new-producer offset + §11.4 existing byte-identical guard pass; `spine-basic` stays green. |
| 5 | grouping | Ingest grouping helper | `packages/ingest/src/index.ts`, `packages/ingest/test/` | pure | 1 | Deterministic spine-root detection (skel/skeleton-json/convention); static per-leaf-folder; **re-applies `maxSpriteEdgePx` per image**; nested region names; output-path-per-mode; file→region collision surfaced. Unit-tested. |
| 6 | plan | Plan integration (pack pass, owners-only, transcode guard) | `packages/fix/src/plan.ts`, `packages/fix/test/` | pure | 1,5 | Pack pass after dedup 0a, before pass 1; excludes refs in `dropped`/`protectedOwners`; builds `packed` set; pass-2 transcode guards `!packed.has`. §11.7/.8/.9 pass: both-findings ref → 1 pack + 0 transcode; consumer never packed. |
| 7 | worker-pack | Worker pack handler + shared compose helper | `apps/web/src/worker/fix.worker.ts` | worker | 2,3,6 | Collision pre-check → alpha-bbox → `packLoose` → per-page compose (no rotation) → encode → emit TP JSON/.atlas (per-page concat) → drop loose → `referencesChanged`+`packedSheets`; `out` path-dedup before zip; shared compose helper used by repack+pack; §11.12 passes. |
| 8 | spine-verify | Spine skeleton verifier | `apps/web/src/worker/fix.worker.ts` (+ tiny pure parse) | worker | 7 | Handles `skins` array AND object; per-type resolution (region/mesh require; linkedmesh→parent; clipping/point/boundingbox/path ignored); reads `path` override; unmatched→`skipped[]`; unrecognized/`.skel`→honest unverified; §11.10/.11 pass. |
| 9 | ui | UI pack control + warnings | `apps/web/src/App.tsx`, `apps/web/src/lib/fix-client.ts` | ui | 1,7 | Mode/grouping/trim controls, explicit opt-in default OFF, inline reference-changing warning; flows into `FixOptions`; receipt shows `packedSheets`/`packVerification`/`skipped`. |
| 10 | i18n | i18n keys (9 catalogs) | `packages/i18n/src/catalogs/*.json` | ui | 9 | `fix.pack.*` (nested controls + `fix.pack.inlineWarn`) + flat `fix.packWarn`; **no `fix.pack.warn`**; all 9 catalogs, identical tokens; drift test green. |
| 11 | fixtures | Fixtures + goldens | `fixtures/sample-projects/loose-static/**`, `spine-loose/**`, `spine-loose-legacy/**`, `spine-loose-spill/**` | test | 3,8 | Fixtures + `expected.json` checked in; static round-trips via `parseAtlas`; spine via `parseSpineAtlasText`; modern+legacy skins; mesh/linkedmesh/clipping/path-override/shared-region/two-file-collision/spill all covered. |

---

## 13. How each skeptic blocker/major was resolved

| Skeptic | Sev | Resolution |
|---|---|---|
| **Spine 1**: verifier must handle `skins` array AND object | blocker | **Accepted.** Verified `skins` is an array in all real skeletons. §5 verifier handles both; unrecognized → honest "paths not verified", never false 0-of-0. Fixtures in both forms (Tasks 8, 11). |
| **Spine 2**: per-attachment-type resolution (mesh/linkedmesh/clipping…) | blocker | **Accepted.** Verified mesh 2740, linkedmesh 510, path 20. §5: region/mesh require a region (read `path` override — 360 real cases); linkedmesh→parent; clipping/point/boundingbox/path ignored. Fixture covers all (Task 11). |
| **Spine 3**: synthesized path vs pass-through collision / no `out` dedup | blocker | **Accepted.** Verified `out`→zip is 1:1, pass-through adds every non-replaced file. §6 step 1 collision pre-check + step 9 `out` path-dedup; edge case 12; Task 7/§11.12. |
| **Spine 4**: grouping vs the global should-atlas finding | major | **Accepted.** Verified single flat global `relatedRefs`. §2/§4: grouping re-derived, re-applies `maxSpriteEdgePx`; finding is UI trigger only. |
| **Spine 5**: pre-existing rotate:270→90 latent bug | major | **Accepted (partial).** Verified 171 `.atlas` use rotate:270. §3c/§5 add a `rotated===false` fail-fast assert at the pack emit boundary; `emitSpineAtlasText` documented rotated:false-only. The existing repack rotate:270→90 mismatch is flagged as a **separate pre-existing bug** (out of Feature 4 scope). |
| **Spine 6**: stem-collision conflated with shared regions | major | **Accepted.** Verified 9400 shared-region cases. §5/edge case 10: collision = two distinct files → one region name; shared region across slots never flagged. Fixture covers both. |
| **Spine 7**: decoy-exclusion speculative | minor | **Accepted.** §13 Q5 + §1: pack-all in v1, defer decoy exclusion (removes a determinism branch). |
| **Spine 8**: emitSpineAtlasText field coverage / PMA | minor | **Accepted.** §3d states the explicit v1 contract (straight-alpha, Linear/Linear, repeat none, no pma, index -1, rotate 0); any future PMA/lossy page gated behind emitting matching fields. |
| **Spine 9**: VRAM honesty for packing | minor | **Accepted.** §6.8: draw-call/bind reduction is the primary win; VRAM presented as "may increase due to POT padding" with measured after-bytes, never a guaranteed saving. |
| **Static 1**: §3b offset framing misstated | minor | **Accepted.** §0/§3b reworded: emitter is NOT buggy; field is bottom-left for spine, top-left for TP; `packLoose` honors the asymmetry. §11.3 reframed as a NEW-producer test. |
| **Static 2**: multi-page imageRef divergence from repack | minor | **Accepted.** §3c states ONE documented scheme, explicitly NOT repackAtlases's (single page = no suffix); §11.2 asserts per-page `meta.image`. |
| **Static 3**: spine multi-page region→page binding | major | **Accepted.** §3d + `pageOfName` (new `packLoose` output) drive per-page `emitSpineAtlasText` concat; §11.3 asserts per-`SpinePage` region membership + a real spill fixture. |
| **Static 4**: alpha-bbox trim vs extrude/bleed | major | **Accepted (defer).** §10 explicitly DEFERS extrude (padding-gutter only, like today's repack) with a documented bleed limitation under Linear filtering/mipmaps. Real extrude is §13 Q7. |
| **Static 5**: determinism — pixel vs manifest, lossy-source trim | minor | **Accepted.** §10: manifest determinism scoped to "given identical decoded input bytes"; lossy-source trim rects are decoder-dependent and surfaced; fixtures are PNG. |
| **Static 6**: pack-OWNERS depends on dedup sets / ordering | minor | **Accepted.** §8: pack pass after dedup 0a, before pass 1; reads existing `dropped`/`protectedOwners`; §11.9 pins one-op-per-ref regardless of pass numbering. |
| **Static 7**: static frame key = relative path is a silent decision | minor | **Accepted.** §4b documents it; surfaced in `fix.packWarn`; per-leaf-folder default minimizes nesting. |
| **Static 8**: 1×1 static sentinel may break frame lookup | minor | **Accepted.** §11.6 asserts the 1×1 sentinel re-parses with `trimmed=true`/`sourceSize`=original and that analysis doesn't divide-by-zero. |
| **Integration 1**: plan.ts pack vs transcode double-emit | blocker | **Accepted.** §8: `packed` set guards pass-2 transcode (`!packed.has`); Task 6 acceptance + §11.7 assert 1 pack + 0 transcode for a both-findings ref. |
| **Integration 2**: §3b "fix" is a no-op / would break round-trip | major | **Accepted.** §3b: manifest.ts/spine-atlas.ts **UNCHANGED**; Y-flip only in `trim.ts`+`packLoose`; Task 4 guards `spine-basic` byte-identical. (Old draft's "Task 3 edit manifest.ts" removed.) |
| **Integration 3**: dedup-consumer exclusion availability/ambiguity | major | **Accepted.** §8: exclusion in plan.ts **only** (not "planFix or worker"); reads pass-0a sets; §11.8 test. |
| **Integration 4**: spine cross-skeleton consumer — Part B has no pack-awareness | major | **Accepted.** Verified Phase C hard-keeps spine consumers (fix.worker.ts:642-646). §8: no Part B change for spine v1; misleading "repoint" dropped; §11.11 asserts packed spine region never in `dropped`. |
| **Integration 5**: static sheet output path for multi-folder modes | minor | **Accepted.** §4c pins `outDir` per grouping mode; `PackGroup.outDir` added to the contract; edge case 12 collision. |
| **Integration 6**: i18n `fix.pack.warn` vs `fix.packWarn` duplication | minor | **Accepted.** §9: controls nested `fix.pack.*` (+ `fix.pack.inlineWarn`), banner flat `fix.packWarn`; `fix.pack.warn` removed. |
| **Integration 7**: grouping comparator (localeCompare vs cmp) | minor | **Accepted.** §3c/§10: `packLoose` sorts with `localeCompare` (matches emitters, repack.ts:96), NOT Part B cmp; §11.5 asserts order == emitted manifest order. |

---

## 14. Open questions (genuine product decisions)

1. **Gating.** Recommend pack behind its **own** explicit "Pack loose" toggle (default OFF), not folded under `aggressive`, so a default Pro run never silently reorganizes a folder. **Confirm.**
2. **Spine sheet format.** Recommend PNG default (runtime-safe); lossless-WebP Spine pages opt-in **only** with an explicit warning the skeleton loader must support WebP atlas pages. **Confirm.**
3. **Static grouping default.** Recommend per-leaf-folder (matches layout; minimizes nested frame keys). **Confirm** (vs one-sheet-for-all).
4. **Fully-transparent region.** Recommend skip + surface for spine (a transparent attachment is a decoy), 1×1 sentinel for static. **Confirm.**
5. **Decoy exclusion (deferred).** v1 packs all candidate loose images regardless of verification (real data showed 0 decoys; avoids a verified/unverified output divergence). Revisit only if a real case shows meaningful waste.
6. **Extrude/bleed (deferred).** v1 = padding-gutter only (matches today's repack), with a documented bleed limitation under Linear filtering/mipmaps. Is a real edge-replicate extrude pass in a near-term follow-up, or acceptable indefinitely for v1?
7. **Rotation (deferred).** v1 forbids rotation (worker can't rotate a blit), costing packing efficiency. Acceptable for v1, or is teaching the worker to rotate a blit (ctx transform + matching `rotate:90`/`rotated:true` emission) a near-term follow-up?