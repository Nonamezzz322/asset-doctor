// PURE PixiJS-v8 AssetsManifest builder (round8-pixi-manifest.md C1). NO pixels, NO canvas, NO IO, NO
// network, NO Date.now / Math.random — pure deterministic string work, so the worker (and any future
// caller) produces a BYTE-IDENTICAL manifest for the same recorded variants. Golden-testable.
//
// This module emits a REAL, loadable PixiJS v8 AssetsManifest = { bundles:[{ name, assets:[{ alias, src }] }] }
// and NOTHING else (no version/meta/schemaVersion; no `data` field). Load-bearing correctness (verified
// against the Pixi docs + AssetPack output + Pixi bug #10108):
//   - The manifest top-level is exactly `{ bundles }`.
//   - `alias` and `src` are STRING arrays; `src` is pre-expanded format alternatives, never a brace template.
//   - There is NO `data.resolution` (Pixi #10108: the resolver's retina parser rejects non-image extensions,
//     so `.json`/`.atlas` candidates get no `@Nx` parsing and `data.resolution` is NOT a documented working
//     resolver field). Multi-resolution tiers are therefore expressed as ONE alias-suffixed entry PER tier
//     (NOT a single `@Nx` src array — our suffixes are `_540p`, not `@Nx`). Runtime per-tier scale lives in
//     the sheet's own `meta.scale` (emitTexturePackerJson), which the manifest does NOT restate.
//   - For a sheet (atlas/spine) the `src` candidate is the `.json`/`.atlas` SIDECAR (Pixi reads meta.image);
//     for a loose image it is the image itself. The builder consumes the worker's RECORDED post-fallback
//     paths VERBATIM (no name re-derivation) so it can only ever reference files that were emitted.
//
// This package must not depend on `pixi.js`; the Pixi wire types below are a local mirror of its public shape.

/** AssetPack `includeFileSizes` parity (round23 #2). One `src` candidate carrying its `progressSize` (the
 *  field AssetPack 1.7.0 emits — pixiManifest.js:139-142). `progressSize` is the file's size in KB to 2
 *  decimal places (AssetPack's getFileSizeInKB divides the byte length by 1024 in BOTH branches, utils.js:24-42):
 *  `'raw'` ⇒ uncompressed KB (statBytes/1024); `'gzip'` ⇒ gzipped KB (gzipBytes/1024). PixiJS reads this to
 *  drive accurate Assets.load progress over the transport. NO other field — Pixi consumes exactly { src, progressSize }. */
export interface PixiSizedSrc {
  src: string;
  /** Size in KB, 2dp (AssetPack parity). raw ⇒ statBytes/1024; gzip ⇒ gzipBytes/1024. REAL measured bytes. */
  progressSize: number;
}

/** LOCAL mirror of PixiJS v8's UnresolvedAsset wire shape. `alias` = lookup name(s); `src` = one logical
 *  asset → MANY candidate URLs (pre-expanded format alternatives, never a brace template). Each candidate is
 *  a real emitted zip-entry path; for a sheet it is the `.json`/`.atlas` sidecar. NO `data` field (Pixi #10108).
 *  When `includeFileSizes` is on, each candidate is a `{ src, progressSize }` object instead of a bare string
 *  (AssetPack parity — pixiManifest.js:136-142); off ⇒ bare strings (byte-identical to today). */
export interface PixiUnresolvedAsset {
  alias: string[];
  src: string[] | PixiSizedSrc[];
}
export interface PixiAssetsBundle {
  name: string;
  assets: PixiUnresolvedAsset[];
}
export interface PixiAssetsManifest {
  bundles: PixiAssetsBundle[];
}

/** Classification mirroring the worker's kindOf — drives whether the recorded variant's `src` points at the
 *  IMAGE (loose) or the sidecar MANIFEST (.json/.atlas). The builder itself is kind-agnostic (it consumes the
 *  recorded `src` verbatim); the kind travels for provenance + future use. */
export type ManifestAssetKind = 'loose' | 'atlas' | 'spine';

