// Audit rules. Each is a pure function over the normalized model + a ThresholdConfig, returning
// Finding(s) with a verdict, the proof (numbers), a fix, and — where visual — overlay zones.
// We measure; we never fabricate. Thresholds come from config, never inline magic numbers.

import { MIP_OVERHEAD, type Atlas, type ContentClass, type Finding, type ImageAsset, type ImageMime, type OverlayZone, type Rect, type Severity, type Size, type ThresholdConfig } from '@asset-doctor/core';
import { buildCoverage, defaultCell, mergeEmptyRects, summarizeEmpty } from './grid';

const BYTES_PER_PX = 4; // RGBA8888

/** BASE GPU footprint of a texture: w × h × 4. Disk weight ≠ VRAM. */
export const vramBytes = (size: Size): number => size.w * size.h * BYTES_PER_PX;

/** GPU footprint of a texture IF mipmaps are enabled: ceil(w × h × 4 × 4/3) — the base + the +33% mip
 *  chain. An "if mipmapped" ceiling, not asserted residency (the engine decides per source). Pure
 *  geometry: no pixel read, shares MIP_OVERHEAD with the runtime probe so the two paths can't drift. */
export const vramBytesMipmapped = (size: Size): number => Math.ceil(vramBytes(size) * MIP_OVERHEAD);

const isPowerOfTwo = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;
const nextPot = (n: number): number => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};
const pct1 = (frac: number): number => Math.round(frac * 1000) / 10;

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function occupancyValue(atlas: Atlas): number {
  const total = atlas.size.w * atlas.size.h;
  if (total <= 0) return 0;
  const sum = atlas.sprites.reduce((s, sp) => s + sp.frame.w * sp.frame.h, 0);
  // Clamp to ≤1: aliased TexturePacker frames / shared Spine regions double-count Σ, which can push
  // the naive sum past the sheet area (impossible ">100% packed"). For non-aliased atlases min(1,x)=x,
  // so every existing occupancy golden is unchanged. The exact union would need the grid — rejected as
  // a systematic over-claim on normal sheets (see docs/improvements/occupancy-clamp.md).
  return Math.min(1, sum / total);
}

export function occupancyFinding(
  atlas: Atlas,
  cfg: ThresholdConfig,
  opts: { fragmentation?: number; largestPct?: number } = {},
): Finding | null {
  const occ = occupancyValue(atlas);
  const severity: Severity =
    occ < cfg.occupancy.crit ? 'crit' : occ < cfg.occupancy.warn ? 'warn' : 'ok';
  if (severity === 'ok') return null;
  const wasted = Math.max(0, 1 - occ); // belt-and-suspenders: occ is now clamped ≤1, but guard hand-built callers
  // B1: frag/largestPct can be undefined (no empty rects mapped) while occupancy still fires. Default
  // to frag = 1 (contiguous) / largestPct = wasted so the dispersion clause is never an empty
  // interpolation and stays truthful (frag = 1 ⇒ "one hole", a contiguous-waste reading).
  const frag = typeof opts.fragmentation === 'number' ? opts.fragmentation : 1;
  const largestPct = typeof opts.largestPct === 'number' ? opts.largestPct : wasted;
  // M1/M3: dispersion is a SHAPE clause, NEVER a savings claim — phrased to read truthfully at any frag
  // (the lower the dispersion, the more a full repack rather than a trim is the real fix). The baked
  // string mirrors the en catalog template EXACTLY (the renderFinding drift guard requires byte parity).
  return {
    id: `${atlas.name}:occupancy`,
    rule: 'occupancy',
    severity,
    assetRef: atlas.name,
    title: `Atlas ${pct1(occ)}% packed — ${pct1(wasted)}% wasted`,
    detail:
      `${atlas.sprites.length} frames cover ${pct1(occ)}% of ${atlas.size.w}×${atlas.size.h}. ` +
      `Tighter packing shrinks the sheet and the VRAM it pins (${fmtBytes(vramBytes(atlas.size))}). ` +
      `Largest contiguous empty hole is ${pct1(largestPct)}% of the sheet (dispersion ${pct1(frag)}%); ` +
      `the lower the dispersion, the more a full repack — not a trim — is needed.`,
    fix: 'Repack with MaxRects + trim, or split into a smaller sheet.',
    estimate: { occupancyPct: occ },
    messageKey: 'occupancy',
    params: { occ, wasted, frames: atlas.sprites.length, w: atlas.size.w, h: atlas.size.h, vram: vramBytes(atlas.size), frag, largestPct },
  };
}

