// Whole-folder (cross-asset) rules. These look at the folder as a unit — duplicates, loose
// sprites that should be atlased, under-filled atlases that could merge, integrity, and the
// aggregate transcode win. All folder findings carry scope: 'folder' and relatedRefs.

import type { Asset, AssetMetrics, Atlas, Finding, ImageAsset, ImageFeatures, Rect, ThresholdConfig } from '@asset-doctor/core';
import { fmtBytes, occupancyValue, vramBytes } from './rules';
import { buildCoverage, defaultCell, mergeEmptyRects, summarizeEmpty } from './grid';
import { groupVariants } from './variants';

/** Pure dispersion of one atlas's empty space: { frag, largestPct } over the grid-merged empty rects.
 *  Defaults to frag = 1 (contiguous) / largestPct = wasted-fraction when no empty rects map (B1) —
 *  never an undefined that would render as an empty interpolation. SHAPE of waste, not a savings claim. */
function atlasDispersion(atlas: Atlas): { frag: number; largestPct: number } {
  const atlasPx = atlas.size.w * atlas.size.h;
  const rects = mergeEmptyRects(buildCoverage(atlas, defaultCell(atlas.size)), atlas.size);
  const empty = summarizeEmpty(rects);
  if (empty.fragmentation === undefined || atlasPx <= 0) {
    return { frag: 1, largestPct: Math.max(0, 1 - occupancyValue(atlas)) };
  }
  return { frag: empty.fragmentation, largestPct: empty.largestArea / atlasPx };
}

function imageByRef(assets: Asset[]): Map<string, ImageAsset> {
  const m = new Map<string, ImageAsset>();
  for (const a of assets) m.set(a.kind === 'atlas' ? a.atlas.name : a.image.name, a.image);
  return m;
}

/** Hamming distance between two 64-bit hashes given as 16-hex-char strings. */
function hamming(a: string, b: string): number {
  let dist = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = (parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16)) & 0xf;
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

export function duplicateExactFindings(assets: Asset[], features: ImageFeatures[]): Finding[] {
  const imgs = imageByRef(assets);
  const groups = new Map<string, string[]>();
  for (const f of features) {
    const g = groups.get(f.contentHash) ?? [];
    g.push(f.assetRef);
    groups.set(f.contentHash, g);
  }
  const out: Finding[] = [];
  for (const [hash, refs] of groups) {
    if (refs.length < 2) continue;
    refs.sort();
    const img = imgs.get(refs[0]!);
    const perDisk = img?.byteSize ?? 0;
    const perVram = img ? vramBytes(img.size) : 0;
    out.push({
      id: `dup-exact:${hash.slice(0, 10)}`,
      rule: 'duplicate-exact',
      severity: 'warn',
      scope: 'folder',
      assetRef: refs[0]!,
      relatedRefs: refs,
      title: `${refs.length}× identical file`,
      detail:
        `Byte-identical copies: ${refs.join(', ')}. Keep one and reference it — each copy the ` +
        `game actually loads is a separate texture upload (${fmtBytes(perVram)} VRAM each).`,
      fix: 'De-duplicate: keep a single copy and update references.',
      estimate: {
        diskBytesSaved: perDisk * (refs.length - 1),
        vramBytesSaved: perVram * (refs.length - 1),
      },
      messageKey: 'duplicate-exact',
      params: { n: refs.length, refs: refs.join(', '), vram: perVram },
    });
  }
  return out;
}

export function duplicateSimilarFindings(features: ImageFeatures[], cfg: ThresholdConfig): Finding[] {
  const feats = features.filter((f) => f.dHash);
  const used = new Set<number>();
  const out: Finding[] = [];
  // dHash is luma-sign-only ⇒ color-blind; a hue-swapped shape twin (recolored symbol set) must not read
  // as a near-dupe. Pairs whose alpha-weighted 9×8 mean color differs by more than maxMeanColorDelta on
  // any channel are refused. Self-skips when either side lacks meanColor (CLI/headless, legacy features).
  const maxDelta = cfg.duplicates.maxMeanColorDelta ?? Infinity;
  const colorCompatible = (a: ImageFeatures, b: ImageFeatures): boolean => {
    if (!a.meanColor || !b.meanColor) return true; // legacy features (CLI, old fixtures) — guard self-skips
    return (
      Math.max(
        Math.abs(a.meanColor.r - b.meanColor.r),
        Math.abs(a.meanColor.g - b.meanColor.g),
        Math.abs(a.meanColor.b - b.meanColor.b),
      ) <= maxDelta
    );
  };
  for (let i = 0; i < feats.length; i++) {
    if (used.has(i)) continue;
    const group = [i];
    for (let j = i + 1; j < feats.length; j++) {
      if (used.has(j)) continue;
      if (
        hamming(feats[i]!.dHash!, feats[j]!.dHash!) <= cfg.duplicates.similarHammingMax &&
        colorCompatible(feats[i]!, feats[j]!)
      )
        group.push(j);
    }
    if (group.length < 2) continue;
    group.forEach((k) => used.add(k));
    // all byte-identical → that's duplicate-exact's job; only report genuinely *similar* sets here
    if (new Set(group.map((k) => feats[k]!.contentHash)).size <= 1) continue;
    const refs = group.map((k) => feats[k]!.assetRef).sort();
    out.push({
      id: `dup-similar:${refs[0]}`,
      rule: 'duplicate-similar',
      severity: 'info',
      scope: 'folder',
      assetRef: refs[0]!,
      relatedRefs: refs,
      title: `${refs.length} near-identical images`,
      detail:
        `Perceptually near-identical (dHash ≤ ${cfg.duplicates.similarHammingMax} bits): ` +
        `${refs.join(', ')}. Likely re-exports or near-dupes — consider reusing one.`,
      fix: 'Review for reuse / de-duplication.',
      messageKey: 'duplicate-similar',
      params: { n: refs.length, bits: cfg.duplicates.similarHammingMax, refs: refs.join(', ') },
    });
  }
  return out;
}