/** One emitted variant of a logical asset — the facts the worker has at its out.push site. Names are produced
 *  by the SAME scale.ts/dedup-exec.ts helpers the worker pushed (tieredName / variantManifestName / renamedTo),
 *  so the manifest references exactly the files that exist (the builder never re-derives a name). */
export interface EmittedVariant {
  /** scale ∈ (0,1]; 1 for a non-tiered emit / top tier. Used ONLY for sort/provenance (alias suffix comes
   *  from `suffix`). */
  scale: number;
  /** Resolution-tier suffix as the worker emitted it (e.g. '_540p'); '' for a non-tiered emit. Groups
   *  variants into per-tier entries and drives the per-tier alias suffix (Pixi #10108: no auto-resolve). */
  suffix: string;
  /** The candidate URL Pixi LOADS = exact zip-entry path. For loose: the image. For atlas/spine: the
   *  .json/.atlas sidecar. Format alternatives at the SAME (scale,suffix) are separate EmittedVariants that
   *  the builder merges into one entry whose `src` lists all of them. */
  src: string;
}

/** One logical asset → its emitted variants, grouped by `ref` (the dir-aware ingest key). `source` = the
 *  original path (for the secondary basename alias). Variants at the same `suffix` but different FORMAT are
 *  merged into one manifest entry whose `src` lists all formats. */
export interface ManifestAsset {
  ref: string;
  kind: ManifestAssetKind;
  source: string;
  variants: EmittedVariant[];
}

export interface BuildPixiManifestOptions {
  bundleName?: string;
  /** AssetPack `includeFileSizes` parity (round23 #2). Absent/false ⇒ bare-string `src` (BYTE-IDENTICAL to
   *  today — no `progressSize` field anywhere). `'raw'` ⇒ each `src` becomes `{ src, progressSize }` with
   *  progressSize = uncompressed KB (statBytes/1024, 2dp). `'gzip'` ⇒ gzipped KB (gzipBytes/1024, 2dp).
   *  BOTH are KB (AssetPack's getFileSizeInKB divides by 1024 in both branches, utils.js:24-42). */
  includeFileSizes?: false | 'raw' | 'gzip';
  /** FINAL emitted byte length per `src` path: the RAW stat length for `'raw'`, the pre-gzipped length for
   *  `'gzip'`. Supplied by the worker from the POST-replace `byPath` map so pngquant/KTX2 in-place swaps are
   *  reflected honestly (never a stale lossless size). Required when `includeFileSizes` is set; ignored
   *  otherwise. A `src` missing from the map ⇒ progressSize 0 (no throw — all real entries are present). */
  srcBytes?: ReadonlyMap<string, number>;
}

/** Format rank for `src` candidate ordering within one entry. KTX2 ranks FIRST (-1) so a GPU-compressed
 *  variant is tried before the raster fallback (round12 backend-processing: the worker emits a `.ktx2`
 *  sibling KEPT alongside the raster page, and the manifest must list it `ktx2-first` so a capable GPU
 *  loads the compressed tier — Pixi's resolver tries `src` candidates in order, falling back on decode
 *  failure). Then AVIF (most-preferred raster), …, PNG last (the universal safe fallback). Unknown
 *  extensions sort after known ones, ties broken by localeCompare. Mirrors dedup-exec EXT's set. */
const FORMAT_RANK: Readonly<Record<string, number>> = {
  '.ktx2': -1,
  '.avif': 0,
  '.webp': 1,
  '.png': 2,
  '.jpg': 3,
  '.jpeg': 3,
};

/** Lowercased final extension (including the dot), '' if none. Pure string math. */
function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot < 0 || dot < slash ? '' : path.slice(dot).toLowerCase();
}

/** Strip the final extension from a path (dir-aware): 'ui/hud.json' → 'ui/hud', 'btn' → 'btn'. Pure. */
function stemOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot < 0 || dot < slash ? path : path.slice(0, dot);
}

