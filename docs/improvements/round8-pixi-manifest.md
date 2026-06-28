I now have complete grounding. I have verified every load-bearing claim. Here is my adversarial assessment and the final revised design.

Key verified findings that change the design materially:
1. **The `data.resolution` remediation for atlases is WRONG/unconfirmed.** Bug #10108 confirms the resolver skips the retina parser for `.json`/`.atlas` and the canonical Pixi v8 mechanism for multi-resolution spritesheets is the **filename convention** `name@Nx.<fmt>.json` (e.g. `hud@0.5x.png.json`), with `meta.scale` in the JSON as a load-time fallback. The issue does NOT document `data.resolution` as a working fix. The design must not stake correctness on `data.resolution`.
2. **The worker's emitted sheet names are NOT `@Nx`-resolvable.** `variantManifestName` produces `hud_540p.webp.json` (a `_540p` resolution token + `.webp` format token), not `hud@0.5x.webp.json`. So multi-resolution atlas tiers cannot be auto-resolved by Pixi from the manifest regardless of what the builder does. The honest move: emit **one asset entry per tier** with distinct aliases (which the design already lands on) and rely on `meta.scale` (already written by `emitTexturePackerJson` line 33) for runtime scale, NOT a fabricated `data.resolution`.
3. **AssetPack alias shape differs** from the design (`["ui/btn.png","btn.png"]` full-path+shortcut, not `["btn","ui/btn.png"]`) — cosmetic, both load; the design should stop claiming it mirrors AssetPack and just guarantee non-colliding lookup keys.
4. Worker line numbers drifted but emit sites/variables verified: tier image `:1704`, tier manifests `:1716/:1725`, loose fan-out `:879`, single resize/transcode `:1169/:1221`, repack single `:1055/:1061`, merge `:1044/:1045`, spine repack `:938/:939`, pack `:1440`, pass-through `:1840`, dedup tail `:1846-1856`, `inputPaths` `:584`, `sha256Hex` `:2138`. All confirmed.
5. i18n catalogs are **flat dotted keys**, 9 catalogs — design correct.

---

# Design: Additive, Opt-In PixiJS Asset Manifest (`manifest.json`) for the Fix Output — REVISED

**Status:** implementation-ready · **Owner:** `packages/fix/src/pixi-manifest.ts` (pure) + `apps/web/src/worker/fix.worker.ts` (gated collector + one push) · **Default:** OFF (off ⇒ zip byte-identical)

## 0. What changed after code/doc verification (read this first)

| # | Draft claim | Verdict | Resolution |
|---|---|---|---|
| B1 | Stamp `data.resolution = 1/scale` on atlas/Spine candidates to fix Pixi #10108 | **BLOCKER — unconfirmed/likely wrong.** Issue #10108 shows the resolver skips the retina parser for `.json` because its test rejects non-image extensions; the documented v8 mechanism is the **filename** `name@Nx.<fmt>.json` convention + the spritesheet's own `meta.scale` fallback. `data.resolution` is NOT a documented working workaround. | **Drop `data.resolution` entirely.** For multi-resolution atlases, emit **one asset entry per tier** with a **tier-suffixed alias** (the game picks the tier by alias, e.g. `hud@540p`). Runtime scale comes from the sheet's own `meta.scale` (already emitted by `emitTexturePackerJson:33`). No fabricated resolver field. `data` is omitted in v1. |
| B2 | Worker emits `@Nx`-style names so loose tiers "resolve natively" | **FALSE PREMISE.** `tieredName`/`variantManifestName` emit `_540p`/`_540p.webp.json` tokens, NOT `@Nx`. Pixi's resolver only parses `@Nx` for **image** candidates; `_540p` is never parsed, and `.json` is never parsed at all. | **No auto-resolution of tiers via `src` arrays at all.** Both loose AND atlas tiers emit **one alias-suffixed entry per tier**. A single tier (the common case) collapses to one entry. This removes the draft's confusing "loose collapses, atlas doesn't" asymmetry. |
| B3 | alias = `["btn","ui/btn.png"]`, "mirrors AssetPack" | Minor — AssetPack actually emits `["ui/btn.png","btn.png"]` (full path + `createShortcuts`). Both forms load (alias is just lookup keys). | Stop claiming AssetPack parity. Emit `alias = [fullPathNoExt, basenameNoExt]` deduped, with a bundle-wide collision guard keeping only the unique full-path alias on collision. |
| M1 | Cache-busting hash for loose images in v1 | Honest but **cut to follow-up.** It couples to loader-migration rows and adds risk for little v1 value; the draft itself flags atlas hashing as deferred. | **Cut ALL hashing from v1.** Keep `hashedName` as a pure, tested helper + a reserved (UI-less) `hashFilenames` field, documented as a follow-up. This keeps v1 self-contained and the additivity proof trivial. |
| OK | `{ bundles }` only, no `version`/`meta` | **Confirmed** across 3 Pixi sources. | Keep. |
| OK | Pre-expanded explicit `src` arrays, never brace templates | **Confirmed** (AssetPack writes expanded arrays). | Keep. |
| OK | Emit after dedup, into `dedupedOut`, byte-identical when off | **Confirmed** against worker `:1846-1856`. | Keep. |
| OK | Names keyed off recorded post-fallback `enc.mime` paths | **Confirmed** — recording at the `out.push` site captures `enc.mime` fallbacks. | Keep. |