export function dimensionFindings(ref: string, size: Size, cfg: ThresholdConfig): Finding[] {
  const out: Finding[] = [];
  const longest = Math.max(size.w, size.h);
  if (longest > cfg.oversizePx.warn) {
    const severity: Severity = longest > cfg.oversizePx.crit ? 'crit' : 'warn';
    const budget = severity === 'crit' ? cfg.oversizePx.crit : cfg.oversizePx.warn;
    out.push({
      id: `${ref}:oversize`,
      rule: 'dimensions-oversize',
      severity,
      assetRef: ref,
      title: `Oversized ${size.w}×${size.h} (edge ${longest}px)`,
      detail:
        `Longest edge ${longest}px exceeds the ${budget}px ${severity} budget. ` +
        `It pins ${fmtBytes(vramBytes(size))} of VRAM and may exceed low-end GPU limits.`,
      fix: 'Downscale, split, or stream; verify the max texture size of your target GPUs.',
      messageKey: 'oversize',
      params: { w: size.w, h: size.h, edge: longest, budget, sev: severity, vram: vramBytes(size) },
    });
  }
  if (!isPowerOfTwo(size.w) || !isPowerOfTwo(size.h)) {
    // NPOT is fine on WebGL2/PixiJS (clamp+linear, uploaded at native size). The only real cost is
    // VRAM lost IF the toolchain pads to POT — so flag (info) only when that padding waste is large.
    const potW = nextPot(size.w);
    const potH = nextPot(size.h);
    const paddedWaste = (potW * potH - size.w * size.h) / (potW * potH);
    if (paddedWaste > cfg.npotPadding.warn) {
      out.push({
        id: `${ref}:npot`,
        rule: 'dimensions-npot',
        severity: 'info',
        assetRef: ref,
        title: `Non-power-of-two ${size.w}×${size.h}`,
        detail:
          `Padding to ${potW}×${potH} would waste ${pct1(paddedWaste)}% ` +
          `(${fmtBytes(vramBytes({ w: potW, h: potH }) - vramBytes(size))}) IF your toolchain pads to POT. ` +
          `WebGL2/PixiJS upload NPOT natively (clamp+linear), so this is usually harmless.`,
        fix: 'Only act if your pipeline forces POT: trim/resize so the padding is minimal.',
        estimate: { vramBytesSaved: vramBytes({ w: potW, h: potH }) - vramBytes(size) },
        messageKey: 'npot',
        params: { w: size.w, h: size.h, potW, potH, waste: paddedWaste, vram: vramBytes({ w: potW, h: potH }) - vramBytes(size) },
      });
    }
  }
  return out;
}

/** Single-color (or fully transparent) LOOSE image. A 1024² solid PNG is POT and under the oversize
 *  budget, yet pins w×h×4 VRAM to carry ONE color — the format audit won't catch it (no ≥25% transcode
 *  delta on an already-tiny solid). We MEASURE the wasted VRAM; we never emit the 1×1 replacement (that
 *  is the fix engine's job — Invariant 3), so the estimate is `vramBytesSaved` only, NO `diskBytesSaved`.
 *  Loose-only; the worker sets `solid` from the SAME 9×8 sample it already decodes (zero extra read). */
export function solidFillFinding(ref: string, size: Size, cfg: ThresholdConfig): Finding | null {
  if (!cfg.solidFill) return null;
  const shorter = Math.min(size.w, size.h);
  if (shorter < cfg.solidFill.minEdgePx) return null;
  const longest = Math.max(size.w, size.h);
  const severity: Severity = longest >= cfg.solidFill.warnEdgePx ? 'warn' : 'info';
  const vram = vramBytes(size);
  return {
    id: `${ref}:solid-fill`,
    rule: 'solid-fill',
    severity,
    assetRef: ref,
    title: `Solid ${size.w}×${size.h} — one color pinning ${fmtBytes(vram)}`,
    detail:
      `Every sampled pixel is the same color (or fully transparent) — no edges, gradient or detail. ` +
      `It still pins ${fmtBytes(vram)} of VRAM (${size.w}×${size.h}×4) to carry a single value.`,
    fix: 'Replace with a 1×1 texture tinted/stretched at runtime, or a solid-color sprite.',
    // VRAM only: a 1×1 carries the color in ~4 bytes; the disk saving belongs to the fix engine that
    // actually emits the replacement (we measure, we don't generate — Invariant 3).
    estimate: { vramBytesSaved: vram - BYTES_PER_PX },
    messageKey: 'solid-fill',
    params: { w: size.w, h: size.h, vram },
  };
}