export function shouldAtlasFinding(assets: Asset[], cfg: ThresholdConfig): Finding | null {
  const small = assets.filter(
    (a) => a.kind === 'image' && Math.max(a.image.size.w, a.image.size.h) <= cfg.shouldAtlas.maxSpriteEdgePx,
  );
  // RAW early-out FIRST: logical ≤ raw always, so a raw count below the floor guarantees the logical
  // count is too — this avoids the groupVariants pass on folders that can't possibly fire.
  if (small.length < cfg.shouldAtlas.minLooseImages) return null;
  // Count LOGICAL loose images, not raw variant files. A logical image shipped as png/webp/avif ×
  // resolution tiers is one runtime texture bind + draw call (ONE variant loads per asset), not up to
  // ~9. `groupVariants` clusters exactly those siblings (the same deterministic, worker-safe clustering
  // the `variants` rule ships); `logicalImages` = its bucket count ≤ small.length ALWAYS. Gate & report
  // on this honest count → pure false-positive reduction (a partition can only merge, never split).
  const logical = groupVariants(small).logicalImages;
  if (logical < cfg.shouldAtlas.minLooseImages) return null;
  // relatedRefs stays every raw loose file: it is the fold/highlight set (web loose-fold + domination
  // gate key off it) and the fix engine's disk-op set — deliberately distinct from the runtime `n`.
  const refs = small.map((a) => a.image.name).sort();
  return {
    id: 'folder:should-atlas',
    rule: 'should-atlas',
    severity: 'warn',
    scope: 'folder',
    assetRef: refs[0]!,
    relatedRefs: refs,
    title: `${logical} loose sprites — pack into an atlas`,
    detail:
      `${logical} standalone images (≤${cfg.shouldAtlas.maxSpriteEdgePx}px). Each is its own ` +
      `texture bind + draw call at runtime; packing them into one atlas batches the draws.`,
    fix: 'Pack loose sprites into a TexturePacker / Pixi atlas.',
    messageKey: 'should-atlas',
    params: { n: logical, edge: cfg.shouldAtlas.maxSpriteEdgePx },
  };
}