Net effect: the manifest becomes **simpler, more honest, and actually loadable** — it is a flat alias→src map where every entry has a single resolvable load target (a loose image, a `.json` sheet, or a `.atlas`), one entry per resolution tier, no invented resolver fields.

---

## 1. v1 Scope / Out-of-Scope

### In scope
- Pure builder `packages/fix/src/pixi-manifest.ts` → deterministic PixiJS-v8 `AssetsManifest` **string** (`{ bundles: [...] }` only).
- Coverage of every variant-producing output family the worker actually emits (verified emit sites):
  - **Loose transcode/resize single** (`:1169`, `:1221`) → `renamedTo` image, one entry.
  - **Loose export-profile fan-out** (`:879`) → one entry, `src` = all format candidates (same resolution tier).
  - **Tier loop** (`:1704` image, `:1716`/`:1725` manifests) → loose/atlas/spine, **one entry per tier** (alias-suffixed), `src` = the tier's format candidates.
  - **Repacked single atlas** (`:1055`/`:1061`) → `src = [<manifest.json>]`.
  - **Atlas-merge** (`:1044`/`:1045`) → one entry **per merged page `.json`**.
  - **Pack-loose new sheets** (`:1440`) → one entry per emitted page `.json` (static) / `.atlas` (Spine).
  - **Spine repack** (`:938`/`:939`) → `src = [<.atlas>]`, PNG-only.
  - **Pass-through parsed images** (`:1840`) → one single-candidate entry (complete asset map). Non-image pass-throughs excluded.
- UI toggle + i18n (4… now 2 keys — hashing cut).
- Determinism; no `Date.now`/`Math.random`.
- Builder unit tests against the real `packages/fix/test` harness.

### Out of scope (v1)
- **No `data` field at all** (no `data.resolution` — B1; no `scaleMode`). Reserved for v2 if a real need appears.
- **No `@Nx`-based src-array resolution collapsing** (B2) — tiers are separate alias-suffixed entries.
- **No wildcard/brace authoring sugar** — explicit pre-expanded `src` arrays.
- **No top-level `version`/`meta`/`schemaVersion`.**
- **No multiple bundles** — single `"default"` bundle.
- **No filename content-hashing** (M1) — `hashedName` ships as a tested pure helper + reserved field, no UI, no worker wiring.
- **No Spine runtime-loader wiring** — `.atlas` listed honestly; the game still needs `pixi-spine`.
- **No mutation** of `FixReceipt.changes`/`FixChange`.

---

## 2. Additive Types

Local mirror types in `pixi-manifest.ts` (NOT `@asset-doctor/core` — output wire-format of one package; `packages/fix` must not depend on `pixi.js`):

```ts
// packages/fix/src/pixi-manifest.ts — LOCAL mirror of the PixiJS v8 public manifest shape.
// Verified against pixijs.download AssetsManifest docs + AssetPack output: AssetsManifest = { bundles }
// and NOTHING else (no version/meta). alias & src are string arrays. data is OMITTED in v1 (Pixi #10108:
// data.resolution is NOT a documented working resolver field for .json/.atlas candidates).

export interface PixiUnresolvedAsset {
  /** Lookup name(s). Array form (AssetPack convention). We emit [fullPathNoExt, basenameNoExt] deduped. */
  alias: string[];
  /** ONE logical asset → MANY candidate URLs (pre-expanded format alternatives, never a brace template).
   *  Each candidate is a real emitted zip-entry path. For a sheet, the .json/.atlas (loader reads meta.image). */
  src: string[];
}
export interface PixiAssetsBundle { name: string; assets: PixiUnresolvedAsset[]; }
export interface PixiAssetsManifest { bundles: PixiAssetsBundle[]; }
```

