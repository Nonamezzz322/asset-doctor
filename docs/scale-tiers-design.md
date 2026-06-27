All claims verified. Critically confirmed: `spineInfoOf` returns `{ path, pages }`, and multiple page-Atlases of one `.atlas` share the same `info.path` — so the draft's "each page tiered → emitSpineAtlasText per tier to tieredName(info.path)" would clobber to one path, losing all but one page. The existing resize path (line 579) has this exact latent bug for multi-page (it emits one page's `.atlas` to `info.path`), but repack correctly gates `info.pages > 1` (line 400).

I have complete ground truth. Every blocker and major is verified against source. Producing the final plan.

---

# Asset Doctor — SCALE-TIER Export (multi-resolution variant generation) — FINAL implementation-ready plan

Status: implementation-ready, design-only. Composes additively atop Part B (`docs/asset-builder-port-design.md`, `scaleTiers` reserved at `fix-protocol.ts:45`) and Feature 4 (`docs/spritesheet-packing-design.md`). Every contract below is verified against the cited source. **All seven skeptic MustFix items and the three blockers are resolved or rebutted in §14.**

## 0. TL;DR

Scale-tier export generates **downscaled copies** of each asset at a ladder of scales (`1.0`/`0.75`/`0.5` → suffix `_1080p`/`_720p`/`_540p`) so a PixiJS/Phaser game loads the resolution that fits the device. Mechanism is mostly **reuse**: `scaleAtlas` (`repack.ts:29`) scales atlas geometry with the builder's exact `Math.max(1,round(n·scale))` 1px floor + edge-clamp; the worker resize handler (`fix.worker.ts:546-612`) already does canvas-downscale + per-tier encode + manifest re-emit; `scaleAwareQuality` (`settings.ts:26`) is already ported.

**It is NOT a port of the builder's sharp pipeline.** `scaleKernel` (mitchell/lanczos3) and `scalePreBlur` are libvips-only and not browser-portable — we use `OffscreenCanvas` + `imageSmoothingQuality='high'` (the resampler resize/repack already use) and disclose the kernel/pre-blur omission honestly (reusing the **existing** `fix.skipped.whyNoKernel`/`whyNoPreBlur` keys, en.json:163-164).

**Eight corrections from the skeptic review (all source-verified) are baked in:**
1. **scaleAtlas stays a pure geometry primitive** — it does NOT stamp `.scale` (that would inject `meta.scale` into the existing drop-in oversize-resize manifest at `fix.worker.ts:561`, a contract break). The **tier loop** sets `scaled.scale = tier.scale` with exact ladder values only.
2. **scaleAtlas DROPS mesh** (verified `repack.ts:38-49` — no `out.mesh`; line 46 is `pivot`). Tiering is **refused for any atlas carrying a source mesh** (data-driven gate, not the `opts.polygon` toggle), surfaced `fix.tier.meshUnsupported`. A pinned test asserts `scaleAtlas(meshed,0.5).sprites[i].mesh === undefined`.
3. **Round-trip clustering** — variants `aspectBucket = round(w/h·50)` (variants.ts:38) splits ordinary tiers under independent w/h rounding (verified: 100×50 banner → `_720p`=75×38 lands in its own bucket, 57% over-count). Fix: a new **resolution-only stem** path — when a resolution token is detected, cluster by **stem alone** (drop aspectBucket). Implemented in `variants.ts` additively.
4. **Multi-page Spine tiering is GATED to single-page in v1** (mirror the repack `info.pages>1` skip) — per-page emit to a shared `info.path` would clobber. `fix.tier.multiPageSpine`.
5. **Already-tiered detection uses the RESOLUTION-only token subset** `(\d{2,4}p|@?\d+x|hd|sd)`, excluding `png|webp|avif|jpeg` — otherwise png+webp folders are wrongly skipped.
6. **i18n keys are FLAT dotted strings** (en.json is flat throughout; there is no nested convention), ICU plural objects only for counts.
7. **Oversize + tiering** — the tier loop **owns** oversize clamping (computes the clamped top-tier size once, derives every tier from the **same source bitmap** with one `drawImage` each). No separate resize op, no retained-canvas dependency.
8. **Dedup × tiering** — v1: when `aggressive` and `scaleTiers` are both set, **owner-aware repoint is disabled** (legacy keep-consumer), since tiering renames owners and would silently no-op every repoint.

Tiering is **reference-changing**: sets `FixReceipt.referencesChanged`, gated behind its own Pro toggle (default OFF), **never upscales**, and **contributes 0 to `vramSaved`** (tiers are alternatives; the top tier == source footprint).

**Build order:** core/protocol → variants resolution-stem path → pure `scaleLoose`/`tieredName`/`validateTiers` → worker tier loop (owns oversize) → composition/skip gates → honesty/receipt → UI → i18n → fixtures.

---

## 1. SCOPE — reuse vs net-new

| Need | Reused (verbatim) | Net-new |
|---|---|---|
| Atlas geometry downscale (1px floor, edge-clamp) | **`scaleAtlas`** (`repack.ts:29`) — unchanged, pure | none (call per tier; loop sets `.scale`) |
| Per-tier lower encode quality | **`scaleAwareQuality`** (`settings.ts:26`), applied via `effectiveFor` (`fix.worker.ts:214-217`) | pass tier scale (already the 2nd param) |
| Canvas downscale + encode | resize handler (`fix.worker.ts:554-611`), `encodeCanvas`, `composePageEncode`, `emitTexturePackerJson`/`emitSpineAtlasText` | wrap in a per-tier loop |
| Per-asset effective options (folder/type) | `resolveOptions`/`effectiveFor` | tier scale into `effectiveFor` |
| Variant clustering honesty | **`groupVariants`/`stemOf`/`TOKEN`** (`variants.ts:12,23,49`) — the INVERSE | resolution-only stem clustering + round-trip test |
| Suffix ladder default | builder `DEFAULT_SCALES` (`config.ts:7`) | port as `DEFAULT_SCALE_TIERS` |
| Downscale-honesty copy | **existing** `fix.skipped.whyNoKernel`/`whyNoPreBlur` (en.json:163-164) | none — reuse |
| Pass-2 transcode suppression | `packed`/`resized`/`dropped` guards (plan.ts:159) | add `tiered` set |