/** Within-atlas duplicate-frame detector. The host (worker) hashes each sprite's PIXEL REGION from the
 *  ALREADY-DECODED atlas page (`frameHashes`, index-aligned to `atlas.sprites`; `null` = host-skipped flat
 *  region or read failure, never clustered). We CLUSTER frames whose region hash is byte-identical — these
 *  are redundant frames wasting atlas AREA. We MEASURE the recoverable set (every duplicate beyond the one
 *  representative kept per cluster) and report:
 *    • VRAM — the recoverable distinct-rect area × 4 (the atlas space the duplicates pin; a repack that
 *      drops them shrinks the sheet). Honest, exact area arithmetic.
 *    • DISK — an AREA-PROPORTIONAL ESTIMATE only (no per-region disk bytes exist): the image's byteSize
 *      scaled by recoverableArea / Σ(all frame areas). Guarded on Σ > 0; carried separately, NEVER folded
 *      into the aggregate potentialDiskSaved (invariant 5: VRAM and disk are distinct quantities).
 *  DISTINCT-RECT GUARD (invariant 3, honesty): two manifest names pointing at the IDENTICAL packed rect
 *  (x,y,w,h) — a pre-aliased Spine/TP sheet — are ALREADY one region on the GPU, so they cluster by hash
 *  but contribute ONE recoverable unit, never an inflated count. We generate NOTHING (the dedup is the fix
 *  engine's job); we record the measured duplicate set + one OverlayZone per cluster. Returns null below the
 *  gate, with no config, on a length mismatch, or when no cluster reaches minDuplicates. */