Protocol additions (`apps/web/src/worker/fix-protocol.ts`, into `FixOptions`):

```ts
  /** Emit an additive PixiJS-v8 manifest.json describing every emitted variant so the game can load the
   *  whole output with one Assets.init({ manifest }). OPT-IN: absent/false ⇒ NO entry ⇒ zip byte-identical
   *  to today. Pure string work in the worker (no native libs, no network — invariant 1). Deterministic. */
  emitPixiManifest?: boolean;
  /** RESERVED for a follow-up (content-hash cache-busting). Field accepted + ignored in v1 (no UI, no worker
   *  wiring) so the wire type is forward-stable. Absent/false ⇒ today. */
  hashFilenames?: boolean;
```

Receipt addition (spread-omitted when absent ⇒ byte-identical):

```ts
  /** Additive: emitted only when the Pixi manifest opt-in ran with ≥1 entry. `assets` = logical entries
   *  listed; `path` = the manifest's zip-entry name. Absent ⇒ no manifest emitted. */
  pixiManifest?: { assets: number; path: string };
```

---

## 3. Pure Builder — Signature + Algorithm

```ts
// packages/fix/src/pixi-manifest.ts

/** Classification mirroring the worker's kindOf (fix.worker.ts:369) — drives whether `src` points at the
 *  IMAGE (loose) or the sidecar MANIFEST (.json/.atlas). */
export type ManifestAssetKind = 'loose' | 'atlas' | 'spine';

/** One emitted variant of a logical asset — facts the worker already has at its out.push site. Names are
 *  produced by the SAME scale.ts/dedup-exec.ts helpers the worker pushed (tieredName / variantManifestName
 *  / renamedTo), so the manifest references exactly the files that exist (no re-derivation). */
export interface EmittedVariant {
  /** scale ∈ (0,1]; 1 for a non-tiered emit / top tier. Used ONLY for the per-tier alias suffix + sort. */
  scale: number;
  /** Resolution-tier suffix as the worker emitted it (e.g. '_540p'); '' for a non-tiered emit. Drives the
   *  per-tier alias suffix so multi-tier assets stay distinct lookup keys (Pixi #10108: no auto-resolve). */
  suffix: string;
  /** The candidate URL Pixi LOADS = exact zip-entry path. For loose: the image. For atlas/spine: the
   *  .json/.atlas sidecar (Pixi reads meta.image itself). One src candidate; format alternatives at the
   *  SAME (scale,suffix) share ONE EmittedVariant via `siblings` below. */
  src: string;
}

/** One logical asset → its emitted variants, grouped by (kind, alias base). `ref` = dir-aware ingest key
 *  (keyOf). `source` = original path (pathByRef.get(ref)) for the secondary alias. Variants at the same
 *  (scale,suffix) but different FORMAT are merged into one manifest entry whose src lists all formats. */
export interface ManifestAsset {
  ref: string;
  kind: ManifestAssetKind;
  source: string;
  variants: EmittedVariant[];
}

export interface BuildPixiManifestOptions { bundleName?: string; }

/** Build a deterministic PixiJS-v8 AssetsManifest STRING. PURE. No Date.now/Math.random. JSON.stringify(_,2)
 *  mirroring emitTexturePackerJson's determinism. No `data` field (Pixi #10108). */
export function buildPixiManifest(assets: ManifestAsset[], opts?: BuildPixiManifestOptions): string;

/** Insert a short content hash before the final extension. PURE helper, SHIPPED + TESTED but UNUSED in v1
 *  (cache-busting deferred). hashedName('a/b_540p.webp','a1b2c3d4') === 'a/b_540p.a1b2c3d4.webp'. */
export function hashedName(path: string, hash: string): string;
```

### Algorithm (deterministic)

