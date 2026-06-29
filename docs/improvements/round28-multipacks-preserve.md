# Preserve & re-emit TexturePacker meta.related_multi_packs on the verbatim passthrough/resize re-emit (multipack round-trip safety) (PROCEED)


# Verdict: PROCEED — premise re-verified true & unhandled

## Problem (verified against real code, cited)

A TexturePacker multipack export (content exceeding max texture size, common in real games) emits page-0 `sheet-0.json` carrying `meta.related_multi_packs: ["sheet-1.json", ...]` (sibling **JSON manifest** filenames, NOT images). Pixi v8 auto-loads those siblings from this field; without it, only page-0 frames resolve.

Verified facts (all cited):
1. `related_multi_packs` appears NOWHERE in source (grep over packages/parsers, core, ingest, fix, apps/web/src/worker, apps/cli = 0 hits). The only references are in `node_modules/.pnpm/pixi.js@8.19.0/.../spritesheet/spritesheetAsset.mjs:39,121` (the brief's bare `node_modules/pixi.js` path was a pnpm symlink artifact — the real install is under `.pnpm/pixi.js@8.19.0`, version confirmed).
2. Pixi only auto-loads siblings when `asset.meta.related_multi_packs` is an array: `spritesheetAsset.mjs:121-124` (`const multiPacks = asset?.meta?.related_multi_packs; if (Array.isArray(multiPacks)) {…}`); each entry is loaded as a sibling **`.json`** via `loader.load({ src: basePath + item })` (`:128-133`) and cached at `${basePath}/${asset.data.meta.related_multi_packs[i]}` (`:39`). So entries are sibling JSON names, not page images.
3. `parseAtlasManifest` (packages/parsers/src/atlas.ts:127-222) reads meta.image/size/format/scale into `Atlas` but NOT related_multi_packs (atlas.ts:213-220).
4. Core `Atlas` interface (packages/core/src/index.ts:67-77) has no field for it.
5. `emitTexturePackerJson` builds `meta` FROM SCRATCH (packages/fix/src/manifest.ts:27-34) — only app/version/image/size/format/scale; unknown keys are DROPPED.
6. Ingest groups a multipack set as N independent atlases — `manifestImage()` keys on `meta.image` only (packages/ingest/src/index.ts:78-83). (Per scoping guidance this stays unchanged; pages are independently audited and VRAM accounting is already correct.)
7. The passthrough transcode re-emits via `repointAtlasImage(atlasOfRef, sidecar, emittedPageA)` → `emitTexturePackerJson(repointedA)` (fix.worker.ts:2484-2487). `repointAtlasImage` is a shallow clone `{ ...atlas, imageRef }` (packages/fix/src/atlas-transcode.ts:19-21) → any new optional Atlas field flows through automatically.
8. The now-false comment: fix.worker.ts:2409 claims "DROP-IN: the sidecar still resolves every frame; manifest round-trips." For a multipack page-0, related_multi_packs is dropped ⇒ siblings stop loading ⇒ page-1+ frames become undefined textures at runtime with no error, while the receipt claims a clean disk-only optimization (honesty defect, invariants 3 & 5).

CONSEQUENCE: silent drop-in correctness break on a common input on the PAID fix path. Real, valuable, contained.

Baseline confirmed green before any change: 48 parsers tests + 429 fix tests pass (`corepack pnpm --filter @asset-doctor/parsers --filter @asset-doctor/fix test`).

---

## v1 scope (the LOW-RISK verbatim-preserve slice only)

(a) **Parse**: read `meta.related_multi_packs` as `string[]` in `parseAtlasManifest`.
(b) **Model**: carry it as an OPTIONAL `relatedMultiPacks?: string[]` on core `Atlas` (omit-when-absent).
(c) **Emit**: `emitTexturePackerJson` writes `related_multi_packs` into meta ONLY when present and non-empty.
(d) **Worker**: the field flows verbatim through the two in-scope re-emit sites where page count + sibling JSON names are UNCHANGED:
  - passthrough transcode (fix.worker.ts:2484-2487, via `repointAtlasImage` spread) — gated to the byte-stable default,
  - resize-atlas downscale (fix.worker.ts:2276, via `scaleAtlas` spread) — gated to the byte-stable default.
(e) **Honesty guards** (adversarial corrections, see below): strip the field on the TIER path and on any hashed-rename re-emit, because those rename sibling sidecars and would mis-link to wrong-tier / nonexistent siblings.
(f) Update the false drop-in comment at fix.worker.ts:2409.

## Out-of-scope / explicit deferral

- **Generated-multipack regeneration** (repack/merge/packLoose where page COUNT changes and page-0 must list freshly-generated, possibly cache-busted sibling basenames). DEFERRED. It is already clean by construction: `repackAtlases` builds output atlases FROM SCRATCH (`{name,imageRef,size,sprites,source,...format}` — packages/fix/src/repack.ts:300,434), never spreading a source atlas, so `relatedMultiPacks` is simply absent ⇒ those manifests emit byte-identically (no field) — status quo, no regression introduced. We do NOT fabricate the field there.
- **Hashed-filename multipack (`hashFilenames:true`)**: under hashing, sibling `.json` sidecars are renamed (`sheet-1.json → sheet-1.<hash>.json` via `hashEmit`, fix.worker.ts:990-1004), so a verbatim `related_multi_packs:["sheet-1.json"]` would dangle. v1 STRIPS the field on the hashed path (honest: better an unlinked-but-valid page-0 than a dangling sibling reference) and surfaces an honest skip note. Full hash-aware sibling-name regeneration is deferred.
- **Ingest grouping unchanged** (pages stay independently audited).
- No new finding/messageKey, no new saving/estimate, no UI string ⇒ **i18n drift guard not engaged**, no golden fixture reconciliation needed (additive field, omit-when-absent ⇒ existing fixtures byte-identical).

---

## Additive contract / type changes (must be additive — absent ⇒ byte-identical)

`packages/core/src/index.ts`, `Atlas` interface (after `scale?`):
```ts
/** TexturePacker/Pixi multipack linkage: sibling **manifest** (`.json`) filenames Pixi auto-loads
 *  from page-0 (meta.related_multi_packs). Carried VERBATIM from parse and re-emitted by
 *  emitTexturePackerJson ONLY on a byte-stable passthrough/resize re-emit (page count + sibling
 *  names unchanged). Spine has no equivalent (inline multi-page) ⇒ never emitted to .atlas.
 *  Absent ⇒ NO meta key written ⇒ JSON byte-identical to today (single-page is the common case). */
relatedMultiPacks?: string[];
```
Omit-when-absent on every path ⇒ byte-identical for single-page atlases and for any input that never had the field.

---

## Pure modules + exact signatures

### 1. `packages/parsers/src/atlas.ts` — parse (new helper + 2 lines)
Add a guarded string-array reader (mirrors `parseScale` style), and read it after scale (atlas.ts:220):
```ts
function readStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;            // non-array ⇒ omit (matches Pixi's Array.isArray gate)
  const out: string[] = [];
  for (const e of v) if (typeof e === 'string' && e.length > 0) out.push(e); // skip non-string/empty (Pixi skips non-strings :125)
  return out.length ? out : undefined;                 // empty ⇒ omit ⇒ byte-identical
}
```
Insert at atlas.ts ~220 (after the scale block, before `return`):
```ts
const relatedMultiPacks = readStringArray(meta.related_multi_packs);
if (relatedMultiPacks) atlas.relatedMultiPacks = relatedMultiPacks;
```
Pure, worker-safe, deterministic (filter preserves source order). No change to `AtlasParseResult`/error paths.

### 2. `packages/fix/src/manifest.ts` — emit (1 conditional key in `meta`)
In `emitTexturePackerJson`, append to the `meta` object literal (manifest.ts:33, after scale), preserving fixed key order:
```ts
...(atlas.relatedMultiPacks && atlas.relatedMultiPacks.length
  ? { related_multi_packs: atlas.relatedMultiPacks }
  : {}),
```
`emitSpineAtlasText` is NOT touched (Spine has no related_multi_packs; it is inline multi-page). Determinism preserved: array is carried verbatim, no sort (filenames are an ordered list Pixi indexes positionally at spritesheetAsset.mjs:39 — re-sorting would corrupt the index↔linkedSheets pairing, so we MUST NOT sort).

### 3. `packages/fix/src/atlas-transcode.ts` / `repack.ts` — NO code change
Both `repointAtlasImage` (`{ ...atlas, imageRef }`, atlas-transcode.ts:20) and `scaleAtlas` (`{ ...atlas, size, sprites }`, repack.ts:70) already spread the source atlas ⇒ `relatedMultiPacks` flows through verbatim for free. (`scaleAtlas` does NOT rewrite the array — correct, since it points at sibling JSONs which a downscale keeps by name.)

---

## Worker changes (apps/web/src/worker/fix.worker.ts)

The emitter now writes the field whenever present; the worker must DELETE it on the unsafe paths (tier + hashed). Net diff is tiny:

1. **Passthrough transcode (in-scope, :2484-2490)** — under the byte-stable default (sidecar keeps its name, siblings untouched) the field flows verbatim through `repointedA`. Guard: if `hashOn` (sibling sidecars get renamed), strip it before emit:
```ts
const repointedA = repointAtlasImage(atlasOfRef, sidecar, emittedPageA);
if (hashOn && repointedA.relatedMultiPacks) {
  repointedA.relatedMultiPacks = undefined;
  skipped.push({ assetRef: ref, reason: 'multipack: related_multi_packs dropped under content-hashed filenames (sibling sidecars renamed) — load sibling packs explicitly' });
}
```
Update the comment at :2409 from "manifest round-trips" to the honest: "multipack `related_multi_packs` is preserved verbatim on the byte-stable default (sibling JSON names unchanged); dropped (with an honest skip) under hashed filenames where siblings are renamed."

2. **Resize-atlas (in-scope, :2276 TP path)** — same shape: `scaled` carries the field; strip when `hashOn` (the sidecar is hashed at :2277) with the same honest skip note. Spine resize path (:2254) needs nothing (emitSpineAtlasText never writes it).

3. **Tier path (out-of-scope HAZARD, :3366/:3340)** — `scaled = scaleAtlas(...)` carries the field, but the tier sidecar is emitted under a SUFFIXED name (`variantManifestName(manifestPath, tier.suffix, ...)`, e.g. `sheet-0_720p.json`). Verbatim `["sheet-1.json"]` would mis-load the FULL-res sibling into a `_720p` sheet (cross-tier mix). MUST strip unconditionally on the tier path:
```ts
scaled.relatedMultiPacks = undefined; // tier siblings live under suffixed names; verbatim refs would cross-mix resolutions (deferred: tier-aware regeneration)
```
(Set right after `scaled.scale = tier.scale; scaled.imageRef = ...` at :3337-3338, covering both the Spine and TP branches.)

4. **Repack / merge / packLoose / dedup / KTX2 sites** — no change. Repack/merge/packLoose atlases are scratch-built (no field). Dedup-repoint sites (:3023-3027, :3061-3065) spread the source consumer atlas and KEEP the manifest (only the duplicate IMAGE is dropped — siblings untouched), so verbatim preserve there is a free CORRECT bonus, no extra code.

No backend changes (invariants 1/2 untouched — 100% in-browser pure parser+emitter+model).

---

## UI changes
None. The honest skip notes (multipack-dropped-under-hashing) surface through the existing `skipped[]` receipt channel already rendered in the fix receipt — no new component, no new string requiring i18n.

---

## Honesty + invariant compliance
- **Invariant 3 (objective, generate nothing)**: we only round-trip a field the author already wrote, or carry it through a clone. We never fabricate sibling names; the deferred generated-multipack case is explicitly NOT synthesized (it emits no field). No new saving/estimate.
- **Invariant 5 (disk≠VRAM)**: the field is metadata only — zero pixel/VRAM impact, no new claim. The existing "disk-only, no VRAM claim" semantics of transcode/resize are unchanged.
- **Invariants 1/2**: pure, browser-only, no backend.
- **Honesty of the comment**: the false "manifest round-trips" claim is corrected to the precise, conditional truth (verbatim on the byte-stable default; honestly skipped under hashing).
- **Direction/correctness of the preserve**: verbatim is correct EXACTLY where sibling JSON names are unchanged (passthrough transcode + resize on the hashOff default + dedup-keep-manifest). Where names DO change (tier suffix, hashed rename) we strip + surface, never silently mis-link.

## Determinism
Array carried verbatim (NO sort — positional index is load-bearing per spritesheetAsset.mjs:39). No Date.now/Math.random. Same input ⇒ same JSON bytes. `readStringArray` filter is order-preserving and total.

## Edge cases
- `related_multi_packs` absent / non-array / empty / non-string entries ⇒ omitted (byte-identical; matches Pixi's `Array.isArray` + `typeof item==='string'` gates).
- Single-page atlas (common case) ⇒ no field ⇒ byte-identical JSON.
- Spine page ⇒ field never read (JSON-only) and never emitted to `.atlas`.
- Page-image transcode renames `sheet-0.png→sheet-0.webp` but `related_multi_packs` references sibling `.json` (unchanged) ⇒ linkage holds.
- Sibling page (`sheet-1.json`) independently transcoded ⇒ its own meta.image repoints; its name as referenced by page-0 is unchanged ⇒ linkage holds.
- hashOn ⇒ sibling `.json` renamed ⇒ field stripped + honest skip.
- Tier export ⇒ field stripped (would cross-mix resolutions).

---

## Test plan (against the real harness)

**A. parsers (`packages/parsers/test/parsers.test.ts`, currently 48 tests, field-level asserts only — no whole-atlas deep-equal, safe):**
1. `meta.related_multi_packs:["sheet-1.json"]` parses to `atlas.relatedMultiPacks === ['sheet-1.json']`.
2. Multi-entry order preserved (`["a.json","b.json"]` → same order).
3. Absent ⇒ `atlas.relatedMultiPacks === undefined`.
4. Non-array (`"sheet-1.json"`) ⇒ undefined.
5. Mixed/garbage entries (`["a.json", 3, "", "b.json"]`) ⇒ `['a.json','b.json']`.
6. Empty array `[]` ⇒ undefined (omit).

**B. fix manifest/transcode round-trip (`packages/fix/test/atlas-transcode.test.ts`, extend the existing 8-test suite — reuse its `atlasWith` helper + parse→emit→re-parse pattern):**
7. Add `relatedMultiPacks:['sheet-1.json']` to an atlas → `emitTexturePackerJson` → `JSON.parse` → `meta.related_multi_packs` deep-equals `['sheet-1.json']`.
8. `repointAtlasImage` preserves `relatedMultiPacks` through the shallow clone (assert on the returned Atlas).
9. **Byte-identical guard**: an atlas WITHOUT the field emits JSON with NO `related_multi_packs` key (`expect(JSON.stringify(parsed.meta)).not.toContain('related_multi_packs')` + full-string compare to the pre-change golden output to prove byte-identity for single-page).
10. Full round-trip: `emit(repoint(atlasWithField, sidecar, newPage))` → `parseAtlasManifest` → `relatedMultiPacks` intact AND `meta.image` resolves to the new page (compose with the existing no-dangling assertion).
11. Spine: `emitSpineAtlasText` of an atlas carrying `relatedMultiPacks` does NOT emit the field anywhere in the `.atlas` text (`not.toContain('related_multi')`).

**C. fix.worker behavioral (if a worker-level harness exists for the transcode/resize/tier branches — otherwise assert via the pure helpers in B):** assert tier `scaleAtlas` output has the field stripped before emit (unit-test the strip line by checking the emitted tier JSON omits `related_multi_packs`).

**D. Full regression:** `corepack pnpm --filter @asset-doctor/parsers --filter @asset-doctor/fix test` (expect 48→54 parsers, 429→~437 fix, all green) + `corepack pnpm typecheck` (new optional field). i18n: NO drift test runs (no messageKey added) — confirm by checking no `messageKey`/catalog file touched. Golden fixtures: NO reconciliation (additive, omit-when-absent ⇒ existing `expected.json` byte-identical) — confirm `corepack pnpm test` golden suite stays green.

---

## Ordered small-commit breakdown
1. **core**: add `relatedMultiPacks?: string[]` to `Atlas` with the documented JSDoc (additive contract; no behavior).
2. **parsers**: `readStringArray` helper + read `meta.related_multi_packs` in `parseAtlasManifest`; add parsers tests (A1–A6).
3. **fix/manifest**: emit `related_multi_packs` conditionally in `emitTexturePackerJson` (omit-when-absent); add fix tests (B7–B11) incl. the byte-identical single-page guard.
4. **worker**: strip on tier path (:3337 area) + strip-on-hashOn for passthrough transcode (:2484) and resize-atlas (:2276) with honest skip notes; (dedup/repack/merge need no change).
5. **worker comment**: rewrite the false drop-in claim at :2409 to the honest conditional statement.
6. **green-up**: run parsers+fix tests + typecheck; confirm i18n untouched and goldens byte-identical.

Each commit is one coherent meaning, contract-first, with the additive guarantee provable at every step (absent field ⇒ byte-identical output).