export function frameRedundancyFinding(
  atlas: Atlas,
  cfg: ThresholdConfig,
  frameHashes: (string | null)[],
  imageByteSize: number,
): Finding | null {
  if (!cfg.frameRedundancy) return null;
  // Defensive: the host hashes index-aligned to the SAME (post-merge) sprite list. A mismatch means the
  // dep is stale/desynced — bail rather than mis-key a region (additive: no finding, byte-identical).
  if (frameHashes.length !== atlas.sprites.length) return null;

  const rectKey = (r: Rect): string => `${r.x},${r.y},${r.w},${r.h}`;

  // Cluster sprite INDICES by region hash (skip nulls — a host-skipped flat region never clusters). Insertion
  // order of indices is ascending (we iterate sprites in order), so each cluster's index list is sorted.
  const clusters = new Map<string, number[]>();
  for (let i = 0; i < atlas.sprites.length; i++) {
    const h = frameHashes[i];
    if (h == null) continue;
    const g = clusters.get(h) ?? [];
    g.push(i);
    clusters.set(h, g);
  }

  const dupRefs: string[] = []; // every sprite name in a qualifying duplicate cluster (proof)
  const overlay: OverlayZone[] = []; // one zone per cluster (FilmViewer rotates hue by zone index)
  let recoverableArea = 0; // Σ over clusters of (distinctRects − 1) × rectArea — the reclaimable atlas px
  let totalDuplicates = 0; // count of recoverable frames (distinct rects beyond the one kept), for the title

  // Deterministic cluster ordering: by the first (lowest) sprite index in each cluster.
  const ordered = [...clusters.values()].sort((a, b) => a[0]! - b[0]!);
  for (const indices of ordered) {
    // DISTINCT-RECT GUARD: collapse manifest names that alias the SAME packed rect — one recoverable unit.
    const byRect = new Map<string, number[]>();
    for (const i of indices) {
      const key = rectKey(atlas.sprites[i]!.frame);
      const g = byRect.get(key) ?? [];
      g.push(i);
      byRect.set(key, g);
    }
    const distinctRects = byRect.size;
    if (distinctRects < cfg.frameRedundancy.minDuplicates) continue; // not enough genuinely-distinct dupes

    // The duplicates this cluster recovers: every DISTINCT rect beyond the one representative we keep. Area
    // is uniform within a hash cluster (identical region pixels ⇒ identical w×h), so use the first rect's.
    const rect = atlas.sprites[indices[0]!]!.frame;
    const rectArea = rect.w * rect.h;
    recoverableArea += (distinctRects - 1) * rectArea;
    totalDuplicates += distinctRects - 1;

    for (const i of indices) dupRefs.push(atlas.sprites[i]!.name);
    // One overlay zone per cluster — the redundant rects (skip the representative we'd keep = the first
    // distinct rect, by its lowest index). Deterministic: distinct rects ordered by their lowest index.
    const distinctOrdered = [...byRect.values()].sort((a, b) => a[0]! - b[0]!);
    const zoneRects: Rect[] = distinctOrdered.slice(1).map((g) => ({ ...atlas.sprites[g[0]!]!.frame }));
    overlay.push({ kind: 'duplicate-frame', rects: zoneRects });
  }

  if (totalDuplicates < 1) return null; // no cluster reached the gate
  dupRefs.sort();

  const vram = recoverableArea * BYTES_PER_PX;
  // DISK is an area-proportional ESTIMATE (no per-region disk bytes): byteSize × recoverableArea / Σ(all
  // frame areas). Guard Σ > 0 (an atlas of zero-area frames ⇒ skip the disk estimate, emit VRAM only — but
  // totalDuplicates ≥ 1 already implies a non-zero rectArea, so Σ > 0 holds; the guard is belt-and-braces).
  const allFrameArea = atlas.sprites.reduce((s, sp) => s + sp.frame.w * sp.frame.h, 0);
  const diskEstimate = allFrameArea > 0 ? Math.round((imageByteSize * recoverableArea) / allFrameArea) : 0;
  const clusterCount = overlay.length;

  // Baked English — MUST mirror the en catalog templates byte-for-byte (the renderFinding drift guard). The
  // headline `dupes` count drives the plural (title + detail); `groups` is a plain count. The disk clause
  // always renders (diskEstimate is 0 only for a degenerate zero-area atlas that cannot reach the gate).
  const frameWord = totalDuplicates === 1 ? 'frame' : 'frames';
  return {
    id: `${atlas.name}:frame-redundancy`,
    rule: 'frame-redundancy',
    severity: 'warn',
    assetRef: atlas.name,
    relatedRefs: dupRefs,
    title: `${totalDuplicates} redundant ${frameWord} — identical pixels reused`,
    detail:
      `${totalDuplicates} ${frameWord} in ${clusterCount} group(s) have byte-identical pixel regions ` +
      `within this atlas. They pin ${fmtBytes(vram)} of VRAM (${recoverableArea}px × 4) that a ` +
      `de-duplicated repack reclaims, plus ~${fmtBytes(diskEstimate)} of atlas disk (area estimate).`,
    fix: 'Reference one shared frame instead of packing identical copies, or repack de-duplicated.',
    // VRAM is exact area arithmetic; diskBytesSaved is an area-proportional ESTIMATE, kept here for the
    // finding's own readout but NOT folded into the aggregate potentialDiskSaved (see analyze.ts).
    estimate: { vramBytesSaved: vram, ...(diskEstimate > 0 ? { diskBytesSaved: diskEstimate } : {}) },
    overlay,
    messageKey: 'frame-redundancy',
    params: {
      dupes: totalDuplicates,
      groups: clusterCount,
      refs: dupRefs.join(', '),
      vram,
      area: recoverableArea,
      disk: diskEstimate,
    },
  };
}

/** Re-encode an asset's image OPAQUELY (compose onto an opaque canvas, dropping the dead alpha channel)
 *  to the SAME source format and return the resulting byte size — or null if unavailable. The MEASURED
 *  honest disk cost of the alpha channel = source byteSize − this. Same kind of injected sizer as
 *  EncodeSizer (measurement, not generation: it sizes, it never emits a file — the actual opaque file is
 *  the Pro fix's job, invariant 3). Browser/worker supplies it via an `{alpha:false}` OffscreenCanvas;
 *  headless/CLI omits it ⇒ the finding never fires. */
export type OpaqueEncodeSizer = (assetRef: string, mime: ImageMime) => Promise<number | null>;

/** Fully-opaque LOOSE image that still carries an alpha channel (PNG / WebP-with-alpha). Its alpha is
 *  255 on EVERY pixel (host full-frame scan), so the channel is dead weight on DISK — a PNG/WebP encoder
 *  spends bytes storing a constant plane. We MEASURE that DISK cost by re-encoding the image OPAQUE to the
 *  SAME format (the injected sizer); the saving is `byteSize − opaqueBytes`. HONESTY (invariant 5): this is
 *  a DOWNLOAD/disk saving ONLY — the GPU still decodes to RGBA8888 and allocates the same VRAM, so the
 *  finding carries `diskBytesSaved` and NEVER `vramBytesSaved`. We never emit the opaque image (that is the
 *  fix engine's job — invariant 3). Loose-only; the worker sets `opaque` from a full-resolution scan (NOT
 *  the 9×8 sample — one transparent pixel must not average away). Returns null below the gates, on a JPEG /
 *  AVIF source (JPEG has no alpha; AVIF is already the recommended target), or with no sizer / no saving. */