1. `bundleName = opts?.bundleName ?? 'default'`.
2. **Group each `ManifestAsset`'s variants by `suffix`** (the resolution-tier key). Each distinct suffix → **one Pixi asset entry** (one entry per tier — B1/B2 honesty). Variants sharing a suffix but differing only in format are the `src` candidates of that one entry.
3. For each (asset, suffix) group, build the entry:
   - **alias base** = `stemOf(ref)` where `stemOf` strips the extension from the dir-aware ref (full relative path, no ext) — e.g. `ui/hud.json` → `ui/hud`. Secondary alias = `basenameNoExt` (e.g. `hud`).
   - **tier suffix on the alias** when the asset has **>1 distinct suffix** (a real tier ladder): append the suffix to BOTH aliases (e.g. `ui/hud_540p`, `hud_540p`) so each tier is a distinct, collision-free lookup key the game selects explicitly. A single-suffix asset (the common case) appends nothing → clean `["ui/hud","hud"]`.
   - **alias array** = `[fullPathAlias, basenameAlias]`, deduped if equal.
   - **alias-collision guard** (bundle-wide `Set`): the **full-path alias is unique by construction** (dir-aware `keyOf` + unique suffix). If a **basename alias** repeats across the bundle, **drop the basename alias for the later entry**, keep only the unique full-path alias (mirrors AssetPack `createShortcuts` uniqueness — never two identical shortcuts).
   - **src** = the group's variant `src` values, sorted (§5), de-duped (defensive against B4 fallback collisions).
4. **Sort entries** within the bundle by `alias[0]` (codepoint `localeCompare`, matching `manifest.ts:9`).
5. `JSON.stringify({ bundles: [{ name: bundleName, assets }] }, null, 2)` — fixed key order `{ name, assets }`, each asset `{ alias, src }` (no `data`), mirroring `emitTexturePackerJson`'s fixed-order pattern.

**Runtime scale honesty:** for atlas/Spine tiers, the per-tier scale lives in the **sheet's own `meta.scale`** (the worker already writes it: `scaled.scale = tier.scale` → `emitTexturePackerJson:33`/`emitSpineAtlasText`). The manifest does NOT restate it. The game picks a tier by its **alias suffix**; Pixi reads the real scale from the loaded sheet. No fabricated resolver field (invariant 3).

---

## 4. Worker-Side Collector (impure, thin, gated)

```ts
const manifestOn = opts.emitPixiManifest === true;
// ref+suffix is NOT the map key — ref is (one ManifestAsset accumulates all tiers); the builder groups by
// suffix. Off ⇒ map never allocated ⇒ zero behavior change.
const manifestAssets = manifestOn ? new Map<string, ManifestAsset>() : undefined;
const recordVariant = (ref: string, kind: ManifestAssetKind, source: string, v: EmittedVariant): void => {
  if (!manifestAssets) return;
  let a = manifestAssets.get(ref);
  if (!a) { a = { ref, kind, source, variants: [] }; manifestAssets.set(ref, a); }
  a.variants.push(v);
};
```

**Record sites** (each verified to have path + scale/suffix + kind in scope):

| Emit site (verified line) | kind | record call (the `src` is the SAME path pushed to `out`) |
|---|---|---|
| Loose fan-out `:879` | `loose` | `recordVariant(ref, 'loose', srcPath, { scale, suffix: '', src: variantPath })` |
| Loose single resize `:1169` | `loose` | `recordVariant(ref, 'loose', path, { scale: 1, suffix: '', src: newPath })` |
| Loose single transcode `:1221` | `loose` | `recordVariant(ref, 'loose', path, { scale: 1, suffix: '', src: newPath })` |
| Tier image `:1704` | by `isSpine`/`atlas`/loose | for **loose** tiers only → `recordVariant(ref, 'loose', imagePath, { scale: tier.scale, suffix: tier.suffix, src: tierImagePath })` |
| Tier atlas manifest `:1725` | `atlas` | `recordVariant(ref, 'atlas', imagePath, { scale: tier.scale, suffix: tier.suffix, src: <variantManifestName(...)> })` |
| Tier Spine `.atlas` `:1716` | `spine` | `recordVariant(ref, 'spine', imagePath, { scale: tier.scale, suffix: tier.suffix, src: <variantManifestName(...)> })` |
| Repack single image `:1055` + manifest `:1061` | `atlas` | `recordVariant(ref, 'atlas', imagePath, { scale: 1, suffix: '', src: mPath })` (src = the `.json`, not the image) |
| Spine repack `:938/:939` | `spine` | `recordVariant(ref, 'spine', imagePath, { scale: 1, suffix: '', src: info.path })` |
| Merge page `:1045` | `atlas` | per page: `recordVariant(<mergedRef-i>, 'atlas', '<page image>', { scale: 1, suffix: '', src: '<baseDir><stem>.json' })` |
| Pack page `:1440` | `atlas`/`spine` | per emitted `.json`/`.atlas`: one `recordVariant` per sheet page |
| Pass-through `:1840` | `loose` if parsed image | `recordVariant(ref, 'loose', f.path, { scale: 1, suffix: '', src: f.path })` — only when the file is a parsed loose image (skip non-asset files) |