export function atlasMergeFinding(atlases: Atlas[], cfg: ThresholdConfig): Finding | null {
  const under = atlases.filter((a) => occupancyValue(a) < cfg.atlasMerge.occupancyBelow);
  if (under.length < cfg.atlasMerge.minAtlases) return null;
  const usedArea = under.reduce(
    (s, a) => s + a.sprites.reduce((t, sp) => t + sp.frame.w * sp.frame.h, 0),
    0,
  );
  const maxDim = Math.max(...under.map((a) => Math.max(a.size.w, a.size.h)));
  const capacity = maxDim * maxDim;
  // Usable px per merged sheet = capacity discounted by the realistic packing density. A naive
  // usedArea/capacity assumes a perfect 100% pack, making vramBytesSaved an UPPER bound (over-claim,
  // invariant 3/5). Dividing by packEfficiency<1 can only RAISE minAtlases ⇒ raise mergedVram ⇒ shrink
  // the claimed saving — the conservative direction (a true lower bound, not the best case).
  const usable = capacity * cfg.atlasMerge.packEfficiency;
  const minAtlases = Math.max(1, Math.ceil(usedArea / usable));
  if (minAtlases >= under.length) return null; // no clear win
  const refs = under.map((a) => a.name).sort();
  const currentVram = under.reduce((s, a) => s + vramBytes(a.size), 0);
  const mergedVram = minAtlases * capacity * 4;
  // F5: dispersion of the under-filled set = the MOST-shredded atlas (min frag). Default frag=1 when
  // no atlas has mappable empty rects (B1) — never an empty interpolation; SHAPE, not savings (M1). The
  // caveat is dispersion-AWARE (not a categorical "scattered" claim): the recommendation scales with the
  // measured dispersion, so it reads truthfully at any frag — high frag (one contiguous hole) and low
  // frag (shredded) alike. Mirrors the occupancy clause and the en catalog template EXACTLY (the
  // renderFinding drift guard requires byte parity between baked + en).
  const disp = under
    .map(atlasDispersion)
    .reduce((min, d) => (d.frag < min.frag ? d : min), { frag: 1, largestPct: 0 });
  const lp = Math.round(disp.largestPct * 1000) / 10;
  const fr = Math.round(disp.frag * 1000) / 10;
  // VRAM-DELTA SIGN GUARD (invariant 3/5). The merged sheet is modelled as a SQUARE at maxDim — a
  // deliberately crude, conservative footprint. On a heterogeneous under-filled set whose largest atlas
  // is a WIDE (non-square) sheet, that square-at-maxDim model over-allocates so badly that the MODELLED
  // merged footprint exceeds the current one (vramSaved <= 0) — even though a real tight repack (what the
  // Pro fix's pass-0 MaxRects POT repack over relatedRefs actually does) would usually SHRINK VRAM. So
  // the model cannot QUANTIFY the VRAM change here: it cannot prove a positive delta, and is far too
  // crude to prove a negative one either. The sheet-count guard (line 165) still passed — the BATCHING
  // win (fewer binds + draw calls) is real and certain. So branch on the SIGN of the measured delta:
  // only when vramSaved > 0 do we keep the VRAM clause + the `vramBytesSaved` estimate (a true lower
  // bound); otherwise we emit a batching-only variant (distinct messageKey, NO estimate — mirrors the
  // estimate-less `should-atlas`) whose prose states the VRAM change is UNQUANTIFIED here — NOT that
  // there is none (that false certainty is contradicted by our own tight-repack fix). We SUPPRESS a
  // number the model cannot defend; we never invent one, and never assert a negative we cannot prove.
  // `rule`/`severity`/`title`/`fix`/`params` are identical in both branches — only detail, estimate-
  // presence and messageKey differ.
  const vramSaved = currentVram - mergedVram;
  const savesVram = vramSaved > 0;
  const detailPrefix =
    `${refs.join(', ')} are each under ${Math.round(cfg.atlasMerge.occupancyBelow * 100)}% full. ` +
    `Their content fits in ~${minAtlases} sheet${minAtlases === 1 ? '' : 's'} — merging cuts `;
  const detailSuffix =
    `Largest contiguous empty hole is ${lp}% of its sheet (dispersion ${fr}%); ` +
    `the lower the dispersion, the more a full repack — not a trim — is needed.`;
  const detail = savesVram
    ? detailPrefix + `texture binds, draw calls and VRAM. ` + detailSuffix
    : detailPrefix +
      `texture binds and draw calls. A VRAM change can't be quantified from these sheet sizes ` +
      `alone, so the guaranteed win here is fewer draws — a tight repack may also cut GPU memory. ` +
      detailSuffix;
  return {
    id: 'folder:atlas-merge',
    rule: 'atlas-merge',
    severity: 'warn',
    scope: 'folder',
    assetRef: refs[0]!,
    relatedRefs: refs,
    title: `${under.length} under-filled atlases → merge into ~${minAtlases}`,
    detail,
    fix: 'Re-pack these atlases together.',
    ...(savesVram ? { estimate: { vramBytesSaved: vramSaved } } : {}),
    messageKey: savesVram ? 'atlas-merge' : 'atlas-merge-batching',
    params: { n: under.length, merged: minAtlases, refs: refs.join(', '), pct: Math.round(cfg.atlasMerge.occupancyBelow * 100), frag: disp.frag, largestPct: disp.largestPct },
  };
}

export function integrityFindings(missing: { manifest: string; image: string }[]): Finding[] {
  return missing.map((m) => ({
    id: `integrity:${m.manifest}`,
    rule: 'integrity-missing-image',
    severity: 'crit',
    scope: 'folder',
    assetRef: m.manifest,
    relatedRefs: [m.manifest, m.image],
    title: `Missing atlas image: ${m.image}`,
    detail: `Manifest ${m.manifest} references "${m.image}", which is not in the folder — the atlas can't load.`,
    fix: 'Add the missing image or fix the manifest path.',
    messageKey: 'integrity',
    params: { image: m.image, manifest: m.manifest },
  }));
}