**Net-new modules/edits:** `packages/fix/src/scale.ts` (`scaleLoose`, `tieredName`, `validateTiers`, `DEFAULT_SCALE_TIERS`, `RESOLUTION_TOKEN`); `variants.ts` resolution-stem clustering + `hasResolutionToken`; `core` `ScaleTier`; `fix-protocol.ts` finalize + `scaleTiered`/`tierVram`; worker tier loop; `plan.ts` `tiered` guard; UI panel; 9-locale i18n; fixtures + round-trip test.

**Explicitly NOT ported** (libvips-only): `scaleKernel`, `scalePreBlur`, `.avif.meta` cache, chokidar. **Format stays orthogonal** (one target per run); resolution × format cartesian is a later slice (§13 Q2).

---

## 2. FINAL `FixOptions.scaleTiers` + core/receipt (exact TS, all additive)

```ts
// core/src/index.ts — NEW additive type (single source of truth)
/** One resolution tier. `scale` ∈ (0,1] (1 = full source; NEVER upscale); `suffix` appended to the
 *  basename stem before the extension. Suffix MUST be a groupVariants resolution token (§4). */
export interface ScaleTier { scale: number; suffix: string }
```

```ts
// fix-protocol.ts — FINALIZE the reserved field (shape unchanged: { scale; suffix }[]; semantics pinned)
/** Multi-resolution scale-tier export (own Pro toggle, DEFAULT OFF). Each entry emits one downscaled
 *  copy of every eligible asset `<name><suffix>.<ext>` at `scale` (atlas via scaleAtlas; loose via
 *  scaleLoose). REFERENCE-CHANGING: the game's loader must select a tier at runtime ⇒ sets
 *  FixReceipt.referencesChanged. INVARIANTS (validated, fail-closed): every scale ∈ (0,1] (1.0 = the
 *  source/top tier, NEVER upscale); suffix non-empty, unique, and a RESOLUTION token groupVariants
 *  recognizes (/^[_-](\d{2,4}p|@?\d+x|hd|sd)$/i, §4). Empty/absent ⇒ single-scale (byte-identical to today). */
scaleTiers?: ScaleTier[];
```

```ts
// fix-protocol.ts — FixReceipt additive optionals (absent ⇒ byte-identical to today)
/** Scale-tier export summary. `assets`/`filesEmitted` count ONLY assets actually tiered (exclude
 *  already-tiered / mesh / multipage-spine / dedup-conflict skips). referencesChanged also set. */
scaleTiered?: { tiers: number; filesEmitted: number; assets: number };
/** Per-tier loaded VRAM (Σ w×h×4 of TIERED assets AT that tier). The runtime loads ONE tier ⇒ the
 *  honest "VRAM if the device picks this tier" ladder. NEVER summed into vramBytesAfter (invariant 5);
 *  tiering contributes 0 to vramSaved (the top tier == source footprint). */
tierVram?: { suffix: string; scale: number; vramBytes: number }[];
```

`DEFAULT_SCALE_TIERS` lives in `packages/fix/src/scale.ts` (a fix-default, like `SCALE_QUALITY_FLOOR`), NOT core:
```ts
export const DEFAULT_SCALE_TIERS: readonly ScaleTier[] = [
  { scale: 1,    suffix: '_1080p' },
  { scale: 0.75, suffix: '_720p'  },
  { scale: 0.5,  suffix: '_540p'  },
]; // == builder DEFAULT_SCALES (config.ts:7), order high→low
```

No new `Rule` (objectivity invariant 3 — diagnosis already reports variant inflation via `variants`; the fix generates what it describes). No new `FixOp` arm — tiering is a worker-side multiplier (§7), keeping `plan.ts` pure and the op union stable.

---

## 3. PURE scaling + per-tier naming/manifests

### 3a. `scaleAtlas` — REUSE UNCHANGED (do NOT stamp `.scale`) — resolves MAJOR

`scaleAtlas(atlas, scale)` (`repack.ts:29`) scales `size` + every frame/sourceSize/spriteSourceSize with `px = Math.max(1, Math.round(n·scale))` and the edge-clamp; preserves `name`/`rotated`/`trimmed`/`pivot` verbatim. **It is left exactly as-is.** The draft's "extend scaleAtlas to stamp `out.scale`" is **REVERSED**: the existing oversize-resize calls `scaleAtlas(atlas, op.to.w/atlas.size.w)` (`fix.worker.ts:561`) with a **fractional ratio**, and `emitTexturePackerJson` emits `meta.scale` whenever `atlas.scale !== undefined` (`manifest.ts:33`), which `parseAtlas` reads via `parseScale` (`atlas.ts:35`). Stamping would inject a machine-dependent `meta.scale:'0.8192…'` into a **drop-in resize manifest the runtime treats as full-res**, changing coordinate interpretation. **Instead, the tier loop sets `scaled.scale = tier.scale` (exact ladder value 1/0.75/0.5) only for tier emits.** Regression test (T2): `scaleAtlas(a,0.5).scale === a.scale` (untouched) and the resize path emits **no** `meta.scale`.

### 3b. `scaleLoose` + `tieredName` + `validateTiers` (NEW pure, Vitest)

```ts
// packages/fix/src/scale.ts (pure)
import type { ImageMime, ScaleTier, Size } from '@asset-doctor/core';
import { EXT } from './...'; // existing mime→ext map used by the worker

/** Resolution-only suffix token set groupVariants recognizes (subset of variants.ts TOKEN, EXCLUDING
 *  format tokens png|webp|avif|jpeg — a "_webp" suffix would mis-stem and collide with format logic). */
export const RESOLUTION_TOKEN = /^[_-](\d{2,4}p|@?\d+x|hd|sd)$/i;

/** Scaled size for a loose image. SAME 1px floor as scaleAtlas/builder. scale>=1 ⇒ identity (never upscale). */
export function scaleLoose(size: Size, scale: number): Size {
  const px = (n: number) => Math.max(1, Math.round(n * scale));
  return scale >= 1 ? { ...size } : { w: px(size.w), h: px(size.h) };
}

/** Insert a tier suffix before the extension, optionally swapping ext for a transcoded mime.
 *  "ui/btn.png"+"_720p" → "ui/btn_720p.png"; +image/webp → "ui/btn_720p.webp". Pure, deterministic.
 *  The top tier (scale 1, "_1080p") is STILL suffixed (round-trip §4). */
export function tieredName(path: string, suffix: string, mime?: ImageMime): string {
  const ext = mime ? EXT[mime] : path.slice(path.lastIndexOf('.'));
  const stem = path.replace(/\.[a-z0-9]+$/i, '');
  return `${stem}${suffix}${ext}`;
}

/** Fail-closed: returns normalized, deduped, high→low-sorted ladder or throws structured error.
 *  Rejects scale>1 (upscale), scale<=0, non-finite, empty/dup suffix, suffix NOT matching
 *  RESOLUTION_TOKEN. The worker turns each rejection into a skipped[] honesty entry. */
export function validateTiers(tiers: ScaleTier[]): ScaleTier[];
```