For **atlas/spine tiers**, record at the **manifest** push (`:1716`/`:1725`), not the image push (`:1704`), so `src` is the sidecar. For **loose tiers**, record at `:1704` (the image IS the load target). Use existing `isSpine`/`atlas`/`manifestPath` already in scope at the tier loop (verified `:1615/:1616/:1629`).

**Crucial:** record only files in the recorded variant set — skip pass-throughs that are not parsed `loose`/`atlas`/`spine` assets (classify via `kindOf(ref)` + presence in `atlasByRef`/`spineRefs`; a pass-through README or hand-authored non-AD `.json` records nothing).

**Emit one entry, after dedup, into `dedupedOut`** (verified tail `:1846-1856`):

```ts
// after dedupedOut is built (:1854), before `entries`/makeZip (:1855):
if (manifestAssets && manifestAssets.size > 0) {
  const json = buildPixiManifest([...manifestAssets.values()]);
  const path = pickManifestPath(inputPaths, dedupedOut);   // collision guard (§6.6); inputPaths verified :584
  dedupedOut.push({ path, bytes: te.encode(json) });
  receipt.pixiManifest = { assets: /* entry count from a parse or a returned count */, path };
}
```

Pushing into `dedupedOut` last + gated by `size > 0` guarantees: **off ⇒ block skipped ⇒ `dedupedOut` unchanged ⇒ `makeZip` input byte-identical ⇒ zip byte-identical** (additivity by construction). `te` (TextEncoder) is already in scope (used at `:1716/:1725` etc.).

`receipt.pixiManifest.assets` — have `buildPixiManifest` optionally return the entry count, or expose a sibling `countPixiManifestEntries(assets)` pure helper, to avoid re-parsing the string.

---

## 5. Determinism + `src` Ordering

- **Bundle sort:** by `name` (single `default` ⇒ trivial).
- **Entry sort:** by `alias[0]` via `localeCompare` (matches `manifest.ts:9`).
- **`src` candidate sort within an entry:** format rank only (all candidates in one entry share a tier) — `{ '.avif':0, '.webp':1, '.png':2, '.jpg':3 }` by file extension. Universal `.png` lands last (the safe fallback Pixi tries when avif/webp aren't preferred). Ties (shouldn't happen) broken by `localeCompare`.
- **Tier ordering** is expressed via **separate alias-suffixed entries**, themselves sorted by `alias[0]` — so `hud@... < hud_540p < hud_720p` order is stable string order. (No `src`-array tier mixing — B2.)
- **No** `Date.now`/`Math.random`. `JSON.stringify(_, null, 2)` for byte-stable re-runs (matches `emitTexturePackerJson:35`).
- Builder re-sorts defensively so output is identical regardless of `recordVariant` insertion order (proven by T8).

---

## 6. Edge Cases (verified against worker)