export function formatAggregateFinding(formatFindings: Finding[]): Finding | null {
  if (formatFindings.length < 2) return null;
  const totalSaved = formatFindings.reduce((s, f) => s + (f.estimate?.diskBytesSaved ?? 0), 0);
  if (totalSaved <= 0) return null;
  const refs = formatFindings.map((f) => f.assetRef).sort();
  return {
    id: 'folder:format-aggregate',
    rule: 'format',
    severity: 'warn',
    scope: 'folder',
    assetRef: refs[0]!,
    relatedRefs: refs,
    title: `${formatFindings.length} images could shrink — ${fmtBytes(totalSaved)} total`,
    detail: `Transcoding ${formatFindings.length} images to AVIF/WebP saves ~${fmtBytes(totalSaved)} of download across the folder. Sum of per-image Canvas estimates; lossless parity needs wasm codecs.`,
    fix: 'Batch-transcode to AVIF/WebP for delivery.',
    estimate: { diskBytesSaved: totalSaved },
    messageKey: 'format-aggregate',
    params: { n: formatFindings.length, saved: totalSaved },
  };
}

/** Folder rollup of the per-asset strippable-metadata findings — pattern-identical to
 *  `formatAggregateFinding`. Fires only with ≥2 findings; sums their EXACT `diskBytesSaved`; null when ≤0.
 *  DISPLAY-ONLY: like format-aggregate, it is NOT folded into the aggregate `potentialDiskSaved` (the
 *  per-asset findings already bumped it via the MAX-de-overlap helper in analyze.ts). DISK/DOWNLOAD only
 *  (invariant 5) — the GPU still decodes to RGBA8888. Deterministic: relatedRefs sorted. */
export function strippableMetadataAggregateFinding(metaFindings: Finding[]): Finding | null {
  if (metaFindings.length < 2) return null;
  const totalSaved = metaFindings.reduce((s, f) => s + (f.estimate?.diskBytesSaved ?? 0), 0);
  if (totalSaved <= 0) return null;
  const refs = metaFindings.map((f) => f.assetRef).sort();
  return {
    id: 'folder:strippable-metadata-aggregate',
    rule: 'strippable-metadata',
    severity: 'warn',
    scope: 'folder',
    assetRef: refs[0]!,
    relatedRefs: refs,
    title: `${metaFindings.length} images carry strippable metadata — ${fmtBytes(totalSaved)} total`,
    detail: `Stripping ancillary metadata (ICC/EXIF/XMP + non-essential chunks) from ${metaFindings.length} images cuts ~${fmtBytes(totalSaved)} of download across the folder. DISK only — VRAM is unchanged.`,
    fix: 'Batch-strip metadata on export (oxipng / re-encode).',
    estimate: { diskBytesSaved: totalSaved },
    messageKey: 'strippable-metadata-aggregate',
    params: { n: metaFindings.length, saved: totalSaved },
  };
}

/** Prose preview of a folder-wide ref list. The two disclosures below can legitimately match MOST of a
 *  folder (corpus: 387/414 misaligned textures), and joining every name into the detail/params string made
 *  the finding unreadable. The FULL sorted membership always rides `relatedRefs` (the UI's source of truth);
 *  the prose lists the first few + a locale-neutral `… (+N)` count. Display-only — nothing is dropped. */
const REFS_PREVIEW_MAX = 10;
function refsPreview(refs: string[]): string {
  if (refs.length <= REFS_PREVIEW_MAX) return refs.join(', ');
  return refs.slice(0, REFS_PREVIEW_MAX).join(', ') + ` … (+${refs.length - REFS_PREVIEW_MAX})`;
}

/** Folder-scope premultiplied-shaped-edges DISCLOSURE. The host (worker) measured each LOOSE alpha-bearing
 *  image's soft-edge shape off the SAME full-res buffer as the opaque scan (`ImageFeatures.premultipliedEdge`:
 *  edgePixels = true anti-aliasing transition pixels, fringeFrac = the fraction whose IMPLIED MATTE luma
 *  collapses toward black instead of holding the opaque colour). A loose image is FLAGGED when it clears BOTH
 *  `minEdgePixels` and `fringeFrac`; the ONE folder finding fires at ≥ `minSprites` flagged images (precedent:
 *  format-aggregate / duplicate-exact — one finding per folder, relatedRefs list the members).
 *  HONESTY (invariant 3) — a CONDITIONAL disclosure, never a defect verdict: a premultiplied export and
 *  straight art composited onto black are BYTE-IDENTICAL buffers, so the pixels can NEVER reveal the loader's
 *  blend mode. Severity is ALWAYS `info`; there is NO estimate at all (no disk, no VRAM — precedent: bleeding,
 *  icc-non-srgb); the copy asserts only the MEASURED shape and CONDITIONS the halo on the loader's setting.
 *  LOOSE-only: an atlas page's packed collage mixes many sprites' edges, so a page-level fraction would be
 *  meaningless (mirrors the solid/opaque loose-only gating); features keyed to atlas refs are skipped.
 *  Returns null with no config, no qualifying features, or below `minSprites`. Deterministic: refs sorted
 *  (codepoint, mirrors duplicateExactFindings); assetRef = first flagged ref. */