### 3c. Per-tier manifest naming + `meta.image`/`meta.scale`

For an atlas asset at tier `t`, the worker (reusing the resize/repack emit shape):
- `scaled = scaleAtlas(atlas, t.scale)`; **then `scaled.scale = t.scale`** (loop sets it, not scaleAtlas).
- image path = `tieredName(origImagePath, t.suffix, emittedMime)` (e.g. `ui/hero.png` → `ui/hero_720p.webp`).
- `scaled.imageRef` = the basename of the tiered image, relative to the manifest dir (exactly as resize does at `fix.worker.ts:511-512`) → `emitTexturePackerJson`'s `meta.image` (`manifest.ts:31`) points at the tier's own image; `meta.scale` = `String(t.scale)` (`manifest.ts:33`).
- manifest path = `tieredName(origManifestPath, t.suffix)` keeping `.json` (builder names `${folder}${suffix}.json`, `atlas-builder.ts:564`).

For Spine (single-page only, §10.5): the tier `.atlas` text = `emitSpineAtlasText(scaleAtlas(pageAtlas, t.scale))`, image page = `tieredName(page, suffix, 'image/png')` (Spine pages stay PNG, mirroring `fix.worker.ts:414`), `.atlas` path = `tieredName(info.path, suffix)`. The skeleton (`.json`/`.skel`) is read from `bytesByRefAll` (`fix.worker.ts:89`) and emitted **per tier** under `tieredName(skelPath, suffix)` (concrete copy mechanism — NOT the original-path pass-through at line 929). The original skeleton path is added to `dropped`. (Resolves the Spine major.)

---

## 4. `variants.ts` round-trip — resolution-only stem clustering (resolves BLOCKER)

`groupVariants` (`variants.ts:49`) keys by `stemOf(name)|aspectBucket(size)` where `aspectBucket = round(w/h·50)` (`variants.ts:38`). **Verified break:** a 100×50 banner with the default ladder → 100×50 (bucket 100), 75×38 (bucket 99), 50×25 (bucket 100). The `_720p` tier lands in a singleton bucket → re-analysis reports `loadedVramMax` 31400 vs honest 20000 (57% over-count) and `_720p` drops out of its group. This is **common, not pathological** (any odd-axis 2:1/3:1 art, e.g. 33×17, 17×9). The draft's "rare degenerate / safe direction" framing is **wrong** and is corrected here.

**Fix (additive, in `variants.ts`):** introduce a resolution-aware key. When a name carries a resolution token (i.e. `stemOf` peeled a *resolution* token), cluster by **stem alone** (drop `aspectBucket` from the key); keep `stem|aspectBucket` only for genuine same-stem-different-aspect collisions with no resolution token. Concretely:

```ts
// variants.ts — additive
export function hasResolutionToken(name: string): boolean {
  const base = baseOf(name).toLowerCase().replace(/\.[a-z0-9]+$/, '');
  return /[_-](\d{2,4}p|@?\d+x|hd|sd)$/i.test(base); // resolution subset of TOKEN
}
// in groupVariants: key = hasResolutionToken(it.name)
//   ? stemOf(it.name)                       // resolution variants → stem alone (aspect-safe)
//   : `${stemOf(it.name)}|${aspectBucket(it.size)}`;
```

This keeps the format-variant / aspect-collision behavior for non-resolution files (no diagnosis regression) while guaranteeing every resolution tier of one asset clusters. `loadedVramMax` per group becomes `max(vram across tiers)` = the top tier (correct, one tier loads). The `aspectBucket` threshold itself is **untouched** (calibrated, diagnosis-side).

**Token contract for generation:** every default suffix `_1080p`/`_720p`/`_540p` matches `\d{2,4}p`; `validateTiers` enforces `RESOLUTION_TOKEN` (§3b) so generated suffixes are always recognized AND `hasResolutionToken` fires on the output. A user custom suffix outside the set is rejected at config time (`fix.tier.badSuffix`).

**Round-trip test (§11 T-RT)** widened to odd/non-divisible sizes (100×50, 33×17, 3×100) asserting `members.length === tiers.length` and `loadedVramMax === top-tier VRAM per asset`. Also asserts a `loadedVram` lower-bound (never under-counts) so a future rounding change can't silently flip direction.

---

## 5. WORKER multi-emit — the tier loop

A new worker pass wraps the per-asset transforms. **No new `FixOp`** — the worker reads `opts.scaleTiers`; when non-empty (and validated) it runs the tier loop **instead of** the single-scale emit for tier-eligible assets (single-scale repack/resize/transcode/pack branches defer all `out.push` to the tier loop for those refs — resolves the emit-ownership minor). Per eligible asset, per validated tier (high→low):