1. **Spine** (PNG-only, `:938/:1716`): `src=[<.atlas>]`; no webp/avif candidates even under a multi-format profile (worker forces PNG `:1677`, surfaces a skip `:1621`). Multi-page Spine refused upstream → always single-page. No `data` field; runtime needs `pixi-spine` (listed honestly, no load claim).
2. **Merged atlas** (`:1044/:1045`): originals dropped; **one entry per merged page `.json`** (`atlas-merged.json` or `atlas-merged-{i}.json`). Distinct refs per page so aliases don't collide.
3. **Single-format profile** (`formatToken=''`, `:1679`): legacy names (`_540p.json`). Builder consumes recorded paths verbatim → predicts the right sidecar; no single-vs-multi branch in the builder.
4. **Mixed** (atlases tiered, loose transcoded, pass-through): each ref classified independently; bundle-wide basename-alias guard dedups shortcuts.
5. **Pass-through images** (`:1840`): parsed loose images get a single-candidate entry (complete map). Non-image / non-asset pass-throughs excluded.
6. **`manifest.json` collision:** `pickManifestPath(inputPaths, dedupedOut)` — if `manifest.json` is taken (by an input OR an emitted file), fall back to `asset-doctor.manifest.json`, then `asset-doctor.manifest.2.json`, … Never overwrite. (`inputPaths` verified `:584`; mirrors the worker's pack-stem disambiguation.)
7. **Empty fix** (`manifestAssets.size === 0`): emit nothing ⇒ byte-identical. A do-nothing fix gains no manifest.
8. **AVIF→WebP→PNG fallback** (`:1685/:868`): recorded `src` uses the post-fallback `enc.mime` path → never lists a non-existent `.avif` (invariant 3).
9. **B4 same-mime collision** (`:1698/:874`): the later format is skipped (no `out.push`) → no `recordVariant` → no duplicate `src`. Builder de-dups identical `src` defensively anyway.
10. **Repacked single atlas** (`:1053-1061`): image ext → `.webp`, manifest keeps original `.json` path; recorded `src = mPath` (the `.json`) → correct (Pixi reads `meta.image`).
11. **Fonts / audio / non-AD config:** never parsed as `loose`/`atlas`/`spine` → never recorded. The manifest is an image-asset map, not a universal loader (documented in the UI hint).
12. **Format-only profile on an atlas-only folder** (`:1825`): no loose entries; atlas entries still recorded → manifest non-empty and correct.

---

## 7. UI Toggle + i18n

`FixCard` (App.tsx, state block near `:982`):

```tsx
const [emitPixiManifest, setEmitPixiManifest] = useState(false);
```

In the Pro settings disclosure (near the export-profile panel):

```tsx
<label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.pixiManifestHint')}>
  <input type="checkbox" checked={emitPixiManifest} onChange={(e) => setEmitPixiManifest(e.target.checked)} className="accent-teal" />
  {t('fix.pixiManifest')}
</label>
```

`buildOptions` (`:1044`) — forward only when on (off ⇒ undefined ⇒ byte-identical, matching every Pro field):

```ts
emitPixiManifest: emitPixiManifest || undefined,
```

**i18n** — flat dotted keys (verified format), `en.json` is source; add to all **9** catalogs (CLI stays EN, never sets this):

```json
"fix.pixiManifest": "Emit PixiJS manifest.json",
"fix.pixiManifestHint": "Adds manifest.json mapping every emitted image/sheet (and each resolution tier as its own alias) so a PixiJS game can load the whole output with Assets.init({ manifest }). Sheets list the .json/.atlas; Spine still needs pixi-spine. Off ⇒ no extra file."
```

(Only 2 keys — hashing keys cut with M1.) The honesty note about Spine + tier-as-alias is in the hint, not invented in the data.

---

## 8. Cache-Busting — CUT TO FOLLOW-UP (honest)

Per the prompt's instruction ("If cache-busting is not cleanly browser-deterministic, cut it to a follow-up honestly"): it **is** browser-deterministic (pure `sha256Hex` of bytes, `:2138`), but it **couples** to the atlas `meta.image` re-emit-then-hash ordering and the `FixChange.pageImages` loader-migration rows, adding cross-cutting risk for marginal v1 value. **Cut from v1.** Ship `hashedName` as a pure, tested helper and keep `hashFilenames` as a reserved-but-ignored field (forward-stable wire type, no UI). Follow-up RFC covers: (1) hash loose images at `:879/:1169/:1221`, (2) atlas page hash → patch `meta.image` → re-emit → hash the manifest, (3) reflect hashed names in `recordVariant` AND `FixChange.pageImages`. The builder is hash-agnostic, so the follow-up adds zero builder churn.

---

## 9. Honesty / Invariants

- **Inv 1 (in-browser):** pure string work in the worker; no native libs, no network; @jsquash untouched.
- **Inv 2 (thin backend):** nothing touches the server.
- **Inv 3 (objective / no faked anything):** lists ONLY files the engine produced (keyed off post-fallback `enc.mime`); advertises no format/tier that wasn't encoded; **emits no fabricated `data.resolution`** (dropped precisely because it isn't a documented working field — B1); implies no saving — it is naming/structure only. It is generation **in the fix engine**, the one place generation is allowed.
- **Inv 4 (instant-wow):** Phase-2 artifact, off the diagnosis path.
- **Inv 5 (disk ≠ VRAM):** does NOT sum variant footprints; format fan-out is disk-only; the per-tier VRAM ladder stays in `tierVram`, untouched.
- **Additivity:** off ⇒ no `dedupedOut` entry, no filename change ⇒ **zip byte-identical**. Enforced by structure (`manifestAssets` undefined when off; emit gated on `size > 0`) — see §11 additivity note.

---

## 10. Test Plan (`packages/fix/test/pixi-manifest.test.ts`, mirrors the no-worker-harness pattern)