export function premultipliedAlphaFinding(
  assets: Asset[],
  features: ImageFeatures[],
  cfg: ThresholdConfig,
): Finding | null {
  const gate = cfg.premultipliedAlpha;
  if (!gate) return null;
  const loose = new Set<string>();
  for (const a of assets) if (a.kind === 'image') loose.add(a.image.name);
  const flagged: string[] = [];
  for (const f of features) {
    const pe = f.premultipliedEdge;
    if (!pe) continue; // absent (no host scan / CLI-headless / zero qualifying pixels) ⇒ never counted
    if (!loose.has(f.assetRef)) continue; // ATLAS pages never count (loose-only)
    if (pe.edgePixels < gate.minEdgePixels) continue; // too few transition pixels to classify honestly
    if (pe.fringeFrac < gate.fringeFrac) continue; // edges hold the opaque colour — straight-alpha shape
    flagged.push(f.assetRef);
  }
  if (flagged.length < gate.minSprites) return null;
  flagged.sort();
  return {
    id: 'folder:premultiplied-alpha',
    rule: 'premultiplied-alpha',
    severity: 'info', // ALWAYS info — a conditional disclosure, not a proven defect (invariant 3)
    scope: 'folder',
    assetRef: flagged[0]!,
    relatedRefs: flagged,
    title: `${flagged.length} sprites with premultiplied-shaped edges — halo risk`,
    detail:
      `Premultiplied-shaped edges: ${refsPreview(flagged)}. At their soft edges the stored RGB collapses ` +
      `toward black as alpha falls, instead of holding the opaque colour. IF your loader blends these as ` +
      `straight (un-premultiplied) alpha they will show a dark halo; if it treats them as premultiplied ` +
      `they are fine. We measure the pixels, not your blend mode.`,
    fix: 'Verify your texture premultiply/alphaMode setting matches how the art was exported, or re-export with matching alpha association.',
    // NO estimate field AT ALL (no diskBytesSaved, no vramBytesSaved) — precedent: bleeding, icc-non-srgb.
    messageKey: 'premultiplied-alpha',
    params: { n: flagged.length, refs: refsPreview(flagged) },
  };
}

/** Folder-scope GPU block-compression ALIGNMENT disclosure. Block-compressed GPU formats (the KTX2 →
 *  BC/ASTC transcode targets the shipped opt-in KTX2 backend produces) work on 4×4-pixel blocks; a texture
 *  whose width OR height is not a multiple of 4 cannot map cleanly onto them — on BC-class targets the
 *  runtime transcoder must pad or fall back, and WebGL compressedTexImage2D for S3TC-class formats requires
 *  %4 dimensions on full-size levels. HEADER-ONLY: the check reads the parsed pixel size (zero decode, zero
 *  features) for BOTH loose images and atlas PAGE images (block compression applies to any texture).
 *  HONESTY (invariant 3): we state the ALIGNMENT FACT only — never "cannot be compressed" (UASTC/KTX2
 *  containers tolerate arbitrary sizes via internal padding), never a VRAM number (the transcode target
 *  varies per device; the on-device KTX2 probe MEASURES the real footprint, we never predict it), never a
 *  disk claim. Severity is ALWAYS `info`; there is NO estimate at all (precedent: bleeding, icc-non-srgb,
 *  premultiplied-alpha). One finding per folder at ≥ `minTextures` misaligned textures (one odd size is
 *  usually deliberate; several suggest the pipeline never considered block alignment). Returns null with no
 *  config or below the gate. Deterministic: refs sorted (codepoint); assetRef = first. Browser-only by
 *  resolveThresholds omission (the CLI resolves without the key ⇒ byte-identical output there). */
export function gpuCompressionAlignmentFinding(assets: Asset[], cfg: ThresholdConfig): Finding | null {
  const gate = cfg.gpuCompression;
  if (!gate) return null;
  const misaligned: string[] = [];
  for (const a of assets) {
    const image = a.kind === 'image' ? a.image : a.kind === 'atlas' ? a.image : null;
    if (!image) continue;
    if (image.size.w % 4 !== 0 || image.size.h % 4 !== 0) misaligned.push(image.name);
  }
  if (misaligned.length < gate.minTextures) return null;
  misaligned.sort();
  return {
    id: 'folder:gpu-compression-alignment',
    rule: 'gpu-compression-alignment',
    severity: 'info', // ALWAYS info — an alignment disclosure, never a predicted saving (invariant 3)
    scope: 'folder',
    assetRef: misaligned[0]!,
    relatedRefs: misaligned,
    title: `${misaligned.length} textures not 4px-aligned — GPU block-compression needs padding`,
    detail:
      `Not 4px-aligned: ${refsPreview(misaligned)}. Block-compressed GPU formats (the KTX2 → BC/ASTC ` +
      `transcode path) work on 4×4 blocks; on these sizes the transcoder must pad or fall back on some ` +
      `targets, losing part of the benefit. We state the alignment fact only — the on-device KTX2 probe ` +
      `measures the real footprint, we never predict it.`,
    fix: 'Export block-compression candidates at multiples of 4 (ideally POT); then the opt-in KTX2 backend can encode them cleanly.',
    // NO estimate field AT ALL — the transcode target varies per device; predicting VRAM would be a lie.
    messageKey: 'gpu-compression-alignment',
    params: { n: misaligned.length, refs: refsPreview(misaligned) },
  };
}