/** Basename (final path segment): 'ui/hud.json' → 'hud.json'. Pure. */
function baseOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

/** Compound KTX2 atlas sidecar (`<page>.ktx2.json`, round8 two-sidecar rule): a `.json` whose meta.image
 *  points at the GPU-compressed `.ktx2` page. extOf() only sees the final `.json`, so this is detected by the
 *  inner `.ktx2.` token. Pure string test (dir-aware via baseOf so a directory dot can't false-positive). */
function isKtx2Sidecar(path: string): boolean {
  return /\.ktx2\.json$/i.test(baseOf(path));
}

/** Candidate rank for `src` ordering within ONE entry. KTX2 candidates sort FIRST (ktx2-first) so a capable
 *  GPU loads the compressed tier before the raster fallback:
 *    - a LOOSE `.ktx2` image  → FORMAT_RANK['.ktx2'] = -1 (handled by extOf).
 *    - an ATLAS `.ktx2.json` sidecar → its final ext is `.json` (rank 99 with the raster `.json`), so it is
 *      special-cased to the SAME -1 rank ahead of the plain raster sidecar.
 *  Everything else falls back to FORMAT_RANK (avif<webp<png<jpg) then localeCompare. */
function rankOf(path: string): number {
  if (isKtx2Sidecar(path)) return -1; // ktx2-first ahead of the raster .json sidecar
  return FORMAT_RANK[extOf(path)] ?? 99;
}

/** Deterministic `src` ordering within ONE entry: candidate rank (ktx2<avif<webp<png<jpg), ties by codepoint
 *  sort. All candidates in one entry share a (scale,suffix) tier, so only the format axis varies. */
function compareSrc(a: string, b: string): number {
  return rankOf(a) - rankOf(b) || a.localeCompare(b);
}

/**
 * Build a deterministic PixiJS-v8 AssetsManifest STRING. PURE: no Date.now/Math.random; JSON.stringify(_, 2)
 * with a fixed key order ({ name, assets } per bundle; { alias, src } per asset) mirroring
 * emitTexturePackerJson's determinism. Output is INSERTION-ORDER-INDEPENDENT (a total re-sort), so the same
 * recorded variants in any order yield byte-identical JSON.
 *
 * Algorithm:
 *  1. bundleName = opts?.bundleName ?? 'default'.
 *  2. Group each asset's variants by `suffix` (the resolution-tier key) → ONE entry per tier (Pixi #10108:
 *     no auto-resolve via a single src array). Variants sharing a suffix but differing in format are the
 *     `src` candidates of that one entry (sorted §compareSrc, de-duped defensively).
 *  3. alias base = stemOf(ref) (full dir-aware path, no ext) + secondary basenameNoExt. When the asset has
 *     >1 distinct suffix (a real tier ladder) the suffix is appended to BOTH aliases so each tier is a
 *     distinct, collision-free lookup key. A single-suffix asset (the common case) appends nothing.
 *  4. Bundle-wide alias-collision guard: the full-path alias is unique by construction; if a BASENAME alias
 *     repeats across the bundle, drop the basename alias for the later entry (keep only the unique full-path).
 *  5. Entries sorted by alias[0] (localeCompare, matching manifest.ts). NO `data` field anywhere.
 */