1. **Top-tier size (oversize clamping owned here, resolves MAJOR).** Compute `clampedTopW/H` = the source size clamped to `maxEdge` (the same `maxEdge/longest` math as `plan.ts:143`) ONCE. There is **no separate resize op** for tiered refs (`plan.ts` excludes them via the `tiered` set, §7). Each tier's target = `round(clampedTop·tier.scale)` (1px floor). Atlas: `scaled = scaleAtlas(atlas, effectiveScale)` where `effectiveScale = (clampedTop/atlasSrc)·tier.scale`; loose: `dst = scaleLoose(clampedTop, tier.scale)`.
2. **Never-upscale guard.** `validateTiers` forbids `scale>1`; the worker additionally clamps and uses the `scale>=1 ⇒ identity` branch for the top tier (no needless recompress of an un-oversized source; if oversized, the top tier IS the clamp resample).
3. **Downscale (impure) from the SAME source bitmap.** `OffscreenCanvas(dst.w,dst.h)`; `c2d.imageSmoothingQuality='high'` (`fix.worker.ts:569,600`); one `drawImage(srcBmp, 0,0,srcW,srcH, 0,0, dst.w,dst.h)` per tier (single resample chain from source, never tier-from-tier). Atlas sheet: whole-sheet `drawImage` downscale (matches resize-atlas at `fix.worker.ts:570`); frames already scaled by `scaleAtlas`.
4. **Encode via `scaleAwareQuality`.** `eff = effectiveFor(ref, tier.scale)` (`fix.worker.ts:214`) folds folder/type overrides AND applies `scaleAwareQuality`. Loose tiered name uses the POST-transcode mime (`eff.targetMime`), so a format+tiered image yields one encode per tier at the target mime (resolves the transcode-composition minor).
5. **Emit image + manifest under tiered names** (§3c); set `scaled.scale = tier.scale`.
6. **Source handling — enumerate ALL original paths to drop** (resolves minor): add to `dropped`/`replaced` the COMPLETE set so the pass-through (`fix.worker.ts:929`) and out-path dedup (last-write-wins by path, `:937-945`, which does NOT catch original-vs-suffixed) never emit an un-suffixed original beside `_1080p`:
   - loose: `imagePath`.
   - atlas: `imagePath` + `manifestPath`.
   - spine: page path(s) + `.atlas` path + skeleton `.json`/`.skel` path (skeleton lives in `bytesByRefAll`, not `pathByRef` — drop it explicitly).
7. **Receipt.** `scaleTiered.filesEmitted`/`assets` count only actually-tiered assets; `tierVram[i].vramBytes += dst.w·dst.h·4`; `referencesChanged = true`. **Tiering adds 0 to `vramSaved`** → `vramBytesAfter` stays the top-tier footprint (§6).

---

## 6. HONESTY