/** Aggregate, CONDITIONAL mipmap-cost finding. Sums the per-asset "if mipmapped" overhead
 *  (vramBytesMipmapped − vramBytes) and fires a single `info` folder finding only when that total
 *  exceeds cfg.mipmap.warn. States a CEILING ("if mipmaps are enabled"), never asserts residency —
 *  static analysis cannot observe generateMipmap, so this discloses a real GPU cost class honestly
 *  without claiming it's paid. Returns null below the gate (quiet for small / UI-only sets). */
export function mipmapCostFinding(metrics: AssetMetrics[], cfg: ThresholdConfig): Finding | null {
  if (!cfg.mipmap) return null;
  let base = 0;
  let mip = 0;
  let n = 0;
  const refs: string[] = [];
  for (const m of metrics) {
    const over = m.vramBytesMipmapped - m.vramBytes;
    if (over <= 0) continue;
    base += m.vramBytes;
    mip += m.vramBytesMipmapped;
    n++;
    refs.push(m.assetRef);
  }
  const overhead = mip - base;
  if (overhead <= cfg.mipmap.warn) return null;
  refs.sort();
  return {
    id: 'folder:mipmap-cost',
    rule: 'mipmap-cost',
    severity: 'info',
    scope: 'folder',
    assetRef: refs[0]!,
    relatedRefs: refs,
    title: `Mipmaps would add ${fmtBytes(overhead)} VRAM (+33%) if enabled`,
    detail:
      `If mipmaps are on (Pixi/Phaser autoGenerateMipmaps), ${n} textures grow from ${fmtBytes(base)} ` +
      `to ${fmtBytes(mip)} — a ${fmtBytes(overhead)} GPU cost the disk size doesn't show. ` +
      `Disabled mipmaps cost nothing here.`,
    fix: 'Leave mipmaps off for UI/atlas textures never minified; budget the +33% only where you enable them.',
    messageKey: 'mipmap',
    params: { n, base, mip, overhead },
  };
}

/** Folder-scope CROSS-ATLAS duplicate-frame detector — the folder sibling of `frameRedundancyFinding`
 *  (rules.ts). The host hashes each sprite's PIXEL REGION off the already-decoded page (`frameHashByRef`,
 *  per-atlas, index-aligned to `atlas.sprites`; `null` = host-skipped flat region / read failure, never
 *  clustered) — the SAME hashes the within-atlas rule consumes per-atlas. This rule clusters those region
 *  hashes ACROSS ALL atlases and fires ONLY when a cluster spans ≥2 DISTINCT atlases (single-atlas clusters
 *  belong to `frameRedundancyFinding` — no double-report). We MEASURE the cross-sheet duplicate set and report:
 *    • VRAM — the recoverable distinct-rect area × 4 (the atlas px the cross-sheet copies pin; a merged,
 *      de-duplicated repack that references ONE shared copy reclaims it). EXACT area arithmetic, identical
 *      precedent to rules.ts `frameRedundancyFinding` — NO POT-tier bin gate, NO packer, NO inline sizer, so
 *      it CANNOT over-claim (a real MaxRects pack of the merged set lands on a LARGER bin than any area floor;
 *      claiming a bin-tier delta would assert a saving no real merge delivers, invariant 5).
 *    • DISK — an AREA-PROPORTIONAL ESTIMATE only (no per-region disk bytes exist), attributed to each freed
 *      copy's OWN atlas: byteSize[member.atlas] × memberRectArea / Σ(that atlas's frame areas). Guarded per
 *      atlas (Σ > 0 + byteSize present, else that copy's disk is skipped). Carried in the finding only, NEVER
 *      folded into the aggregate potentialDiskSaved (invariant 5: VRAM and disk are distinct quantities).
 *  GATE: `cfg.crossAtlasRedundancy.minDuplicates` counts the DISTINCT SHEETS the frame recurs on (≥2 ⇒ on ≥2
 *  sheets), NOT clusters and NOT packed rects. DISTINCT-UNIT GUARD (invariant 3, honesty): each atlas
 *  contributes EXACTLY ONE representative unit per cluster — an atlas's OWN intra-atlas dupes of the frame
 *  (whether pre-aliased onto one rect or packed at several distinct rects) are frameRedundancy's per-rect
 *  reclaim (rules.ts), so counting them here would double-claim the same pixels. ORTHOGONAL to
 *  `atlasMergeFinding`: atlas-merge reclaims EMPTY sheet space; this reclaims DUPLICATE-FRAME px — different
 *  pixels, additive reclaimable areas, NOT the same win. And ORTHOGONAL to `frameRedundancyFinding`: that
 *  rule owns intra-atlas dupes (per-rect, within one sheet), this one owns the cross-sheet copies (one per
 *  distinct atlas) — the two findings PARTITION the duplicate set with zero overlap. HONESTY PIN: `dupes` =
 *  Σ(distinct-atlases − 1) per cluster = exactly the `framesAliased` a future cross-atlas FIX would report
 *  (aliasing one shared copy across the distinct sheets; this is DIAGNOSIS-ONLY — we generate nothing,
 *  invariant 3). Returns null with no config, with <2 atlases carrying hashes, when no cluster spans ≥2
 *  atlases, or when no cluster reaches the gate. Deterministic: clusters processed by lowest
 *  (atlasName, spriteIndex); all output ref/atlas lists sorted; pure integer math (no Date/random). */