export async function wastedAlphaFinding(
  ref: string,
  image: ImageAsset,
  cfg: ThresholdConfig,
  encodeOpaque?: OpaqueEncodeSizer,
): Promise<Finding | null> {
  if (!cfg.wastedAlpha || !encodeOpaque || image.byteSize <= 0) return null;
  // Only formats that actually store a (here-dead) alpha channel. JPEG has none; AVIF is already the
  // best delivery target (the format audit owns it) and rarely the loose-art case we mean.
  if (image.mime !== 'image/png' && image.mime !== 'image/webp') return null;
  const shorter = Math.min(image.size.w, image.size.h);
  if (shorter < cfg.wastedAlpha.minEdgePx) return null;
  const opaqueBytes = await encodeOpaque(ref, image.mime);
  if (opaqueBytes == null || opaqueBytes <= 0) return null;
  const saved = image.byteSize - opaqueBytes;
  const frac = saved / image.byteSize;
  if (frac < cfg.wastedAlpha.minDiskSaving) return null; // a near-zero channel isn't worth a verdict
  const label = FORMAT_LABEL[image.mime];
  return {
    id: `${ref}:wasted-alpha`,
    rule: 'wasted-alpha',
    severity: 'warn',
    assetRef: ref,
    title: `${label} carries an unused alpha channel — ${fmtBytes(saved)} of dead weight`,
    detail:
      `Every pixel is fully opaque (alpha 255), yet this ${label} still stores an alpha channel. ` +
      `Dropping it (re-encode opaque, same format) cuts ~${fmtBytes(saved)} (${pct1(frac)}%) of DOWNLOAD. ` +
      `This is a DISK saving only — the GPU still decodes to RGBA8888, so VRAM is unchanged.`,
    fix: `Re-encode opaque (RGB) for delivery, or switch to a format without an alpha channel.`,
    // DISK only: the dead channel costs download bytes; it costs NOTHING on the GPU (RGBA8888 regardless,
    // invariant 5). NO vramBytesSaved — that would be a faked win.
    estimate: { diskBytesSaved: saved },
    messageKey: 'wasted-alpha',
    params: { srcLabel: label, srcBytes: image.byteSize, opaqueBytes, saved, frac },
  };
}

export function wastedRegions(
  atlas: Atlas,
  cfg: ThresholdConfig,
  opts: { cell?: number } = {},
): Finding | null {
  if (occupancyValue(atlas) >= cfg.occupancy.warn) return null; // map emptiness only when it matters
  const cell = opts.cell ?? defaultCell(atlas.size);
  const rects = mergeEmptyRects(buildCoverage(atlas, cell), atlas.size);
  if (rects.length === 0) return null;
  const empty = summarizeEmpty(rects); // reuse the rects already merged — no second mergeEmptyRects
  const atlasPx = atlas.size.w * atlas.size.h;
  // M2: largestPct lives in the caller (it has atlasPx); summarizeEmpty stays Size-free.
  const frag = empty.fragmentation ?? 1; // rects.length>0 here, so totalArea>0 ⇒ frag always defined
  const largestPct = atlasPx > 0 ? empty.largestArea / atlasPx : 0;
  return {
    id: `${atlas.name}:wasted-regions`,
    rule: 'wasted-regions',
    severity: 'info',
    assetRef: atlas.name,
    title: `${rects.length} empty region${rects.length === 1 ? '' : 's'} mapped`,
    detail:
      `≈${pct1(empty.totalArea / atlasPx)}% of the atlas is empty space (grid-mapped), ` +
      `largest contiguous hole ${pct1(largestPct)}% of the sheet.`,
    overlay: [{ kind: 'empty', rects }],
    messageKey: 'wasted-regions',
    params: { n: rects.length, pct: empty.totalArea / atlasPx, frag, largestPct },
  };
}

/** Encode an asset's image to a target format and return its byte size (or null if unavailable). */
export type EncodeSizer = (
  assetRef: string,
  sourceMime: ImageMime,
  targetMime: ImageMime,
) => Promise<number | null>;

// Candidate delivery formats, best-first. AVIF is usually smallest; WebP is the reliable fallback.
const FORMAT_TARGETS: ImageMime[] = ['image/avif', 'image/webp'];
const FORMAT_LABEL: Record<ImageMime, string> = {
  'image/avif': 'AVIF',
  'image/webp': 'WebP',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
};