| # | Test | Asserts |
|---|---|---|
| T1 | Loose single-format → entry | `alias=["ui/btn","btn"]`, `src=["ui/btn.webp"]`; no `data` key present. |
| T2 | Loose multi-format, single tier | one entry, `src` ordered avif,webp,png; `.png` last; alias has no suffix. |
| T3 | Loose multi-tier | one entry **per tier**, alias suffixed (`["ui/btn_540p","btn_540p"]` etc.); each `src` = that tier's formats; entries sorted by alias[0]. |
| T4 | Atlas repack (drop-in) | `src=["ui/hud.json"]` (the sidecar), image NOT in src; no `data`. |
| T5 | Multi-resolution atlas | **one entry per tier**, alias suffixed, `src` = the tier's `.json`(s); **no `data.resolution`** (regression guard for B1). |
| T6 | Spine | `src=[".atlas"]`; PNG-only even with a multi-format profile; no `data`. |
| T7 | Merged atlas multi-page | one entry per page `.json`. |
| T8 | Alias collision | two `btn.png` in different dirs ⇒ second drops its basename alias, keeps unique full-path alias; all `alias[0]` unique. |
| T9 | Determinism | build twice ⇒ identical string; build from a shuffled `variants`/`assets` array ⇒ identical string (total sort). |
| T10 | Single vs multi sidecar names | feed `variantManifestName(...,multi=false)` and `(...,multi=true)` paths; builder consumes verbatim (no re-derivation). |
| T11 | Schema invariant | parsed JSON top-level is exactly `{ bundles }` (no `version`/`meta`); each asset has non-empty `alias:string[]` + `src:string[]` and **no `data` key**. |
| T12 | Empty input | `buildPixiManifest([])` → `{bundles:[{name:'default',assets:[]}]}`; document the worker's skip-on-`size===0`. |
| T13 | `hashedName` purity | `hashedName('a/b_540p.webp','a1b2c3d4')==='a/b_540p.a1b2c3d4.webp'`; no-ext path; helper shipped though unused in v1. |
| T14 | B4 src de-dup | duplicate `src` strings within an asset collapse to one candidate. |

Plus a **load-bearing-shape** assertion in T1–T7: the emitted entry is structurally a valid `PixiAssetsManifest` AND would be loadable (every `src` candidate has a known image/sheet extension).

**Additivity (no worker harness — same substitute as `export-profile-fanout.test.ts`):** the off ⇒ byte-identical claim is enforced by code structure (collector `undefined` when off; emit gated on `size>0`), documented in the test header + verified MANUALLY (footer note mirroring the fanout test): drop a folder, run with toggle OFF → zip A; run with toggle ON → zip B; B == A except for the single added `manifest.json`. Add a `buildOptions` unit assertion (if testable) that `emitPixiManifest:false` ⇒ field omitted.

---

## 11. Ordered Task Breakdown (small commits, one meaning each)

| ID | Title | Files | Deps | Acceptance |
|---|---|---|---|---|
| **C1** | Pure builder + local Pixi types | `packages/fix/src/pixi-manifest.ts` (new): `PixiAssetsManifest`/`PixiAssetsBundle`/`PixiUnresolvedAsset`, `ManifestAsset`/`EmittedVariant`/`ManifestAssetKind`, `buildPixiManifest` (group-by-suffix, alias guard, src sort, NO `data`), `hashedName`, `countPixiManifestEntries` | — | `pnpm --filter @asset-doctor/fix typecheck` green; no canvas/Date/Math.random import. |
| **C2** | Export from package index | `packages/fix/src/index.ts` (+ `export { buildPixiManifest, hashedName, countPixiManifestEntries }`, `export type` the types) | C1 | Importable as `@asset-doctor/fix`; typecheck green. |
| **C3** | Builder unit tests | `packages/fix/test/pixi-manifest.test.ts` (new) — T1–T14 | C2 | `pnpm --filter @asset-doctor/fix test` green; B1 regression (no `data.resolution`) + determinism + alias-collision + sidecar-vs-loose covered. |
| **C4** | Protocol fields | `apps/web/src/worker/fix-protocol.ts` — add `emitPixiManifest?`, `hashFilenames?` (reserved) to `FixOptions`; `pixiManifest?` to `FixReceipt` | C2 | Web typecheck green; fields documented opt-in/byte-identical-when-off. |
| **C5** | Worker collector + emit | `apps/web/src/worker/fix.worker.ts` — gated `manifestAssets` map + `recordVariant` at the verified emit sites; build+push one entry into `dedupedOut` after dedup; `pickManifestPath` collision guard; set `receipt.pixiManifest` | C2,C4 | Off: map not allocated, `dedupedOut` unchanged ⇒ zip byte-identical. On: `manifest.json` lists every recorded variant (one entry per tier, no `data`). `pnpm typecheck`+`pnpm lint` green. |
| **C6** | UI toggle | `apps/web/src/App.tsx` — `emitPixiManifest` state + checkbox in the Pro disclosure; `buildOptions` forwards `|| undefined` | C4 | Default off; `buildOptions` omits when off (byte-identical). |
| **C7** | i18n keys | `packages/i18n/src/catalogs/{en,ru,de,es,pt,fr,it,zh,hi}.json` — `fix.pixiManifest`, `fix.pixiManifestHint` | C6 | i18n drift/baked test green; all 9 catalogs carry the 2 keys; CLI unaffected. |
| **C8** | Receipt surfacing (optional) | `apps/web/src/App.tsx` receipt view — "manifest.json ({n} entries)" when `receipt.pixiManifest` present | C5,C7 | Present only when emitted; absent ⇒ no change. |