export function crossAtlasRedundancyFinding(
  atlases: Atlas[],
  frameHashByRef: Map<string, (string | null)[]>,
  byteByRef: Map<string, number>,
  cfg: ThresholdConfig,
): Finding | null {
  if (!cfg.crossAtlasRedundancy) return null;

  // Per-atlas Σ(frame area) for the area-proportional disk estimate. Built only for atlases whose hash entry
  // length matches the sprite count (a length mismatch ⇒ stale/desynced dep for THAT atlas — exclude it only,
  // never mis-key a region; the others still compare).
  const allFrameArea = new Map<string, number>();

  // Flatten every (atlas, spriteIndex) carrying a non-null region hash into a stable list. Iterate atlases in
  // the order given (analyze pushes them in asset order) and sprites in index order; the flattened order is
  // deterministic and only used to seed clusters — every output below is independently sorted.
  interface Unit {
    atlas: string;
    index: number;
    name: string;
    hash: string;
    rect: Rect;
  }
  const units: Unit[] = [];
  for (const atlas of atlases) {
    const hashes = frameHashByRef.get(atlas.name);
    if (!hashes || hashes.length !== atlas.sprites.length) continue; // no/desynced hashes for this atlas
    allFrameArea.set(
      atlas.name,
      atlas.sprites.reduce((s, sp) => s + sp.frame.w * sp.frame.h, 0),
    );
    for (let i = 0; i < atlas.sprites.length; i++) {
      const h = hashes[i];
      if (h == null) continue; // host-skipped flat region / read failure — never clusters
      const sp = atlas.sprites[i]!;
      units.push({ atlas: atlas.name, index: i, name: sp.name, hash: h, rect: sp.frame });
    }
  }
  if (units.length === 0) return null;

  // Cluster units by region hash.
  const clusters = new Map<string, Unit[]>();
  for (const u of units) {
    const g = clusters.get(u.hash) ?? [];
    g.push(u);
    clusters.set(u.hash, g);
  }

  // Deterministic cluster ordering: by each cluster's lowest (atlasName, spriteIndex).
  const lowestOf = (g: Unit[]): Unit =>
    g.reduce((min, u) =>
      u.atlas < min.atlas || (u.atlas === min.atlas && u.index < min.index) ? u : min,
    );
  const ordered = [...clusters.values()].sort((a, b) => {
    const la = lowestOf(a);
    const lb = lowestOf(b);
    return la.atlas.localeCompare(lb.atlas) || la.index - lb.index;
  });

  const refs: string[] = []; // every sprite name in a qualifying cross-atlas cluster (proof; names may repeat
  // across sheets — that repetition IS the cross-sheet duplication, so we keep it like the within-atlas rule)
  const atlasSet = new Set<string>(); // distinct atlases touched by qualifying clusters
  let recoverableArea = 0; // Σ over clusters of Σ(freed distinct-rect area) — the reclaimable atlas px
  let dupes = 0; // count of recoverable cross-sheet copies (distinct units beyond the one kept)
  let groups = 0; // qualifying cluster count
  let diskEstimate = 0; // area-proportional disk estimate (per freed copy → its own atlas), invariant 5

  for (const cluster of ordered) {
    // Require the cluster to span ≥2 DISTINCT atlases (single-atlas clusters are frameRedundancy's job).
    const atlasesInCluster = new Set(cluster.map((u) => u.atlas));
    if (atlasesInCluster.size < 2) continue;

    // DISTINCT-UNIT GUARD, per atlas: each atlas contributes ONE representative unit per cluster (the lowest-
    // (atlas,index) member). An atlas's OWN intra-atlas dupes of this frame are frameRedundancy's reclaim
    // (rules.ts, per-rect); counting them here would double-claim the same pixels (invariant 3/5). Cross-sheet
    // reclaim = aliasing one shared copy across the DISTINCT sheets = (distinct atlases − 1) copies.
    const byAtlas = new Map<string, Unit>();
    for (const u of cluster) {
      const prev = byAtlas.get(u.atlas);
      if (!prev || u.index < prev.index) byAtlas.set(u.atlas, u); // lowest-index rep per atlas (determinism)
    }
    const distinctUnits = [...byAtlas.values()];
    if (distinctUnits.length < cfg.crossAtlasRedundancy.minDuplicates) continue; // frame on too few DISTINCT sheets

    // Keep ONE representative cluster-wide (lowest (atlasName, spriteIndex)); every OTHER distinct unit is a
    // freed copy. Area is uniform within a hash cluster (identical region pixels ⇒ identical w×h).
    distinctUnits.sort((a, b) => a.atlas.localeCompare(b.atlas) || a.index - b.index);
    const freed = distinctUnits.slice(1);
    groups += 1;
    dupes += freed.length;

    for (const u of cluster) {
      refs.push(u.name);
      atlasSet.add(u.atlas);
    }
    for (const f of freed) {
      const area = f.rect.w * f.rect.h;
      recoverableArea += area;
      // Disk: attribute each freed copy's bytes to ITS OWN atlas (the sheet the redundant copy sat on).
      const byteSize = byteByRef.get(f.atlas);
      const atlasArea = allFrameArea.get(f.atlas) ?? 0;
      if (byteSize != null && atlasArea > 0) diskEstimate += (byteSize * area) / atlasArea;
    }
  }

  if (dupes < 1) return null; // no cluster spanned ≥2 atlases AND reached the gate
  diskEstimate = Math.round(diskEstimate);

  // Round 24: ONE collation across ALL four ordering sites in this function — cluster ordering (345),
  // representative selection (375), and these two output sets — all use `localeCompare` (matching manifest.ts).
  // A bare `.sort()` here is code-unit collation, which can DISAGREE with the localeCompare cluster/rep order on
  // mixed-case or non-ASCII names; unifying removes that inconsistency. Deterministic for a fixed ICU build;
  // output is unchanged on pure-ASCII inputs (where both collations agree).
  const sortedRefs = refs.sort((a, b) => a.localeCompare(b));
  const sortedAtlases = [...atlasSet].sort((a, b) => a.localeCompare(b));
  const sheets = sortedAtlases.length;
  const vram = recoverableArea * 4; // BYTES_PER_PX — EXACT duplicate-region area, mirrors frameRedundancy

  // Baked English — MUST mirror the en catalog templates byte-for-byte (the renderFinding drift guard). The
  // headline `dupes` count drives the plural (title + detail). The claim is SCOPED to the duplicate-frame area
  // ("reclaim the duplicate-frame area"), explicitly orthogonal to atlas-merge (which reclaims EMPTY space).
  const frameWord = dupes === 1 ? 'frame' : 'frames';
  return {
    id: 'folder:cross-atlas-redundancy',
    rule: 'cross-atlas-redundancy',
    severity: 'warn',
    scope: 'folder',
    assetRef: sortedAtlases[0]!,
    relatedRefs: sortedRefs,
    title: `${dupes} duplicate ${frameWord} across ${sheets} atlases — identical pixels on separate sheets`,
    detail:
      `${dupes} ${frameWord} in ${groups} group(s) have byte-identical pixel regions shared across ${sheets} ` +
      `atlases (${sortedAtlases.join(', ')}). They pin ${fmtBytes(vram)} of VRAM (${recoverableArea}px × 4) ` +
      `that referencing one shared copy reclaims (the duplicate-frame area — separate from any empty-space ` +
      `merge win), plus ~${fmtBytes(diskEstimate)} of atlas disk (area estimate).`,
    fix: 'Reference one shared copy across the sheets instead of packing identical frames on each.',
    // VRAM is exact area arithmetic; diskBytesSaved is an area-proportional ESTIMATE, kept here for the
    // finding's own readout but NOT folded into the aggregate potentialDiskSaved (see analyze.ts).
    estimate: { vramBytesSaved: vram, ...(diskEstimate > 0 ? { diskBytesSaved: diskEstimate } : {}) },
    messageKey: 'cross-atlas-redundancy',
    params: {
      dupes,
      groups,
      sheets,
      refs: sortedRefs.join(', '),
      atlases: sortedAtlases.join(', '),
      vram,
      area: recoverableArea,
      disk: diskEstimate,
    },
  };
}