export function buildPixiManifest(assets: ManifestAsset[], opts?: BuildPixiManifestOptions): string {
  const bundleName = opts?.bundleName ?? 'default';

  // Build the raw entries (alias candidates + sorted src) first; the alias-collision guard runs as a second
  // pass over the SORTED entries so the "later entry drops its basename" rule is deterministic.
  interface RawEntry {
    fullAlias: string;
    baseAlias: string;
    src: string[] | PixiSizedSrc[];
  }
  const raw: RawEntry[] = [];

  // AssetPack getFileSizeInKB parity (utils.js:24-42): BOTH 'raw' and 'gzip' divide the byte length by 1024
  // and round to 2dp. Pure math (no Date.now/Math.random) ⇒ determinism preserved. 'raw' is uncompressed KB,
  // 'gzip' is gzipped KB — the byte source per mode is the worker-supplied `srcBytes` (final shipped bytes).
  const kbOf = (b: number): number => Number((b / 1024).toFixed(2));

  for (const asset of assets) {
    // Group this asset's variants by suffix (the tier key).
    const bySuffix = new Map<string, EmittedVariant[]>();
    for (const v of asset.variants) {
      const g = bySuffix.get(v.suffix);
      if (g) g.push(v);
      else bySuffix.set(v.suffix, [v]);
    }
    const multiTier = bySuffix.size > 1;

    const fullStem = stemOf(asset.ref);
    const baseStem = stemOf(baseOf(asset.ref));

    for (const [suffix, variants] of bySuffix) {
      // Append the tier suffix to the aliases ONLY when this asset spans multiple tiers (a real ladder), so
      // single-tier assets keep clean aliases (['ui/hud','hud']) and tiered assets stay distinct keys.
      const tierTag = multiTier ? suffix : '';
      const fullAlias = `${fullStem}${tierTag}`;
      const baseAlias = `${baseStem}${tierTag}`;
      // src = this tier's format candidates, sorted + de-duped (defensive against same-mime fallback dupes).
      const sortedSrcs = [...new Set(variants.map((v) => v.src))].sort(compareSrc);
      // includeFileSizes off/absent ⇒ bare strings (today's exact code path ⇒ byte-identical). On ⇒ each
      // candidate carries its REAL measured progressSize (KB) from the worker-supplied final byte map.
      const src: string[] | PixiSizedSrc[] = opts?.includeFileSizes
        ? sortedSrcs.map((s) => ({ src: s, progressSize: kbOf(opts.srcBytes?.get(s) ?? 0) }))
        : sortedSrcs;
      raw.push({ fullAlias, baseAlias, src });
    }
  }

  // Sort entries by the primary (full-path) alias — codepoint localeCompare, matching manifest.ts.
  raw.sort((a, b) => a.fullAlias.localeCompare(b.fullAlias));

  // Alias-collision guard: full-path alias is unique by construction; drop a basename alias that already
  // appeared earlier in the (now sorted) bundle so two entries never share a shortcut.
  const seenBase = new Set<string>();
  const entries: PixiUnresolvedAsset[] = raw.map((e) => {
    const alias = [e.fullAlias];
    if (e.baseAlias !== e.fullAlias && !seenBase.has(e.baseAlias)) {
      alias.push(e.baseAlias);
      seenBase.add(e.baseAlias);
    }
    return { alias, src: e.src };
  });

  const manifest: PixiAssetsManifest = { bundles: [{ name: bundleName, assets: entries }] };
  return JSON.stringify(manifest, null, 2);
}

/** Count the logical entries the manifest would carry for these recorded assets — the SAME group-by-suffix
 *  count buildPixiManifest emits, WITHOUT parsing the string (used by the worker for receipt.pixiManifest.assets).
 *  PURE. */
export function countPixiManifestEntries(assets: ManifestAsset[]): number {
  let n = 0;
  for (const asset of assets) {
    const suffixes = new Set<string>();
    for (const v of asset.variants) suffixes.add(v.suffix);
    n += suffixes.size;
  }
  return n;
}

/**
 * Insert a short content hash before the FINAL extension of a path. PURE string helper — the naming primitive
 * of content-hash cache-busting (docs/improvements/round9-cache-busting.md), wired by the worker's
 * `hashFilenames` option. Preserves the directory and any compound token (e.g. '_540p'):
 *   hashedName('a/b_540p.webp', 'a1b2c3d4') === 'a/b_540p.a1b2c3d4.webp'
 *   hashedName('noext', 'deadbeef')         === 'noext.deadbeef'   (no extension ⇒ append)
 */
export function hashedName(path: string, hash: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot < 0 || dot < slash) return `${path}.${hash}`;
  return `${path.slice(0, dot)}.${hash}${path.slice(dot)}`;
}