export async function formatFinding(
  ref: string,
  image: ImageAsset,
  cfg: ThresholdConfig,
  encode?: EncodeSizer,
  contentClass: ContentClass = 'unknown',
): Promise<Finding | null> {
  // AVIF is already the best target — nothing to suggest.
  if (image.mime === 'image/avif' || !encode || image.byteSize <= 0) return null;
  let best: { mime: ImageMime; bytes: number } | null = null;
  for (const target of FORMAT_TARGETS) {
    if (target === image.mime) continue;
    const bytes = await encode(ref, image.mime, target);
    if (bytes != null && bytes > 0 && (best === null || bytes < best.bytes)) best = { mime: target, bytes };
  }
  if (!best) return null;
  const saved = image.byteSize - best.bytes;
  const frac = saved / image.byteSize;
  if (frac < cfg.formatSaving.warn) return null;
  // Flat / alpha-art compresses better lossless (lossy q0.9 frays hard edges + flat fills), so the
  // VERDICT recommends lossless. INVARIANT 4: the diagnosis path does NO lossless encode — the shown
  // saving stays today's lossy q0.9 estimate, the COPY marks it as such, and the real lossless byte
  // delta materializes only in the Pro fix (plan.ts → FixOp.transcode.lossless). `rule` stays 'format'
  // (B2: plan.ts + formatAggregateFinding key off it); only `messageKey` switches. Atlases never reach
  // here as flat/alpha-art — the caller passes 'unknown' for them (M1), keeping today's lossy verdict.
  const wantsLossless = contentClass === 'flat' || contentClass === 'alpha-art';
  if (wantsLossless) {
    return {
      id: `${ref}:format`,
      rule: 'format',
      severity: 'warn',
      assetRef: ref,
      title: `${FORMAT_LABEL[best.mime]} (lossless) suits this ${contentClass}`,
      detail:
        `${contentClass} compresses better lossless — lossy q0.9 would fray hard edges. ` +
        `Prefer lossless ${FORMAT_LABEL[best.mime]}. Lossy estimate −${fmtBytes(saved)}; ` +
        `the Pro fix encodes lossless, so bytes will differ.`,
      fix: `Transcode to lossless ${FORMAT_LABEL[best.mime]} for delivery.`,
      estimate: { diskBytesSaved: saved },
      messageKey: 'format-lossless',
      // `bestMime` carries the MEASURED smallest-encode winner (machine-readable, beside the display label)
      // so the Pro fix can transcode each image to the format the diagnosis already proved smallest (round17
      // per-image best-format pick) instead of re-guessing a fixed target. We only RECORD the measurement
      // (invariant 3 — diagnosis measures, never generates); the fix opts into honoring it. Deterministic:
      // `best.mime` inherits the strict-smaller FORMAT_TARGETS scan (ties keep AVIF, the first candidate),
      // and it can NEVER equal the source mime (the candidate loop skips target===image.mime + AVIF sources
      // early-return), so a no-op pick is impossible.
      params: { target: FORMAT_LABEL[best.mime], frac, srcLabel: FORMAT_LABEL[image.mime], srcBytes: image.byteSize, bestBytes: best.bytes, saved, contentClass, bestMime: best.mime },
    };
  }
  return {
    id: `${ref}:format`,
    rule: 'format',
    severity: 'warn',
    assetRef: ref,
    title: `${FORMAT_LABEL[best.mime]} would cut ${pct1(frac)}%`,
    detail:
      `${FORMAT_LABEL[image.mime]} ${fmtBytes(image.byteSize)} → ${FORMAT_LABEL[best.mime]} ` +
      `~${fmtBytes(best.bytes)} (−${fmtBytes(saved)}). Canvas estimate; lossless parity needs wasm codecs.`,
    fix: 'Transcode to AVIF (or WebP) for delivery.',
    estimate: { diskBytesSaved: saved },
    messageKey: 'format',
    // `bestMime` (machine-readable) = the MEASURED smallest-encode winner, beside the display label, so the
    // Pro fix can honor the measured per-image winner (round17) rather than re-guess a fixed target. RECORD
    // only (invariant 3); see the format-lossless branch above for the determinism/no-op-impossible note.
    params: { target: FORMAT_LABEL[best.mime], frac, srcLabel: FORMAT_LABEL[image.mime], srcBytes: image.byteSize, bestBytes: best.bytes, saved, bestMime: best.mime },
  };
}
