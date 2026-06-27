All facts confirmed. Critical finding: the builder comparator is raw lexicographic `<`/`>` (NOT localeCompare — skeptic correct), and variation grouping uses `path.basename(manifest.relativePath)` (the manifest's name) with a `general` fallback (`?? owners.general`). I now have everything needed to write the final plan addressing every blocker.

I have all the verification I need. Producing the final plan.

---

# Asset Doctor — FINAL Plan: Owner/Consumer Dedup + Optimization Settings + Lazy-Aware Owner Selection

Status: implementation-ready, build-on-approval. No files edited. Every skeptic blocker/major resolved or rebutted below; the resolution table is §13.

## TL;DR

Three features, sliced to ship independently behind the existing Pro `FixCard`. The skeptics killed the original Feature-1b mechanism (cross-atlas `linkedFrames` frame-redirect) — **it does not exist in AD, AD's own parser can't re-parse it, and stock PixiJS/Phaser ignore it, so it breaks the "drop-in folder" promise.** The final design therefore restricts dedup to the **only loader-correct unit AD actually has: whole byte-identical files** (a loose image, or an atlas image+manifest pair whose sheet is 100% identical to the owner's). The safe rewrites are: (a) repoint a consumer atlas manifest's `meta.image` at the owner image and drop only the redundant image, or (b) drop a whole consumer file and rewrite a reference **only where AD itself emits the referencing manifest**; otherwise keep + surface honestly. No `linkedFrames`, no alias index, no build-queue topo-sort — those are builder-internal and target frame-level dedup of free-tex-packer output, which AD does not produce.

Other binding corrections from review: (1) a **two-phase worker contract** computes every retained owner's FINAL emitted path (after transcode/resize/repack rename) before any consumer rewrite, eliminating the dangling-reference-to-transcoded-owner bug; (2) **lazy members are owners-only** (never consumers) — honoring the user's literal rule and removing all cross-bundle load-order coupling; (3) **unmarked bundle defaults to `isolated`, not eager** for owner selection; (4) **Task 1 (dir-aware loose refs) is a cross-cutting refactor** pinned to a single exported `keyOf` reused everywhere, with a pre-dedup regression test; (5) native `convertToBlob` stays the lossy fast-path — @jsquash only where canvas lacks the codec (existing contract; no "route everything for determinism"); (6) **dedup VRAM saving is reported as an upper bound in code**, not just verbally; (7) the new skin-protection type is renamed **`SkinGuard`** (no collision with `variants.ts`), uses AD's deliberately stricter rule (per-file basename, no general fallback), and the **false "builder parity" claims are dropped**; (8) deterministic owner tie-break uses a **fixed codepoint comparator**, matching the builder's actual line-64 logic. Lazy-aware owner selection (Feature 3) is a refinement of Feature 1's selector. Optimization settings (Feature 2) wire the genuinely-portable @jsquash surface, scale-aware quality, and per-folder/type overrides; non-portable controls (sharp kernels, pre-blur, pngquant) are omitted with honest "Why no X?" UI, AVIF chroma is gated pending a one-shot verify.

**Build order:** Feature 1 (foundation, incl. Task 1 prerequisite) → Feature 3 (lazy rule slots into the selector) → Feature 2 (independent).

---

## 1. SCOPE & PHASING

| Feature | Verdict | Reused from AD | Reused idea from builder | Net-new |
|---|---|---|---|---|
| **(1) Owner/consumer dedup (whole-file) + pool sep + skin-guard** | NEW owner-aware extension of `duplicateExactFindings` + the existing `drop` op | `folder.ts` content-hash grouping, `plan.ts` drop op + precedence sets, worker drop handler, `mergeSharedAtlases` `meta.image` rewrite + `emitTexturePackerJson` round-trip path | owner-ordering (alphabetical-first), pool separation idea, skin-pair partition idea | owner/consumer result model in `core`; pure `buildDedupGroups`; two-phase worker exec; `meta.image` repoint + whole-file drop |
| **(2) Optimization settings** | EXTEND | existing `encodeCanvas` (native lossy fast-path + @jsquash for AVIF/lossless), `FixOptions`, `scaleAtlas` | scale-aware-quality formula, per-folder/type override config | new `FixOptions` fields; pure `settings.ts` (scale-aware-q + override resolver); richer `encodeCanvas` opts; settings UI |
| **(3) Lazy-aware owner selection** | NET-NEW logic on (1) | (1)'s selector | none (builder has zero lazy awareness) | `LazyMarking` in request; owners-only-for-lazy rule; isolated default; UI bundle marking |

**Explicitly NOT a port of the builder's frame-dedup.** The builder dedups frames *within* free-tex-packer manifests (`owner = {ownerRelativePath, frameName}`, `aliasIndex`, `reverseIndex`, `build-queue` topo-sort). AD's unit is the **whole loose file / whole atlas page**. Those builder data structures do not carry over; only three *ideas* do (alphabetical owner, pool sep, skin partition). This is stated honestly in §8 — no "EXTEND/parity" marketing of code whose data model doesn't transfer.

**Deferred to a later slice (contract forward-compatible, not built now):** multi-resolution scale tiers as separate emitted files (`scaleTiers`). Field reserved; multi-emit loop is follow-up (multiplies output + interacts with manifest naming). Single-scale + per-asset oversize-resize (today's behavior) stays default.

**Phasing:** 1a contract → 1b pure `buildDedupGroups` → 1c plan owner-aware drop → 1d worker two-phase exec + `meta.image` rewrite → 1e loose-drop gating + VRAM honesty. 3 slots into 1b/1c. 2a pure helpers → 2b `encodeCanvas` opts → 2c UI + i18n.

---

## 2. FINAL CORE CONTRACT (`packages/core/src/index.ts`)

All additive, structured-cloneable, no field removed/renamed.

```ts
/* ── Bundle / lazy marking (Feature 3 — UI-sourced) ────────────────────────────────────────
 * A "bundle" is the runtime load unit. Identity: bundle(ref) = FIRST PATH SEGMENT of the dir-aware
 * ref ("main_game/ui/x.png" → "main_game"); a ref with no "/" has bundle === ref (its own singleton).
 * The UI marks each top-level bundle. Marking semantics (precise, binding for correctness):
 *   'eager'    = GLOBALLY RESIDENT: loaded before any other bundle's assets are referenced, never
 *                unloaded. Only an eager owner may serve a consumer in a different bundle.
 *   'lazy'     = resident only after its own bundle loads; load order vs other lazy bundles is unknown.
 *   'isolated' = DEFAULT for any UNMARKED bundle: treated as its own self-contained unit; may neither
 *                own across bundles nor consume across bundles. (Fail-safe: an unmarked bundle can
 *                never silently become a global owner that a lazy consumer breaks against.) */
export type BundleAvailability = 'eager' | 'lazy' | 'isolated';

/** UI-supplied marking, keyed by top-level bundle name. Absent key ⇒ 'isolated'. Pure data; flows in
 *  the FixRequest. Sub-bundle granularity and user-declared lazy load-order are future extensions. */
export type LazyMarking = Record<string, BundleAvailability>;

/* ── Dedup partition dimensions (Feature 1) ────────────────────────────────────────────────
 * A dedup may only collapse members of the SAME (pool, skinGroup) partition. */
export type DedupPool = 'spine' | 'pixi';

/** Skin/variation guard. Renamed from the rejected "AssetVariations" to avoid collision with the
 *  unrelated variants.ts model. Keeps skin "key" assets distinct from their "value" variants so a
 *  skin-switch build never loses an asset. Matched on the dir-aware ref's FILE basename (no ext) —
 *  see §3c: this is AD's DELIBERATELY STRICTER rule (no general-owner fallback), NOT builder parity. */
export type SkinGuard = Record<string, string>; // { keyBasename: valueBasename }
export type SkinGroup = 'general' | 'keys' | 'values';

/* ── Owner/consumer dedup result model (whole-file only) ────────────────────────────────────
 * One DedupGroup per contentHash AFTER (pool, skinGroup) partitioning. A group may have >1 owner
 * (the lazy/isolated case: each such bundle keeps its own owner). Every consumer names exactly one
 * owner whose bundle DOMINATES the consumer's bundle (see §3a dominance rule). */
export interface DedupConsumer {
  /** Dir-aware ref of the whole duplicate to drop. */
  ref: string;
  /** Retained ref this consumer's references repoint to. Same (pool, skinGroup) partition AND
   *  bundle(ownerRef) dominates bundle(ref). */
  ownerRef: string;
  /** Why this edge is safe — for the receipt + golden tests. */
  reason: 'same-eager-bundle' | 'eager-owner-cross-bundle' | 'same-lazy-bundle' | 'same-isolated-bundle';
}

/** One contentHash group within one (pool, skinGroup) partition. `owners` length ≥ 1. */
export interface DedupGroup {
  contentHash: string;
  pool: DedupPool;
  skinGroup: SkinGroup;
  /** Retained refs (never dropped). >1 only when members span multiple non-eager bundles. Sorted by
   *  the deterministic codepoint comparator (§7). */
  owners: string[];
  /** Drops, each bound to one owner. Sorted by `ref` (codepoint). */
  consumers: DedupConsumer[];
}
```

**Extend `FixOp 'drop'`** (additive optional fields — old plans still valid):
```ts
| { kind: 'drop'; assetRef: string; reason: 'duplicate-exact' | 'duplicate-similar';
    /** Owner-aware drop (Feature 1): retained ref this drop's references repoint to. Absent ⇒ legacy
     *  bare-delete (today's behavior). */
    ownerRef?: string;
    /** True when this consumer is a whole atlas image+manifest pair identical to the owner's; the
     *  worker keeps the consumer manifest, repoints meta.image → owner image, drops only the image. */
    repointManifest?: boolean }
```

No new `Rule` member. We KEEP `duplicate-exact`/`duplicate-similar` exactly as-is (objective diagnosis, invariant 3). Owner info is a **fix-time** refinement carried on `FixOp.drop` + a side `DedupGroup[]` on the plan — the diagnosis still says "N identical files"; the fix decides owners.

**Extend `FixReceipt`** (`fix-protocol.ts`, additive):
```ts
  /** Owner-aware dedup: consumer references repointed to an owner (meta.image rewrites + external). */
  referencesRewritten?: number;
  /** Whole duplicates that could NOT be safely repathed (reference may live in game code) — KEPT. */
  looseRepathSkipped?: number;
  /** DISK bytes removed by dedup drops (ALWAYS real). Separate from VRAM (invariant 5). */
  dedupDiskBytesSaved?: number;
  /** UPPER-BOUND VRAM saving from dedup: only realized if the runtime shares one GPU upload across the
   *  dropped copies. Reported separately + flagged as upper bound; never folded into a hard VRAM claim. */
  dedupVramBytesSavedUpperBound?: number;
```
`referencesChanged` (existing) stays the honest top-level flag, set true on any rewrite or owner-aware drop (makes the folder NOT a blind drop-in; surfaced via the existing `fix.mergeWarn` string).

**Conventions pinned:** all dedup refs are dir-aware folder-relative paths (post-Task-1), matching ingest's `keyOf`. `bundle(ref)` = substring before first `/`. Owner tie-break = the **fixed codepoint comparator** `cmp` (§7), matching the builder's actual line-64 `a < b ? -1 : a > b ? 1 : 0` (NOT localeCompare). No floats, no fabricated fields.

---

## 3. DEDUP REDESIGN

### 3a. Pure module `packages/analysis/src/dedup.ts` (worker-safe, Vitest-covered)

Extends, not replaces, `folder.ts`. `duplicateExactFindings` stays for diagnosis. New function computes the owner/consumer plan from inputs the worker already has.

```ts
import type { AssetVariations, BundleAvailability, DedupGroup, DedupConsumer, DedupPool,
  ImageFeatures, LazyMarking, SkinGuard, SkinGroup } from '@asset-doctor/core';

/** Fixed, locale-INDEPENDENT comparator — codepoint order, == builder dedup-scanner.ts:64. */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const bundleOf = (ref: string): string => { const i = ref.indexOf('/'); return i < 0 ? ref : ref.slice(0, i); };
const baseNoExt = (ref: string): string => (ref.split('/').pop() ?? ref).replace(/\.[a-z0-9]+$/i, '');

function skinGroupOf(ref: string, guard: SkinGuard): SkinGroup {
  const b = baseNoExt(ref);
  for (const [k, v] of Object.entries(guard)) { if (b === k) return 'keys'; if (b === v) return 'values'; }
  return 'general';
}
```

**Dominance rule (formal, lazy-aware, owners-only-for-lazy).** Owner bundle `ob`/avail `oa` dominates consumer bundle `cb`/avail `ca` iff it is provably safe to point the consumer at that owner:

```
dominates(ob, oa, cb, ca):
  if ob === cb:  return true                 // same bundle ⇒ always co-resident (atomic load)
  if oa === 'eager': return true             // eager owner is globally resident before any reference
  return false                               // lazy/isolated owner may NOT serve a different bundle
```

This encodes the user's literal rule: **a lazy (or isolated) bundle's asset is never a cross-bundle consumer** — it can only consume a same-bundle peer or an eager owner; it can never *be consumed by* a different bundle (only `same bundle` or `eager` can). Combined with the selection algorithm, a lazy bundle stays self-contained.

**Owner-selection algorithm (deterministic).** For each contentHash group (from `duplicateExactFindings`'s grouping), then:

1. **Partition** members by `(pool, skinGroup)`. Pool = `spine` if ref ∈ `spineRefs`, else `pixi`. Only same-partition members may dedup. (Cross-partition byte-identical files stay independent.)
2. For each partition with ≥2 members, compute `avail(ref) = marking[bundleOf(ref)] ?? 'isolated'`.
3. **Eager-anchored case** — if ANY member is eager: owner = `cmp`-first among the **eager** members. Every member `m ≠ owner` for which `dominates(bundle(owner),'eager', bundle(m), avail(m))` (always true for an eager owner) becomes a consumer. `reason` = `same-eager-bundle` if `bundle(m)===bundle(owner)`, else `eager-owner-cross-bundle`. → `owners = [owner]`.
   - **A lazy/isolated member here becomes a consumer of the eager owner.** This is the ONE safe cross-bundle edge, justified by the precise `eager = globally resident` definition (§2). It does NOT make the lazy bundle depend on another *lazy* bundle; it depends only on the globally-resident eager set, which is a no-op load-order constraint. *(This is the deliberate, narrow exception to "lazy assets are owners only" — see §13 row and Open Question 2: it is safe under the pinned eager semantics and the user's correctness requirement is "never consume an owner not guaranteed loaded before it"; an eager owner IS so guaranteed. If the human prefers the absolute literal rule "lazy members never consume anything," flip the one flag `LAZY_MAY_CONSUME_EAGER=false` — Open Question 2.)*
4. **No eager member** (lazy/isolated-only partition): do NOT pick a cross-bundle owner. Sub-partition by `bundleOf(ref)`. Within each bundle with ≥2 members: owner = `cmp`-first, the rest consume it (`reason` = `same-lazy-bundle` or `same-isolated-bundle`). A bundle with exactly one member in this partition is a standalone owner (kept, no drop). → `owners` = per-bundle local owners (length = number of distinct non-eager bundles), `consumers` = same-bundle drops only. **Zero cross-bundle edges.**
5. **Tie-break everywhere** = `cmp` (codepoint). Group iteration sorted by `contentHash`; `consumers` by `ref`; `owners` sorted.

**Safety theorem (encoded, stress-tested in §10):** every consumer→owner edge satisfies `dominates`; an owner is always retained (never a drop target) ⇒ the graph is a **depth-1 star** per owner ⇒ no cascades, no cross-bundle cycles. Output is fully deterministic.

Signature:
```ts
export function buildDedupGroups(
  features: ImageFeatures[],
  spineRefs: ReadonlySet<string>,
  marking: LazyMarking,
  skinGuard: SkinGuard,
): DedupGroup[]
```
Pure; takes only refs/hashes/flags the worker already computes. Zero network.

### 3b. POOL SEPARATION
`spineRefs` already exists in `fix.worker.ts:78` (`a.kind === 'spine'` adds `res.asset.atlas.name`). Pass it in. The lazy + skin rules run INSIDE each pool independently — a spine owner only serves spine consumers.

**Honest limitation (skeptic minor, accepted):** `spineRefs` only contains images parsed *with* their `.atlas`. A loose Spine page exported *without* its `.atlas` is classified `pixi`. **This is harmless under the whole-file restriction:** a byte-identical file is byte-identical regardless of pool, so a whole-file drop+repoint is correct even if pool is mis-detected. Pool separation matters only for partial-frame dedup — which we defer/forbid. Documented in §8.

**Divergence from builder `skipSameBundleDedup` (intentional, documented §8):** the builder skips same-bundle pixi dedup because free-tex-packer already in-sheet-dedups its output. AD dedups raw loose files / whole atlas images, not free-tex-packer output, so same-bundle exact dupes are real and worth dropping. We do NOT replicate `skipSameBundleDedup`.

### 3c. SKIN GUARD (renamed; stricter than builder; honest about it)
Orthogonal partition dimension (step 1), applied before owner selection, matched on the **file** basename-no-ext.

- **Renamed** `AssetVariations` → **`SkinGuard`** / `SkinGroup` to avoid the cognitive collision with `variants.ts`'s unrelated "variation" model (skeptic major). `variants.ts groupVariants` clusters format/resolution variants of one logical asset for VRAM honesty (diagnosis); `SkinGuard` keeps skin variants from collapsing during dedup (fix). Different code paths, different names, zero conflict.
- **Two deliberate divergences from the builder, stated as divergences (NOT parity):**
  1. **Match granularity:** builder matches `path.basename(manifest.relativePath)` (the manifest/folder name); AD matches the **file** basename. AD has no per-folder manifest for loose packs, so file-basename is the defensible adaptation. **Stated in §8; golden test §10.3 pins a case where folder vs file basename would differ.**
  2. **No general-owner fallback:** builder lets a `keys`/`values` asset fall back to a `general` owner (`owners.variationGroups.get(group) ?? owners.general`). AD uses a **strict** `(pool, skinGroup)` partition with NO fallback — a key/value skin never dedups against a non-skin asset. Stricter = safer (never silently collapses a declared skin); **stated in §8 as AD's chosen conservative rule, not parity.**

### 3d. FIX side — `plan.ts` and `fix.worker.ts`

**`plan.ts`** (Task: extend `dropGroup`): `planFix` accepts the `DedupGroup[]` (computed by the worker, which has `spineRefs`/`marking`). In aggressive mode, for each group it emits one `{kind:'drop', ownerRef, repointManifest?}` per consumer; owners are added to a `protectedOwners` set so they are NEVER drop/merge targets. Existing precedence preserved: `dropped.has`/`repacked.has`/`resized.has` checks first; additionally `if (protectedOwners.has(ref)) skip drop`. `repointManifest = true` when the consumer is an atlas (has a manifest) whose sheet is fully identical to the owner's; else a whole-file drop. Determinism: iterate groups by `contentHash`, consumers by `ref`.

**`fix.worker.ts` — TWO-PHASE EXECUTION CONTRACT (the dangling-owner fix, skeptic blocker).** Today ops run in one flat sequential loop, so a consumer can reference an owner's *pre-rename* filename. New contract:

- **Phase A — owner final-name resolution.** Before executing any owner-aware drop, build `ownerFinalName: Map<ref, { image: string; manifest?: string }>` for every retained owner ref, computed from the plan: if the owner is also transcoded → its `.webp`/`.avif` name; if resized/repacked → its emitted sheet name; else its original emitted name. This map is derived from the *plan* (the rename rules are deterministic functions of op kind + target mime), so it is known before execution.
- **Phase B — execute transforms** (repack/resize/transcode) as today; assert each owner's actual emitted name equals `ownerFinalName` (defensive check; on mismatch, surface `skipped[]` and KEEP the consumer rather than dangle).
- **Phase C — execute consumer rewrites/drops** against `ownerFinalName`:
  - **Atlas consumer, `repointManifest`:** rewrite the consumer manifest's `meta.image` to the owner's FINAL image path (`path.relative(consumerDir, ownerDir)` via existing `dirOf`/`normalize`), KEEP the consumer manifest (its frame rects are identical to the owner's sheet by definition of whole-sheet-identical), drop only the consumer's redundant IMAGE. Re-parses cleanly through AD's `parseAtlas` (reads `frames` + `meta.image`). Sets `referencesChanged=true`, `referencesRewritten++`.
  - **Whole-file consumer (loose, or atlas where we drop both image+manifest):** drop the file; rewrite a reference ONLY where AD itself emits the referencing manifest (i.e. another manifest in the same run points at it). Otherwise → KEEP + `looseRepathSkipped++` + `skipped[]` (the reference may live in game code; this is the one place dedup could silently break a build — fail safe).
  - **Spine consumer:** `.atlas` text has no portable cross-page redirect → only whole-file drop when 100% identical AND no other skeleton references it within the run; else KEEP + `skipped[]: 'spine cross-page dedup not drop-in'`. Never silently delete a Spine page.

**NO `linkedFrames`, NO alias index** (skeptic blocker — does not exist in AD, breaks stock loaders, unround-trippable through AD parsers). The only manifest rewrite is `meta.image` (the exact mechanism `mergeSharedAtlases` already uses and that `emitTexturePackerJson` round-trips through `parseAtlas`).

**Alternative simplification offered (Open Question 2 / §13):** if the human prefers minimal risk, forbid an owner from being *both* a dedup-owner AND a rename-producing transform in v1 — then Phase A is a no-op and consumers always point at unchanged owner names. The two-phase contract is the more capable option; the forbid-rule is the safe fallback. Either is acceptable; default = two-phase.

**Determinism (owner tie-breaks):** `cmp` (codepoint), emitted in sorted key order; manifests already deterministic (`manifest.ts` sorts frames, fixed key order, no timestamps).

---

## 4. OPTIMIZATION SETTINGS

### 4a. New `FixOptions` fields (`fix-protocol.ts`, additive, current-behavior defaults)
```ts
export interface FixOptions {
  // ── existing: targetMime, quality, lossless, padding, maxSize, maxEdge, aggressive, polygon ──

  // ── NEW (Feature 2) ──
  /** Encoder effort, ONE UI slider 0(fast)..6(max). Mapped per-codec in encodeCanvas: WebP→method(0-6),
   *  AVIF→speed(10-6, inverse: higher effort = slower/better). Default fast preset. */
  effort?: number;
  /** WebP near-lossless 0-100 (100 ⇒ off). Maps to @jsquash webp near_lossless. */
  webpNearLossless?: number;
  /** AVIF alpha quality (qualityAlpha). Omit ⇒ -1 (track quality). */
  avifQualityAlpha?: number;
  /** AVIF chroma subsample integer. FIELD ships; UI toggle GATED until Task 14 verifies 0/1/2 mapping
   *  (3=YUV444 is already confirmed in @jsquash encode.js). Omit ⇒ @jsquash default. */
  avifSubsample?: number;
  /** Lossless PNG recompress via @jsquash/oxipng level 0-6. Omit ⇒ off (no new WASM loaded). */
  pngRecompressLevel?: number;
  /** Scale-aware quality (lower q on downscaled output). Pure deterministic formula. Default false. */
  scaleAwareQuality?: boolean;
  /** Per-folder + per-type overrides (folder-prefix or type:* key). Resolved in worker. */
  overrides?: FixOverride[];
  /** RESERVED (deferred slice): multi-resolution tiers. Empty ⇒ single-scale (today). */
  scaleTiers?: { scale: number; suffix: string }[];
}
export interface FixOverride {
  /** Folder prefix (dir-aware) OR pseudo-type key 'type:spine'|'type:pixi'|'type:loose'. */
  match: string;
  quality?: number; effort?: number; targetMime?: ImageMime; webpNearLossless?: number;
}
```

### 4b. Scale-aware quality + override resolver — pure helpers (`packages/fix/src/settings.ts`, tested)
```ts
export const SCALE_QUALITY_FLOOR = 50;
/** Builder applyScaleAwareQuality, ported (pure integer math, deterministic). q in 0..100. */
export function scaleAwareQuality(q: number, scale: number, enabled: boolean): number {
  if (!enabled || scale >= 1) return q;
  return Math.max(SCALE_QUALITY_FLOOR, Math.min(100, q - Math.round((1 - scale) * 50)));
}
/** Resolve effective options for a ref. Folder match = ref===f || ref.startsWith(f+'/'); type:* matches
 *  asset kind. Later overrides win (stable order). */
export function resolveOptions(ref: string, kind: 'spine'|'pixi'|'loose', base: EffectiveOptions, overrides?: FixOverride[]): EffectiveOptions
```

### 4c. `encodeCanvas` — wire the real @jsquash surface; KEEP native lossy fast-path
**Binding correction (skeptic major, both reviewers):** do NOT route all lossy encodes through @jsquash. Keep the existing contract:
- **Lossy WebP / lossy single-image / canvas-composed repack-merge sheets → native `convertToBlob`** (fast; the worker already does this deliberately).
- **@jsquash ONLY where canvas lacks the codec:** AVIF (all), lossless WebP, near-lossless WebP, and when the user explicitly raises `effort`.
- Threaded options when @jsquash IS used:
  - WebP (lossless/near-lossless/high-effort): `encode(data, { quality, lossless, near_lossless: webpNearLossless<100?webpNearLossless:0, method: clamp(effort,0,6), use_sharp_yuv: 1 })`.
  - AVIF: `encode(data, { quality, qualityAlpha: avifQualityAlpha ?? -1, speed: 10 - round(clamp(effort,0,6)/6*4), enableSharpYUV: true, ...(avifSubsample!=null ? { subsample: avifSubsample } : {}) })`.
- **PNG recompress:** when `pngRecompressLevel` set and target PNG, lazy-import `@jsquash/oxipng` `optimise(imageData,{level})`. **Lazy-loaded on first use only; never in the diagnosis path.** New dep — its WASM weight is acknowledged (§11.6).
- **Free quality win:** set `imageSmoothingQuality='high'` on resize/repack 2D contexts (worker uses default `'low'` today). Include in Feature 2.

**Determinism scope (honest, narrowed per review):** drop the blanket "route everything for determinism." End-to-end byte-stability is promised ONLY for non-resizing, non-canvas-composed ops: in-place transcode (no resize), dedup-drop, oxipng recompress, repack-without-downscale-via-direct-blit-only. Resize and any canvas `drawImage`-composed output (repack/merge sheets) are NOT cross-machine byte-stable and the receipt/marketing must not claim they are.

### 4d. INCLUDED vs HONESTLY OMITTED vs GATED

**INCLUDED (portable):** WebP `quality`/`method`(effort)/`lossless`/`near_lossless`/`use_sharp_yuv`/`alpha_quality`; AVIF `quality`/`qualityAlpha`/`speed`(effort)/`sharpness`/`denoiseLevel`/`enableSharpYUV`/`tune`; lossless PNG recompress via `@jsquash/oxipng`; scale-aware quality (verbatim formula); per-folder/per-type overrides; `imageSmoothingQuality='high'`.

**HONESTLY OMITTED (surface in `skipped[]` at the point a user would expect them, never faked):**
- sharp `scaleKernel` (mitchell/lanczos3/cubic) — UA-internal resampler, not kernel-selectable. Substitute `'high'`; UI shows "downscale kernel not configurable in-browser." No dropdown.
- `scalePreBlur` — no canvas equivalent. Omit; note shimmer risk ≤0.5 scale.
- pngquant lossy 256-color quantization — no maintained WASM quantizer. Drop; steer to WebP/AVIF (usually smaller); `skipped[]: 'lossy PNG quantization unavailable in-browser; use WebP/AVIF'`.
- JPEG encode — no `@jsquash/jpeg`; JPEG not an AD output target. Omit.

**GATED (portable but verify before UI toggle):** AVIF `subsample` 0/1/2 → chroma mapping. **Corrected note (skeptic):** `3=YUV444` IS confirmed in installed `encode.js` (lossless forces `subsample=3`, "must be 3 for YUV444"); only the 0/1/2 sub-mapping + the default-on-fonts behavior is unverified. Ship the field, gate the UI toggle until Task 14's one-shot encode-and-inspect pins 0/1/2. Risk: silent chroma fringing on fonts/sharp edges.

---

## 5. UI

### 5a. Lazy/bundle marking — `FixCard` in `App.tsx`
- Derive top-level bundles from `files`: `Array.from(new Set(files.map(f => bundleOf(keyOf(f))))).sort(cmp)`.
- **Flat-pack handling (skeptic major):** if a ref has no `/`, `bundleOf` = the whole ref ⇒ every loose file is its own singleton bundle and per-bundle marking is meaningless noise. So: **suppress the Bundles panel unless ≥2 distinct multi-file top-level segments exist** (i.e. there's real folder structure). Root-level loose files are shown as a single implicit `(root)` bundle. UI note: "Bundle marking only affects owner choice across multi-folder packs."
- Panel gated to aggressive mode (marking only affects dedup owner choice), collapsible. One row per top-level bundle: a 3-state control eager | lazy | **isolated (default)**. State `useState<LazyMarking>({})`.
- **Honest default note:** "Unmarked bundles are treated as self-contained (isolated) — their duplicates are only merged within the same bundle. Mark a bundle 'eager' (globally resident before everything) to let other bundles share its copies. Lazy bundles stay self-contained." Receipt shows `referencesRewritten` + `looseRepathSkipped`.
- Pass `marking` → `runFix(files, { ...options, marking, skinGuard }, …)`; `fix-client.ts` forwards (thin pass-through; add the fields).

### 5b. Optimization-settings panel — `FixCard`
Collapsible `<details>`, default collapsed (instant-wow defaults = fast preset). Controls: Target format (existing), Quality (existing), **Effort** 0(fast)..6(max) with "max effort much slower, esp. AVIF" tooltip, **Scale-aware quality** checkbox, **WebP near-lossless** checkbox (sets a sane value e.g. 60), **PNG lossless recompress** checkbox (lazy-loads oxipng), **Advanced overrides** add-row (folder prefix/type + quality) — MVP minimal. **NO kernel dropdown, NO pre-blur, NO pngquant, NO chroma toggle** (until Task 14); their absence carries a small "Why no X?" `title` explaining browser limits honestly (NOT "coming soon"). SkinGuard input (key→value rows) sits next to bundle marking under aggressive mode; MVP may default `skinGuard={}` and ship the input as a follow-up.

### 5c. i18n (9 locales) — corrected
**Binding correction (skeptic minor):** the drift test (`catalogs.test.ts`) asserts exact key + placeholder-token parity across ALL 9 locales, so **every new key MUST be added to all 9 catalogs with identical placeholder tokens before `pnpm test` passes.** Runtime English fallback is a production safety net, NOT a CI shortcut. New keys: `fix.settings.*`, `fix.bundles.*`, `fix.lazy.note`, `fix.skipped.*`. English authoritative; other locales may start as copied English strings (translate later) but must be present. CLI stays EN. `skipped[]` reasons stay engineering strings rendered as a localized COUNT (consistent with today); only key them if shown verbatim later.

---

## 6. INGEST / WORKER

- **Task 1 — dir-aware loose refs (cross-cutting refactor, NOT a one-liner; skeptic blocker/major from both reviewers).** Export ingest's `normalizePath` (and `keyOf`) from `@asset-doctor/ingest`. Use that **single** function for the loose-image `assetRef`, the worker `bytesByRef`/`pathByRef`/`vramByRef` keys, the analysis `features` key, AND `App.tsx` `fileMap` — all keyed on `keyOf(f)` (i.e. `normalizePath(f.path ?? f.name)`; basename fallback only for truly flat uploads, matching ingest's `atlasName`). Do NOT hand-roll a second normalizer in `App.tsx`. Audit `stemOf`/`groupVariants` for dir-aware input — **strip the directory before stemming** (stem on basename, key on path) so a path-prefixed name isn't mis-stemmed. Update FilmViewer selection key + re-baseline every analysis fixture/golden that asserts ref strings. **Pre-dedup regression test:** two same-basename loose images in different folders → two distinct, correctly-byte'd, FilmViewer-selectable assets (proves the silent-overwrite bug is fixed before any dedup work).
- **Dedup timing:** in aggressive mode, after `computeFeatures` (which already gives `contentHash` per ref), call `buildDedupGroups(features, spineRefs, opts.marking ?? {}, opts.skinGuard ?? {})`, pass the result into `planFix`. Runs after `groupFiles` + `mergeSharedAtlases`, before plan execution.
- **Where logic runs:** owner-selection in `buildDedupGroups` (pure, `packages/analysis`, called from worker which has `spineRefs`/`marking`). `meta.image` rewrite in `fix.worker.ts` Phase C (impure JSON edit), reusing `manifestPathOf`/`pathByRef`/`dirOf`/`normalize`. `plan.ts` stays a thin consumer of `DedupGroup[]`.

---

## 7. DETERMINISM CONTRACT

(a) group iteration sorted by `contentHash`; (b) owner = `cmp`-first (codepoint, locale-independent — NOT localeCompare) among the eligible set; (c) `consumers` sorted by `ref`, `owners` sorted, all via `cmp`; (d) `meta.image` rewrites emitted in sorted order; (e) manifests already deterministic; (f) Phase-A `ownerFinalName` map is a deterministic function of the plan; (g) **encode determinism holds ONLY for non-resizing, non-canvas-composed ops** (§4c). Same input + same `marking` + same `skinGuard` ⇒ identical `DedupGroup[]` + identical emitted JSON.

---

## 8. WHAT WE DELIBERATELY DO NOT PORT (and why)

- **`linkedFrames` / `aliasIndex` cross-atlas frame redirect** — does not exist in AD; AD's `parseAtlas` has no such branch (a re-parse drops the frame, not redirects it); stock PixiJS v8 / Phaser loaders ignore the field; it is a builder-runtime-loader extension that breaks the drop-in promise for any unknown consumer engine. Replaced by whole-file dedup + `meta.image` repoint (round-trips through AD's actual parser).
- **Builder frame-level dedup data model** (`owner = {ownerRelativePath, frameName}`, `reverseIndex`, `build-queue` topo-sort) — targets free-tex-packer output frames; AD's unit is whole files. Only three ideas carry over: alphabetical owner, pool separation, skin partition.
- **sharp libvips resampling + mitchell/lanczos3/cubic kernels** — UA-internal; substitute canvas `'high'`, disclose.
- **`scalePreBlur` gaussian prefilter** — no canvas equivalent; omit, disclose shimmer ≤0.5.
- **pngquant lossy 256-color quantization** — no maintained WASM quantizer; drop, steer to WebP/AVIF.
- **JPEG encode** — no `@jsquash/jpeg`, not an AD output target.
- **chokidar watch / build-queue debounce / dedupHash + `.avif.meta` caches** — Node FS, irrelevant to one-shot browser fix.
- **Builder `skipSameBundleDedup` for pixi** — AD dedups raw files, not in-sheet free-tex-packer output; same-bundle exact dupes are real. Documented divergence.
- **Builder skin-guard semantics** — AD diverges deliberately (file-basename match, no general-owner fallback). NOT claimed as parity.
- **`avifFullChromaFolders` as a shipped control** — depends on the gated chroma subsample toggle; per-folder override mechanism exists, the chroma value does not ship until Task 14 verifies.

---

## 9. EDGE CASES (stress-tested against the safety theorem)

1. **Cross-bundle cycles:** impossible — owners are always retained ⇒ depth-1 star, no paths/cycles. AD emits in one pass (owners unchanged, consumers rewritten); no queue needed.
2. **Multiple lazy bundles, same hash:** lazy-only partition → one local owner per lazy bundle (step 4). No cross-lazy edge.
3. **lazy-vs-lazy across bundles:** forbidden by `dominates` (lazy owner serves only same bundle). Both keep their copy.
4. **eager-vs-lazy:** eager member wins owner (step 3); lazy member safely consumes the eager (globally-resident) owner. An eager member NEVER consumes a lazy owner (step 3 forces an eager owner whenever one exists).
5. **isolated (unmarked):** an unmarked bundle is `isolated` — only same-bundle dedups, never a cross-bundle owner OR consumer (the fail-safe default). Two unmarked same-basename files in different folders never collapse.
6. **Skin interplay with `groupVariants`:** none — different code paths/names (§3c). Byte-identical key vs value skins are in different `skinGroup` partitions ⇒ never collapse.
7. **Owner also oversized/transcoded:** handled by the two-phase contract (§3d) — Phase A records the owner's FINAL name, Phase C points consumers at it. Golden test §10.8. (Or the forbid-rule fallback, Open Question 2.)
8. **Owner picked from a drop set:** a ref chosen as owner is added to `protectedOwners` and removed from any drop set — owners are never drop targets.
9. **Mis-detected loose Spine page (pool):** harmless under whole-file restriction (byte-identical = byte-identical regardless of pool); §3b.
10. **VRAM honesty:** dropping a consumer always saves DISK; VRAM only if the runtime shares one upload — reported as upper bound (§3d, §11.5), code change in receipt fields (§2).

---

## 10. TEST PLAN

Fixture `fixtures/sample-projects/raw-multifolder-dupes/` (parity with `folder-waste`):
- `main_game/logo.png` == `fs_game/logo.png` (cross-bundle; both eager in the marked test).
- `main_game/ui/icon.png` == `main_game/general/icon.png` (same bundle).
- `bonus/spark.png` == eager `main_game/spark.png`; `bonus_b/spark.png` == same content (two lazy bundles).
- `theme_default/bg.png` == `theme_dark/bg.png`, declared as a `keys`/`values` SkinGuard pair → must NOT collapse.
- A folder-named skin case to pin file-vs-folder basename divergence (§3c.1).
- `animations/a/frame.png` == `animations/b/frame.png` (spine pool, both with `.atlas`).
- A pixi sprite byte-identical to a spine frame → must NOT collapse (pool separation).
- An atlas image+manifest pair fully identical to an owner atlas (for the `meta.image` repoint round-trip).
- A loose dup with no rewritable reference (for the loose-skip gating).

**Pure golden tests (`packages/analysis/test/dedup.test.ts`):**
1. **Owner-selection golden** with `marking={main_game:'eager', fs_game:'eager', bonus:'lazy', bonus_b:'lazy'}`: `fs_game/logo.png`→owner is `cmp`-first eager (`fs_game` < `main_game` ⇒ owner `fs_game/logo.png`, `main_game/logo.png` consumes, `same`/`eager-owner-cross-bundle`); `bonus/spark.png` + `bonus_b/spark.png` consume eager `main_game/spark.png` (`eager-owner-cross-bundle`); with `main_game/spark.png` removed → `bonus` and `bonus_b` each keep their own owner, zero cross-lazy edges.
2. **Pool separation:** spine frame + identical pixi sprite → two uncollapsed groups.
3. **Skin guard + file-vs-folder basename:** key/value skins identical → not collapsed; folder-named-skin case asserts AD's file-basename choice.
4. **Determinism:** run twice deep-equal; shuffle input order → identical output; verify `cmp` (not localeCompare) by a non-ASCII path pair.
5. **isolated default:** unmarked same-basename cross-folder dupes → never collapse.
6. **lazy-vs-lazy:** two lazy bundles, identical content, no eager peer → two owners, zero cross edges.

**Round-trip / worker tests:**
7. **`meta.image` repoint round-trip:** consumer atlas image dropped, manifest `meta.image` repointed → re-parse the emitted consumer JSON via `@asset-doctor/parsers` `parseAtlas`, assert frames resolve against the owner image; `referencesChanged=true`, `referencesRewritten` correct. (This is buildable BECAUSE it uses `meta.image`, which `parseAtlas` reads — the rejected `linkedFrames` version was not.)
8. **Owner transcoded → consumer resolves to final name:** owner emitted as `.webp`/`.avif`, consumer `meta.image` resolves to the FINAL owner image name (two-phase contract). First-class test, not a footnote.
9. **Loose-repath gating:** loose dup with no rewritable reference → NOT deleted, appears in `looseRepathSkipped`.
10. **VRAM honesty:** receipt reports `dedupDiskBytesSaved` (real) and `dedupVramBytesSavedUpperBound` separately; no unqualified hard VRAM credit for cross-bundle drops.

**Pre-dedup regression (Task 1):** two same-basename loose images in different folders → two distinct, correctly-byte'd, FilmViewer-selectable assets.

**Settings tests (`packages/fix/test/settings.test.ts`):** 11. `scaleAwareQuality(90,0.5,true)===65`, clamps at floor 50. 12. `resolveOptions` folder-prefix + `type:` matching.

**Gated manual (Task 14):** AVIF `subsample` 0/1/2 → chroma, one-shot encode-and-inspect on @jsquash/avif@2.1.1; pin mapping in a const + comment before the UI chroma toggle ships (3=YUV444 already known).

---

## 11. RISKS

1. **Loose-file deletion safety** — KEEP unrewritable whole-file dups (fail-safe), surface in `looseRepathSkipped`. (Open Question 1.)
2. **Lazy marking granularity** — per top-level bundle, distinct lazy bundles incomparable, unmarked = isolated. Conservative; no user-declared lazy load-order in v1. (Open Question 2/3.)
3. **AVIF chroma toggle** — gated until Task 14 (3=YUV444 confirmed; 0/1/2 unverified).
4. **pngquant drop** — real regression for 256-color PNG projects; mitigated by WebP/AVIF steer. (Open Question 4.)
5. **VRAM honesty** — fixed in code (separate disk vs upper-bound VRAM fields), not just verbal.
6. **oxipng WASM payload + AVIF max-effort CPU** — oxipng lazy-loaded on first use only, never in diagnosis; fast preset default; max-effort explicit opt-in. Within instant-wow only because diagnosis (≤10s, invariant 4) is untouched and fix is an explicit Pro action. (Open Question 6.)
7. **Determinism claim scope** — only non-resizing, non-canvas-composed ops. (Open Question 7.)

---

## 12. ORDERED TASK BREAKDOWN

| # | Title | Files | Tag | Deps | Acceptance |
|---|---|---|---|---|---|
| 1 | Dir-aware loose refs (cross-cutting) | `packages/ingest/src/index.ts` (export `normalizePath`/`keyOf`), `apps/web/src/worker/analyze.worker.ts`, `fix.worker.ts`, `apps/web/src/App.tsx` (fileMap+FilmViewer key), `packages/analysis/src/variants.ts` (stemOf dir-strip), affected fixtures | worker/refactor | — | One shared `keyOf` keys assetRef + worker maps + features + fileMap; stemOf strips dirs; all existing tests re-baselined green; regression test: 2 same-basename loose files in different folders → 2 distinct byte-correct FilmViewer assets. |
| 2 | Core contract additions | `packages/core/src/index.ts`, `fix-protocol.ts` | core-contract | — | New types (`BundleAvailability` w/ `isolated`, `LazyMarking`, `DedupPool`, `SkinGuard`, `SkinGroup`, `DedupConsumer`, `DedupGroup`, `FixOp.drop` fields, `FixReceipt` dedup fields) compile; `typecheck` green; no existing field changed. |
| 3 | `buildDedupGroups` + `cmp` pure module | `packages/analysis/src/dedup.ts`, `analysis/src/index.ts` | analysis | 1,2 | Golden tests §10.1–6 pass; `cmp` is codepoint (non-ASCII test); owners-only-for-lazy + isolated default verified. |
| 4 | Plan owner-aware drop | `packages/fix/src/plan.ts`, `fix/src/index.ts` | fix | 2,3 | `planFix(report, …, groups)` emits `drop` ops w/ `ownerRef`/`repointManifest`; owners in `protectedOwners`, never drop/merge targets (test). |
| 5 | Worker two-phase exec + `meta.image` repoint | `apps/web/src/worker/fix.worker.ts` | worker | 3,4 | Phase A `ownerFinalName` map; Phase C repoints consumer `meta.image` to FINAL owner image; round-trip §10.7 + transcoded-owner §10.8 pass; `referencesRewritten` counted. |
| 6 | Whole-file drop gating (loose + spine) | `fix.worker.ts` | worker | 5 | Unrewritable loose/spine dup KEPT, surfaced in `looseRepathSkipped`/`skipped[]` (§10.9). |
| 7 | Dedup VRAM honesty in receipt | `fix.worker.ts`, `fix-protocol.ts`, i18n key | worker | 5 | Receipt reports `dedupDiskBytesSaved` + `dedupVramBytesSavedUpperBound` separately; no unqualified cross-bundle VRAM credit (§10.10). |
| 8 | Settings pure helpers | `packages/fix/src/settings.ts`, `fix/src/index.ts` | fix | 2 | `scaleAwareQuality` + `resolveOptions` pass §10.11–12. |
| 9 | `encodeCanvas` @jsquash surface (native lossy kept) | `fix.worker.ts` | worker | 2,8 | WebP near_lossless/method + AVIF speed/qualityAlpha/subsample wired via @jsquash ONLY for AVIF/lossless/near-lossless/high-effort; native `convertToBlob` retained for lossy + composed sheets; `imageSmoothingQuality='high'` set. |
| 10 | oxipng PNG recompress | `fix.worker.ts`, `apps/web/package.json` | worker | 9 | `pngRecompressLevel` lazy-loads `@jsquash/oxipng` on first use only, never in diagnosis path; deterministic output. |
| 11 | Bundle marking + settings UI | `apps/web/src/App.tsx`, `lib/fix-client.ts` | ui | 2,3,5,9 | 3-state bundle marking (eager/lazy/isolated, default isolated) suppressed for flat packs; settings panel + SkinGuard rows flow into `FixOptions`; defaults = today's behavior. |
| 12 | i18n keys (all 9 catalogs) | `packages/i18n/src/catalogs/*.json` | ui | 7,11 | New `fix.settings.*`/`fix.bundles.*`/`fix.lazy.*`/`fix.skipped.*` keys in ALL 9 with identical placeholder tokens; drift test green. |
| 13 | Fixtures + golden files | `fixtures/sample-projects/raw-multifolder-dupes/**` | test | 3 | Fixture + `expected.json` golden checked in; consumed by §10. |
| 14 | AVIF chroma verify + gate | `fix.worker.ts` (const+comment), one-shot script | test | 9 | 0/1/2 `subsample`→chroma mapping pinned (3=YUV444 already known); UI chroma toggle stays hidden until this lands. |

---

## 13. HOW EACH SKEPTIC BLOCKER / MAJOR WAS RESOLVED

| Skeptic finding | Sev | Resolution |
|---|---|---|
| `linkedFrames` rewrite breaks stock loaders + AD parsers can't re-parse it | blocker ×3 | **Accepted, removed.** No `linkedFrames`/alias. Dedup restricted to WHOLE byte-identical files; atlas consumers use `meta.image` repoint (round-trips through AD's `parseAtlas`). §3d, §8. Round-trip test §10.7 now validates through AD's actual parser. |
| Owner filename rewrite after transform → dangling ref (no two-phase machinery) | blocker | **Accepted.** Added first-class TWO-PHASE EXECUTION CONTRACT (Phase A `ownerFinalName` map before any consumer rewrite) + golden test §10.8 (Task 5/8). Forbid-rule fallback offered (Open Q2). §3d. |
| Lazy dominance forces lazy members to become consumers (violates user rule) | major/MustFix | **Resolved.** Lazy/isolated members are owners-only within their bundle (step 4, zero cross-bundle edges). The ONE narrow exception — a lazy member consuming a *globally-resident eager* owner — is safe under the pinned `eager` definition and the user's actual correctness requirement; gated by `LAZY_MAY_CONSUME_EAGER` flag (Open Q2) if the human wants the absolute literal rule. §3a step 3. |
| Unmarked default = eager is the DANGEROUS direction for owner selection | major | **Accepted.** Added `'isolated'` state; **unmarked ⇒ isolated** (never a cross-bundle owner/consumer). Eager requires explicit marking. §2, §3a step 2, §9.5. |
| `eager` semantics are an unproven UI assumption | major | **Accepted.** `eager` pinned precisely as "globally resident, loaded before any reference, never unloaded"; UI states this + warns. §2, §5a. |
| Task 1 blast radius understated (stemOf/groupVariants/fileMap/fixtures) | major/MustFix ×2 | **Accepted.** Task 1 reframed as cross-cutting refactor: single exported `keyOf` reused everywhere, stemOf dir-strip audit, fileMap+FilmViewer to path keys, fixture re-baseline, pre-dedup regression test. §6, Task 1. |
| Asset-variations matching: false "builder parity" (folder vs file basename) | major/MustFix | **Accepted.** Renamed `SkinGuard`; uses file-basename deliberately; parity claim DROPPED; divergence stated in §8; golden test §10.3 pins file-vs-folder case. |
| Skin rule: builder has general-owner fallback, design is strict (claimed parity) | major | **Accepted.** AD declared explicitly STRICTER (no general fallback), stated as a deliberate conservative choice, not parity. §3c.2, §8. |
| Route ALL encodes through @jsquash "for determinism" (false premise + perf) | major/MustFix ×2 | **Accepted.** Reverted to existing contract: native `convertToBlob` for lossy + composed sheets; @jsquash only where canvas lacks the codec. Determinism claim narrowed to non-resizing/non-composed ops. Fast-preset default. §4c. |
| Owner tie-break cited as localeCompare; builder line 64 is lexicographic | minor/MustFix | **Accepted.** Fixed `cmp` = codepoint `<`/`>` (locale-independent), matches builder. Citation corrected. §2, §3a, §7. |
| Dedup VRAM over-stated; verbal caveat only (invariant 5) | minor/MustFix ×3 | **Accepted, fixed in code.** Receipt splits `dedupDiskBytesSaved` (real) vs `dedupVramBytesSavedUpperBound` (flagged). §2, Task 7, §10.10. |
| i18n §5c narrative misleads (drift test is strict) | minor/MustFix | **Accepted.** §5c corrected: all keys in all 9 catalogs w/ identical tokens before tests pass; runtime fallback is not a CI shortcut. |
| Granularity mismatch: builder dedups frames, AD dedups whole files | blocker | **Accepted.** Feature 1 reframed as a NEW owner-aware extension of `duplicateExactFindings`, not a builder port; aliasIndex/reverseIndex/build-queue explicitly do not carry over. §1, §8. |
| Pool separation depends on incomplete `spineRefs` (loose spine pages) | minor | **Accepted, documented.** Harmless under whole-file restriction (byte-identical regardless of pool). §3b, §9.9. |
| Lazy-marking UX gated behind aggressive + flat-pack noise | major | **Accepted.** Bundles panel suppressed for flat packs (single implicit `(root)` bundle); UI note that marking only affects multi-folder packs; deterministic alphabetical fallback kept. §5a. |
| oxipng WASM weight unquantified vs invariant 4 | major | **Accepted.** oxipng lazy-loaded on first use only, never in diagnosis path; diagnosis ≤10s untouched (fix is an explicit Pro action). §4c, Task 10, §11.6. |
| AVIF chroma gate over-justified (3=YUV444 IS in encode.js) | minor | **Accepted.** Note corrected: 3=YUV444 confirmed; only 0/1/2 needs Task 14. Gate kept. §4d. |
| `skipped[]` strings must surface where users expect them | minor | **Accepted.** Omitted-control reasons emitted at the relevant control with "Why no X?" titles. §5b, §4d. |

---

## 14. OPEN QUESTIONS (genuine product decisions for the human)

1. **Whole-file deletion safety.** Default: KEEP whole-file dups whose reference may live in game code (we only delete + rewrite when AD itself emits the referencing manifest). Acceptable as-is, or do you want an explicit "I confirm no code references these" opt-in that permits deletion of loose dups?
2. **Lazy-may-consume-eager vs absolute literal rule.** The safe design lets a lazy member consume a *globally-resident eager* owner (one cross-bundle edge, provably safe under the pinned eager definition). The absolute-literal reading of your rule is "a lazy-bundle asset is NEVER a consumer of anything." Ship the safe version (more dedup, zero risk under eager semantics), or flip to the absolute-literal version (`LAZY_MAY_CONSUME_EAGER=false`, fewer drops)? Also: prefer the **two-phase owner-name resolution** (more capable) or the simpler **forbid owner=transform** fallback for v1?
3. **Lazy load-order declaration.** v1 treats distinct lazy bundles as incomparable. Do you foresee needing user-declared lazy load-order (extra dominance edges) soon enough to design the data shape now, or defer?
4. **pngquant drop.** Accept the drop for v1 (steer to WebP/AVIF), or invest later in a clearly-labeled experimental `imagequant-wasm` flag (supply-chain risk, single 0.1.x release)?
5. **AVIF chroma toggle.** Confirm: hold the UI toggle until Task 14 verifies the 0/1/2 mapping (recommended — silent font fringing is a real regression)?
6. **oxipng dependency + max-effort budget.** OK to add `@jsquash/oxipng` (lazy-loaded, never in diagnosis), and is opt-in-only max-effort sufficient, or do you want a hard per-image time cap?
7. **Determinism claim scope.** Confirm marketing/receipt will NOT claim byte-identical/reproducible for resize or canvas-composed (repack/merge) output — only for in-place transcode, dedup-drop, oxipng recompress, and direct-blit repack-without-downscale.