- **Reference-changing.** Set `referencesChanged = true` + a dedicated `fix.tierWarn` banner: "Generated N resolution tiers per asset. Your game's loader must select the right tier at runtime (e.g. by devicePixelRatio / screen size). The source files were renamed to the top tier." Mirrors `fix.mergeWarn`/`fix.packWarn`.
- **Downscale-quality.** **Reuse the existing keys** `fix.skipped.whyNoKernel` + `fix.skipped.whyNoPreBlur` (en.json:163-164) — no new key invented. Strengthen the UI note's concrete consequence: heavy downscale (≤0.5×) may show aliasing that lanczos3 would avoid. We do NOT fake kernels. `scaleAwareQuality` IS applied (the one ported knob) and disclosed.
- **`imageSmoothingQuality` is a hint** (may be ignored, esp. OffscreenCanvas in workers) — disclosed; optional follow-up: also try `createImageBitmap(blob,{resizeQuality:'high',resizeWidth,resizeHeight})` and keep the sharper, never claiming libvips parity.
- **Pixel non-determinism.** Manifests/geometry ARE byte-deterministic (`scaleAtlas` integer math + deterministic emitters); downscaled PIXELS are NOT cross-machine stable (canvas resampler) — same scope as today's resize/repack. No byte-repro claim for tier images.
- **disk ≠ VRAM (pinned rule, resolves minor).** Tiering **contributes 0 to `vramSaved`**; for a tiering-only run `vramBytesAfter === vramBytesBefore` (no false VRAM "win" — nobody loads full+low at once). `tierVram` exposes the per-tier ladder (`_540p` = 0.25× `_1080p` VRAM). **`diskBytesAfter` WILL increase** (N tiers shipped) — the UI explicitly states this is expected and the win is per-device download + per-device VRAM (so the disk delta isn't misread as a regression). Receipt invariant test: tiering-only run ⇒ `vramBytesAfter === vramBytesBefore`.

---

## 7. COMPOSITION + OP ORDERING

Tiering is the **outermost** transform multiplier, applied per-asset after all single-asset decisions, owning oversize clamping for tier-eligible refs.

```
dedup pass 0a (drops; owners protected)
 → pack pass (Feature 4: owned loose → sheets)
 → pass 0 atlas-merge
 → pass 1 repack   [tiered refs EXCLUDED from oversize-resize via `tiered` set — §7 oversize]
 → pass 2 transcode [guarded by resized/dropped/packed/TIERED — §7 transcode]
 → Phase C dedup rewrites/drops [owner-aware repoint DISABLED when aggressive && scaleTiers — §7 dedup]
 ── then, per surviving emitted asset (atlas/packed sheet, non-oversized loose) ──
 → TIER MULTIPLIER (owns oversize clamping; emits each tier; §5)
 → out path-dedup → zip
```

**Oversize × tiering (no double-resize, resolves MAJOR — implementable).** Do NOT depend on "the resize op's output canvas" (it's `convertToBlob`'d and dropped — not retained). Instead: a `tiered` Set in `plan.ts` (mirroring `packed`/`resized`, added to the pass-1 oversize guard at `:142` and computed when `scaleTiers` non-empty) excludes tier-eligible refs from producing a standalone resize op. The tier loop computes `clampedTop = clamp(source, maxEdge)` once, then derives every tier from the **same source bitmap** with one `drawImage` per tier (single resample chain). A 5000px source, `maxEdge=4096`: `_1080p`=4096, `_720p`=0.75·4096=3072, `_540p`=0.5·4096=2048.

**Transcode × tiering (resolves minor).** Add a `tiered` set to the `plan.ts:159` pass-2 guard (`&& !tiered.has(f.assetRef)`) so a format+tiered loose image yields exactly N tier encodes and **zero** orphan transcode op. The tier loop applies `eff.targetMime` per tier.

**Dedup × tiering (v1 decision, resolves MAJOR).** `predictOwnerFinalNames` (`fix.worker.ts:274`) predicts the owner keeps its un-suffixed name; tiering renames the owner to `_1080p/…`, diverging from the prediction → Phase C's `actual.image !== predicted.image` check (`:860`) would flip **every** consumer to `looseRepathSkipped` (dedup silently becomes a no-op). **v1: when `aggressive` AND `scaleTiers` are both set, disable owner-aware repoint entirely** (force legacy keep-consumer; surface `fix.tier.dedupConflict` once). Rationale: tier-aware owner-name resolution is a per-tier rename map the round-trip can't yet verify; fail-safe per the dedup-keep precedent. (§13 Q1 keeps the per-tier resolution as a later option.) **Loose images whose refs may live in game code:** dedup refuses to rename these (`fix.worker.ts:906-909`); tiering renames them to `_1080p` regardless — a **strictly stronger** reference break, mitigated only by the explicit opt-in + `referencesChanged` + a louder inline warning than dedup's keep. Documented as Risk 2.

**Pack / repack / merge × tiering (v1 SCOPE — honest skip, not silent).** The tier loop runs over the
PRE-transform asset list (`merged`), so a sheet EMITTED by repack / atlas-merge / Feature-4 pack is NOT
re-fed into tiering in v1 (the ordering diagram's "tier the emitted sheet" is a follow-up, see §13 Risks).
**This must be HONEST, not silent:** when a tiering-on run skips a repacked/merged/packed ref the worker
pushes a `skipped[]` entry ("asset was repacked/merged/packed (its sheet is not tiered in v1)") so the
receipt count reflects it, and the UI panel states the limitation. Packed loose sources are already in
`dropped` → not separately tiered either. The common headline case (an under-filled atlas the user enabled
tiers on gets repacked → no tiers) therefore produces a visible skip note, never a confusing single-resolution
zip with no explanation. Lifting this to "tier the emitted sheet" (re-running the tier loop over `out`
entries from those passes, mesh-free by construction) is a real follow-up, not a v1 silent no-op.

---

## 8. DETECT / SKIP already-tiered input (resolution-token subset — resolves MAJOR)

Do NOT tier an asset already a tier (`hero_720p.png` → `hero_720p_540p.png` is nonsense + breaks clustering). Detection uses the **resolution-only** subset, NOT the full `TOKEN` (which includes `png|webp|avif|jpeg` — a `sprite_webp.png` or png+webp folder would be wrongly skipped):

- **Per-asset:** `hasResolutionToken(ref)` (§4) — basename ends in `(\d{2,4}p|@?\d+x|hd|sd)`. If true, skip tiering that asset, add to `skipped[]`.
- **Whole-folder:** if `groupVariants` produces groups whose members differ by a **resolution** token specifically (members share a resolution-stem and differ in size), the folder already ships tiers → skip tiering globally, surface `fix.tier.alreadyTiered`. A png+webp-only folder (format variants, same size) does NOT trip this.
- **Partial folder:** skip only the tokened assets; tier the rest.
- **Escape hatch:** `tierForce` (mirrors `packForced`) bypasses the skip for the rare legit case (§13 Q5). Given the false-positive risk around `*_hd`/`*_2x` art, this hatch ships in v1.

---

## 9. UI + i18n

New collapsible **"Generate resolution tiers"** panel in `FixCard` (`App.tsx`), Pro + explicit opt-in, **default OFF** (like Feature 4):
- **Enable** checkbox (`scaleTiers` empty when off).
- **Preset radio:** `1080p/720p/540p` (default = `DEFAULT_SCALE_TIERS`) | `1080p/540p` | `Custom`.
- **Custom rows** (no free-text pixels): scale slider (0–1, step 0.05) + suffix dropdown limited to the `RESOLUTION_TOKEN` set (`@2x`/`@1x`/`hd`/`sd`/`_720p`…) so clustering is guaranteed; invalid combos disabled with a `title` explaining the round-trip requirement.
- **Inline reference-changing warning:** "Tiers require resolution-aware loading. The source becomes the top tier. Not a drop-in replacement."
- **Downscale honesty note** (reuse `fix.skipped.whyNoKernel`/`whyNoPreBlur`).
- **Post-run receipt:** `scaleTiered` (tiers/files/assets), the `tierVram` ladder rendered "VRAM per device tier: 1080p X MB · 720p Y MB · 540p Z MB", a **per-tier file-size column**, an explicit "total disk increases (N tiers shipped) — the win is per-device download + VRAM" note, and `skipped[]`.

`fix-client.ts` forwards `scaleTiers` through `runFix` (thin pass-through; the field already exists on `FixOptions`).

**i18n — FLAT dotted keys (no nested objects; en.json is flat throughout, verified :119-185).** New flat keys: `fix.tier.title`, `fix.tier.enable`, `fix.tier.preset.three`, `fix.tier.preset.two`, `fix.tier.custom`, `fix.tier.inlineWarn`, `fix.tier.diskNote`, `fix.tier.vramLadder`, `fix.tier.alreadyTiered`, `fix.tier.badSuffix`, `fix.tier.dedupConflict`, `fix.tier.meshUnsupported`, `fix.tier.multiPageSpine`, `fix.tierWarn`. ICU **plural object** only for counts (e.g. `fix.tier.receipt` "N tiers / N files", mirroring `fix.meshedCount` :144 and `fix.dedup.referencesRewritten` :174). **Reuse** `fix.skipped.whyNoKernel`/`whyNoPreBlur` for the downscale note. All keys in all 9 catalogs (en/ru/de/es/pt/fr/it/zh/hi) with identical placeholder tokens before `pnpm test` (drift test is strict). English authoritative; CLI stays EN; `skipped[]` reasons stay engineering strings rendered as localized counts.

---

## 10. DETERMINISM + edge cases

**Determinism:** tier iteration sorted high→low (validated, deduped); `scaleAtlas`/`scaleLoose` integer-only; suffix injection deterministic; manifests deterministic (`manifest.ts` sorts frames, fixed keys, no timestamps). **Scope:** manifest/geometry byte-stable; downscaled PIXELS are not (canvas resampler).

**Edge cases:**
1. **Upscale forbidden** — `validateTiers` rejects `scale>1`; identity branch copies source for a `1.0` tier (no resample on an un-oversized source).
2. **NPOT per tier** — `scaleAtlas` does NOT re-POT (correct for a *resolution* tier; the sheet shrinks uniformly, frames stay valid; PixiJS v8 handles NPOT). Re-POT would be a repack, out of scope. Accept NPOT tiers in v1 (§13 Q4).
3. **Oversized source** — §7: tier loop owns the clamp; lower tiers derive from the clamped top, single resample chain.
4. **1px floor** — `Math.max(1,…)` in both primitives; edge-clamp keeps frames inside the floored sheet.
5. **Atlas / loose / single-page spine / packed** — atlas: `scaleAtlas`+sheet downscale+TP JSON; loose: `scaleLoose`+canvas+encode; **spine: single-page only** (`info.pages===1`), per-tier `.atlas`+PNG page + per-tier skeleton copy; packed: tiered as atlas.
6. **Already-tiered** — §8 (resolution-only).
7. **Aspect bucket** — RESOLVED in §4 (resolution-stem clustering); no longer a risk.
8. **Single tier `{1,'_1080p'}`** — valid: renames every asset to the top suffix, no downscale (naming consistency before adding lower tiers).
9. **Source meshes (resolves BLOCKER).** `scaleAtlas` DROPS mesh (verified `repack.ts:38-49`; the draft's "copies at :46" was the `pivot` line). `parseAtlas` reads source meshes (`atlas.ts:108-109`), so a non-polygon drop-in run could carry `Sprite.mesh`. **Gate on the DATA, not `opts.polygon`:** refuse to tier ANY atlas where some sprite has `Sprite.mesh`, surfacing `fix.tier.meshUnsupported`, regardless of the toggle. Pinned test: `scaleAtlas(meshed,0.5).sprites[i].mesh === undefined`. Scaling mesh `vertices`/`verticesUV` is the real precondition for lifting the gate (§13 Q6) — not presented as a mere follow-up of the toggle.
10. **Multi-page Spine (resolves BLOCKER).** The Spine model is ONE Atlas per page (`spine-atlas.ts:2`); all pages of one `.atlas` share `info.path` (`fix.worker.ts:140,146`). Per-page emit to `tieredName(info.path,suffix)` would clobber to one path, losing pages, and `emitSpineAtlasText` writes a single page. **v1: gate tiering to single-page Spine** (mirror the repack `info.pages>1` skip at `:400`), surface `fix.tier.multiPageSpine`. The "multi-page CAN be tiered" claim is dropped. A real multi-page `.atlas` assembler (concatenate N scaled page-Atlases into one tiered `.atlas`) is a follow-up.

---

## 11. TEST PLAN

**Pure (`packages/fix/test/scale.test.ts`):**
- **T1 `scaleLoose`** — `{100,50}`@0.5→`{50,25}`; `{3,3}`@0.5→`{2,2}`; floor `{1,10}`@0.5→`{1,5}`; `scale>=1` identity.
- **T2 `scaleAtlas` purity (regression)** — `scaleAtlas(a,0.5).scale === a.scale` (NOT stamped); resize-path emit produces TP JSON with **no** `meta.scale` (byte-identical to today); meshed atlas → `out.sprites[i].mesh === undefined`.
- **T3 `tieredName`** — `ui/btn.png`+`_720p`→`ui/btn_720p.png`; +`image/webp`→`ui/btn_720p.webp`; `.json` kept.
- **T4 `validateTiers`** — rejects `scale>1`, `<=0`, dup/empty suffix, `_webp` (format token); sorts high→low; default ladder passes.

**Round-trip (`packages/fix/test/scale.roundtrip.test.ts`) — THE key test (§4):**
- **T-RT** — loose + atlas fixtures incl. **odd sizes (100×50, 33×17, 3×100)** → generate tiers → re-ingest (`groupFiles`+`parseImage`/`parseAtlas`+`analyze`) → assert each asset's tiers cluster (`members.length===tiers.length`) via the resolution-stem path, `loadedVramMax === top-tier VRAM per asset` (not the sum), and `loadedVram` is never under-counted (safe-direction contract).

**Variants (`packages/analysis/test/variants…`):**
- **T-V** — `hasResolutionToken` true for `_720p`/`@2x`/`hd`, false for `_webp`/plain; resolution-stem clustering groups 100×50/75×38/50×25 together; png+webp same-size folder NOT declared resolution-tiered.

**Plan/composition:**
- **T5 no double-resize** — oversized + tiers → top tier = `maxEdge` clamp, lower tiers = scale × clamp; no standalone resize op for the ref (`tiered` set).
- **T6 dedup conflict** — `aggressive`+tiers → owner-aware repoint disabled, `fix.tier.dedupConflict` surfaced, no consumer repointed at a tiered owner.
- **T7 packed sheet tiered** — pack+tiers → packed sheet emitted per tier; loose sources never separately tiered.
- **T8 already-tiered skip** — `hero_720p`/`hero_1080p` folder → skipped, `fix.tier.alreadyTiered`; png+webp folder → NOT skipped.
- **T-FMT** — format+tiered loose image → exactly N tier encodes at target mime, zero orphan transcode (`tiered` guard in pass-2).

**Worker/receipt:**
- **T9 multi-emit** — N assets × 3 tiers → `scaleTiered.filesEmitted` correct; source renamed to `_1080p` (NOT duplicated) — assert no un-suffixed original survives in the zip for loose+atlas(image+manifest)+spine(page+atlas+skeleton); `tierVram` = 1×/0.5625×/0.25×; `referencesChanged===true`.
- **T10 meta.scale** — tier TP JSON has `meta.scale==="0.75"` and re-parses; resize path still emits none.
- **T11 spine tier** — single-page Spine → page+`.atlas`+skeleton per tier under suffixed names, `.atlas` re-parses; multi-page Spine → skipped with `fix.tier.multiPageSpine`.
- **T12 mesh refuse** — atlas with source mesh + tiers → tiering refused, `fix.tier.meshUnsupported`, no rectangle-only tier emitted.
- **T13 VRAM honesty** — tiering-only run ⇒ `vramBytesAfter === vramBytesBefore`; `vramSaved` contribution 0.

**Fixtures:** `fixtures/sample-projects/tier-source/` (loose PNG incl. an odd 100×50, a small TP atlas, a **single-page** Spine, a meshed TP atlas, a 2-page Spine for the skip test) + golden `expected.json` (tiered output names + per-tier sizes).

---

## 12. ORDERED TASK BREAKDOWN

| # | id | Title | Files | Tag | Deps | Acceptance |
|---|---|---|---|---|---|---|
| 1 | tier-core | Core + protocol finalize | `packages/core/src/index.ts` (`ScaleTier`), `apps/web/src/worker/fix-protocol.ts` (finalize `scaleTiers`, add `scaleTiered`/`tierVram`) | core | — | `ScaleTier` compiles; `scaleTiers: ScaleTier[]`; receipt fields additive; `typecheck` green; no existing field changed. |
| 2 | tier-variants | Resolution-stem clustering + `hasResolutionToken` | `packages/analysis/src/variants.ts` | analysis | 1 | T-V passes; resolution variants cluster by stem alone; non-resolution behavior unchanged; existing variants tests green. |
| 3 | tier-scale-pure | `scale.ts` pure module | `packages/fix/src/scale.ts`, `packages/fix/src/index.ts` | pure | 1 | `scaleLoose`/`tieredName`/`validateTiers`/`DEFAULT_SCALE_TIERS`/`RESOLUTION_TOKEN` pass T1,T3,T4. |
| 4 | tier-scaleatlas-pin | Pin `scaleAtlas` purity (no `.scale` stamp; drops mesh) | `packages/fix/test/repack…` | pure | 1 | T2: `scaleAtlas(a,0.5).scale===a.scale`; meshed atlas → `mesh===undefined`; resize emit byte-identical (no `meta.scale`). |
| 5 | tier-roundtrip | Round-trip token test | `packages/fix/test/scale.roundtrip.test.ts` | analysis | 2,3 | T-RT (incl. odd sizes) passes; clustering + loaded-VRAM = one tier/asset; never under-counts. |
| 6 | tier-worker | Worker tier loop (owns oversize) | `apps/web/src/worker/fix.worker.ts` | worker | 3,4 | Per-asset×tier emit (atlas/loose/single-page spine/packed); tier loop owns oversize clamp (single resample chain); `effectiveFor(ref,tier.scale)`; loop sets `scaled.scale`; source→top-tier rename, no un-suffixed survivor; T9/T10/T11/T12 pass. |
| 7 | tier-skip-gates | Already-tiered / mesh / multipage-spine gates | `apps/web/src/worker/fix.worker.ts`, `packages/analysis/src/variants.ts` | worker | 2,6 | T8/T11(skip)/T12: resolution-only already-tiered skip + `tierForce`; mesh-present refuse; multi-page spine skip. |
| 8 | tier-compose | Composition + plan guards | `packages/fix/src/plan.ts` (`tiered` set in oversize + pass-2 guards), `apps/web/src/worker/fix.worker.ts` (dedup-repoint disable) | worker | 6 | T5 (no double-resize), T-FMT (no orphan transcode), T6 (dedup repoint disabled when aggressive+tiers). |
| 9 | tier-honesty | Receipt + tierVram + referencesChanged | `apps/web/src/worker/fix.worker.ts`, `fix-protocol.ts` | worker | 6 | `scaleTiered`/`tierVram` count only tiered assets; `referencesChanged`; T13: tiering adds 0 to `vramSaved`, `vramBytesAfter===vramBytesBefore`. |
| 10 | tier-ui | UI panel + presets + warnings | `apps/web/src/App.tsx`, `apps/web/src/lib/fix-client.ts` | ui | 1,6,9 | Default-OFF panel; presets + validated custom rows; inline reference-changing + reused downscale note + disk-increase note; flows `scaleTiers`; receipt shows ladder + per-tier sizes. |
| 11 | tier-i18n | i18n keys (9 catalogs, FLAT) | `packages/i18n/src/catalogs/*.json` | ui | 10 | All `fix.tier.*` (flat) + `fix.tierWarn` + ICU plural `fix.tier.receipt` in all 9, identical tokens; reuse `whyNoKernel`/`whyNoPreBlur`; drift test green. |
| 12 | tier-fixtures | Fixtures + goldens | `fixtures/sample-projects/tier-source/**` | test | 3,6 | Fixture (odd-size loose + atlas + single-page spine + meshed atlas + 2-page spine) + `expected.json`; consumed by T-RT/T9/T11/T12. |

---

## 13. RISKS & OPEN QUESTIONS

**Risks:**
1. **Source-rename surprise** — `hero.png` → `hero_1080p.png` is the most reference-changing part; mitigated by explicit opt-in + inline warning + `referencesChanged`.
2. **Loose-ref-in-game-code break** — tiering renames loose images whose refs may live in game code (the exact case dedup refuses, `fix.worker.ts:906-909`); a strictly stronger break than the dedup keep, mitigated only by opt-in + a louder warning. Decided acceptable for an explicit Pro action; documented.
3. **No browser kernel control** — quality below builder's mitchell/lanczos3 + pre-blur, esp. at 0.5×; disclosed (reused keys), not faked; `scaleAwareQuality` partially compensates the encode side.
4. **Output explosion** — N assets × 3 tiers multiplies zip size + worker time; default-OFF + a pre-run worst-case file-count mitigate; diagnosis ≤10s untouched (tiering is an explicit Pro action).
5. **Mesh / multi-page Spine gated out** — v1 refuses both; if commonly wanted, scaling mesh coords / a multi-page `.atlas` assembler are real follow-ups (Q6, §10.10).

**Open questions (genuine product decisions):**
1. **Dedup + tiering coexistence** — v1 disables owner-aware repoint when both on. Invest in per-tier owner-name resolution (owner final-name becomes a per-tier set, consumers repoint at the matching tier) later, or keep mutually-exclusive permanently?
2. **Format × resolution cartesian** — builder emits `_webp`/`_avif` per tier. v1 keeps format orthogonal (one target/run). Add the cartesian (3 tiers × 2 formats = 6 files/asset) behind the same panel later?
3. **Top-tier resample policy** — v1 copies the source unscaled for `scale:1` on an un-oversized asset (no recompress). Confirm vs always re-encoding through the target codec for size consistency?
4. **NPOT tiers** — accept NPOT tier sheets (v1), or offer opt-in re-POT-per-tier (a repack inside the tier loop, heavier)?
5. **Already-tiered override** — `tierForce` ships in v1 given `*_hd`/`*_2x` false-positive risk. Keep, or make the skip absolute?
6. **Mesh + tiering** — refused in v1 on mesh presence. Prioritize scaling `mesh.vertices`/`verticesUV` in `scaleAtlas` (the precondition to lift the gate)?
7. **Multi-page Spine** — gated out in v1. Build a multi-page `.atlas` assembler (also fixes the latent resize-path bug at `fix.worker.ts:579`)?

---

## 14. RESOLUTION TABLE — skeptic blockers & majors

| Skeptic finding | Sev | Verified? | Resolution |
|---|---|---|---|
| Round-trip aspect-bucket split for ordinary assets (100×50 → 57% over-count, `_720p` drops out) | BLOCKER | YES (`variants.ts:38`, math reproduced) | §4: resolution-only stem clustering (cluster by stem alone when a resolution token present); `aspectBucket` untouched. T-RT widened to odd sizes. Re-scoped from "rare" to common. |
| Multi-page Spine per-page emit clobbers to one `info.path`, loses pages | BLOCKER | YES (`spine-atlas.ts:2`, `fix.worker.ts:140/146/579`) | §10.10: gate tiering to single-page Spine (mirror repack `info.pages>1` skip), `fix.tier.multiPageSpine`; drop the "multi-page CAN be tiered" claim. |
| `scaleAtlas` DROPS mesh (draft said "copies at :46"); non-polygon run silently downgrades meshed regions | BLOCKER | YES (`repack.ts:38-49`; :46 is `pivot`; `atlas.ts:108-109`) | §10.9: data-driven refuse on `Sprite.mesh` presence (not `opts.polygon`); `fix.tier.meshUnsupported`; pinned test mesh→undefined. Factual claim corrected. |
| Stamping `out.scale` in `scaleAtlas` injects `meta.scale` into drop-in resize manifest | MAJOR | YES (`fix.worker.ts:561`, `manifest.ts:33`, `atlas.ts:35`) | §3a: REVERSED — `scaleAtlas` unchanged; tier loop sets `scaled.scale` (exact ladder) only. T2 regression: resize emits no `meta.scale`. |
| "Tier from the resize op output canvas" not implementable (canvas dropped after `convertToBlob`) | MAJOR | YES (`fix.worker.ts:570-574,601-607`) | §7: tier loop OWNS oversize clamping; `tiered` set in `plan.ts` excludes a standalone resize op; every tier derived from the same source bitmap (single resample chain); loose tiered name from post-transcode mime. |
| Spine skeleton "pass-through per tier" is net-new impure work, not reuse | MAJOR | YES (pass-through `:929` emits original paths; skeleton in `bytesByRefAll` `:89`) | §3c: read skeleton from `bytesByRefAll`, emit `tieredName(skel,suffix)` per tier, drop original; T11 re-parses each pair. (v1 single-page only.) |
| Owner rename diverges from `predictOwnerFinalNames` → all consumers flip to `looseRepathSkipped` (dedup silent no-op) | MAJOR | YES (`fix.worker.ts:274-288,860`) | §7: v1 disables owner-aware repoint when `aggressive && scaleTiers`; `fix.tier.dedupConflict`. Loose-ref-in-game-code stronger break documented (Risk 2). |
| i18n "nested under fix.tier.*" contradicts flat catalog; reinventing `whyNoKernel`/`whyNoPreBlur` | MAJOR | YES (en.json flat `:119-185`, keys exist `:163-164`) | §9: FLAT dotted keys; ICU plural only for counts; reuse existing downscale-honesty keys. |
| Already-tiered detection on full TOKEN wrongly skips png+webp folders / `*_hd` art | MAJOR | YES (`variants.ts:12` includes `png\|webp\|avif\|jpe?g`) | §8: detect via RESOLUTION-only subset; whole-folder skip requires resolution-differing members; `tierForce` escape hatch. |
| Source-rename emit ownership under-specified; un-suffixed original may survive | MINOR | YES (path-dedup `:937-945` is last-write by path) | §5 step 6: enumerate ALL original paths to `dropped` per asset kind; single-scale branches defer `out.push` for tiered refs; T9 asserts no un-suffixed survivor. |
| `imageSmoothingQuality:'high'` is a hint; understated | MINOR | YES (browser hint) | §6: concrete aliasing consequence at ≤0.5× disclosed; optional `createImageBitmap resizeQuality` follow-up, never claim libvips parity. |
| transcode+tiered yields orphan standalone transcode (no `tiered` guard in pass-2) | MINOR | YES (`plan.ts:159` guards resized/dropped/packed only) | §7: add `tiered` to pass-2 guard; T-FMT asserts N encodes, 0 orphan. |
| VRAM honesty: tiering must add 0 to `vramSaved`; disk increase unsurfaced | MINOR | YES (`fix.worker.ts:956` `vramBefore-vramSaved`, `:950` disk sum) | §6: pinned rule (0 to `vramSaved`; T13 `vramBytesAfter===vramBytesBefore`); UI states disk increases by design; `tierVram`/counts exclude skips. |
| NPOT tiers / dedup-conflict gate ordering ambiguity | MINOR | partial | §10.2 accept NPOT v1 (Q4); §7 dedup gate is a simple pre-condition (`aggressive && scaleTiers`), evaluated before the loop, no Phase-C race. |

---

## 15. REMAINING OPEN QUESTIONS (product decisions, not blockers)

The seven in §13 — most consequential: **(1)** dedup+tiering coexistence (v1 mutually exclusive vs per-tier owner resolution), **(2)** format×resolution cartesian, **(6)** mesh-coord scaling to lift the mesh gate, **(7)** multi-page Spine assembler (also fixes the latent resize bug at `fix.worker.ts:579`). All have safe v1 defaults; none block implementation.

**Key files (absolute):**
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/repack.ts` (`scaleAtlas` :29 — reuse UNCHANGED; drops mesh :38-49)
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/settings.ts` (`scaleAwareQuality` :26 — reuse)
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/manifest.ts` (`meta.scale` :33, `meta.image` :31 — reuse)
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/plan.ts` (pass-2 guard :159, oversize :142, `packed`/`resized` sets :50-55 — add `tiered`)
- `/home/nonamezzz/Рабочий стол/projects/packages/analysis/src/variants.ts` (`TOKEN` :12, `stemOf` :23, `aspectBucket` :38, `groupVariants` :49 — resolution-stem fix + `hasResolutionToken`)
- `/home/nonamezzz/Рабочий стол/projects/packages/parsers/src/spine-atlas.ts` (one Atlas per page :2), `/.../parsers/src/atlas.ts` (`parseScale` :35, mesh read :108-109)
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix.worker.ts` (resize :546-612, `effectiveFor` :214, `composePageEncode` :310, Spine info :135-146, predict/Phase-C :274-288/851-926, pass-through :929, path-dedup :937-945)
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix-protocol.ts` (`scaleTiers` :45, `FixReceipt` :74 — finalize)
- `/home/nonamezzz/Рабочий стол/projects/packages/core/src/index.ts` (add `ScaleTier`)
- `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/en.json` (FLAT keys; `whyNoKernel`/`whyNoPreBlur` :163-164 — reuse)
- NEW: `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/scale.ts`
- Reference (do NOT port): `/home/nonamezzz/Загрузки/assets-builder/assets-builder/src/config.ts` (`DEFAULT_SCALES` :7), `scale-processor.ts` (kernel/preBlur — libvips-only), `atlas-builder.ts` (`meta.scale` :629, `copySkeletonJsons` :861)