**Commit grouping (CLAUDE.md "маленькие коммиты"):** C1+C2 (pure builder), C3 (tests), C4 (protocol), C5 (worker), C6+C7 (UI+i18n), C8 (receipt). Hashing/cache-busting is a separate future RFC.

---

## Key file references (absolute) + load-bearing facts

- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/pixi-manifest.ts` — NEW pure builder.
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/scale.ts` — `tieredName:51`, `variantManifestName:193`, `formatToken:182`, `RESOLUTION_TOKEN:31` (REUSE; never re-derive names).
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/dedup-exec.ts` — `EXT:19`, `renamedTo:29` (format-rank/ext source).
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/manifest.ts` — determinism template (sorted keys `:9`, fixed order, `JSON.stringify(_,2)` `:35`, `meta.scale` `:33`, no timestamps) to mirror; **`meta.scale` is where the real per-tier atlas scale lives** (NOT the manifest).
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/index.ts` — add exports (C2).
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/test/export-profile-fanout.test.ts` — the no-worker-harness test pattern + manual-byte-identity footer to mirror.
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix.worker.ts` — verified emit sites: loose fan-out `:879`; loose single `:1169`/`:1221`; tier image `:1704`, tier manifests `:1716`/`:1725`; repack single `:1055`/`:1061`; merge `:1044`/`:1045`; spine repack `:938`/`:939`; pack `:1440`; pass-through `:1840`; dedup tail `:1846-1856`; `inputPaths` `:584`; `kindOf` `:369`; `sha256Hex` `:2138`; tier-loop scope `imagePath:1598`/`isSpine:1615`/`atlas:1616`/`manifestPath:1629`.
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix-protocol.ts` — `FixOptions` (+2 fields), `FixReceipt` (+`pixiManifest?`).
- `/home/nonamezzz/Рабочил стол/projects/apps/web/src/App.tsx` — `FixCard` state `~:982`, `buildOptions:1042`.
- `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/en.json` — flat dotted keys (131 `fix.*`), 9 catalogs.

**Load-bearing correctness facts (verified):**
1. `AssetsManifest = { bundles }` only — no `version`/`meta` (Pixi docs ×3).
2. `alias` and `src` are **string arrays**; `src` is pre-expanded format alternatives, never a brace template (AssetPack output: `{"alias":["game/char.png","game.png"],"src":["game/char.png"]}`).
3. **Pixi #10108:** the resolver's retina parser rejects non-image extensions, so `.json`/`.atlas` candidates get **no `@Nx` parsing**, and `data.resolution` is **not a documented working workaround** → **emit no `data`; express tiers as separate alias-suffixed entries; rely on the sheet's `meta.scale`** for runtime scale.
4. The worker emits `_540p`/`_540p.webp.json` tokens (NOT `@Nx`) → tiers cannot auto-resolve via a single `src` array regardless → one entry per tier is the only honest, loadable shape.
5. Key every name off the recorded **post-fallback `enc.mime`** path (record at the `out.push` site), never the requested target.
6. Off ⇒ no `dedupedOut` entry, no filename change ⇒ zip byte-identical (additivity by construction).

Sources for the Pixi verification: [AssetsManifest docs](https://pixijs.download/v8.14.2/docs/assets.AssetsManifest.html), [Manifests & Bundles guide](https://pixijs.com/8.x/guides/components/assets/manifest), [Bug #10108](https://github.com/pixijs/pixijs/issues/10108), [AssetPack Manifest pipe](https://pixijs.io/assetpack/docs/guide/pipes/manifest/), [pixijs-assets skill](https://github.com/pixijs/pixijs-skills/blob/main/skills/pixijs-assets/SKILL.md).