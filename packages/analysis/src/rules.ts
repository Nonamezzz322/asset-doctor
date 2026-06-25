// Audit rules. Each is a pure function over the normalized model + a ThresholdConfig, returning
// Finding(s) with a verdict, the proof (numbers), a fix, and — where visual — overlay zones.
// We measure; we never fabricate. Thresholds come from config, never inline magic numbers.

import type { Atlas, Finding, ImageAsset, ImageMime, Severity, Size, ThresholdConfig } from '@asset-doctor/core';
import { buildCoverage, defaultCell, mergeEmptyRects } from './grid';

const BYTES_PER_PX = 4; // RGBA8888

/** GPU footprint of a texture: w × h × 4. Disk weight ≠ VRAM. */
export const vramBytes = (size: Size): number => size.w * size.h * BYTES_PER_PX;

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
  return atlas.sprites.reduce((s, sp) => s + sp.frame.w * sp.frame.h, 0) / total;
}

export function occupancyFinding(atlas: Atlas, cfg: ThresholdConfig): Finding | null {
  const occ = occupancyValue(atlas);
  const severity: Severity =
    occ < cfg.occupancy.crit ? 'crit' : occ < cfg.occupancy.warn ? 'warn' : 'ok';
  if (severity === 'ok') return null;
  return {
    id: `${atlas.name}:occupancy`,
    rule: 'occupancy',
    severity,
    assetRef: atlas.name,
    title: `Atlas ${pct1(occ)}% packed — ${pct1(1 - occ)}% wasted`,
    detail:
      `${atlas.sprites.length} frames cover ${pct1(occ)}% of ${atlas.size.w}×${atlas.size.h}. ` +
      `Tighter packing shrinks the sheet and the VRAM it pins (${fmtBytes(vramBytes(atlas.size))}).`,
    fix: 'Repack with MaxRects + trim, or split into a smaller sheet.',
    estimate: { occupancyPct: occ },
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
      });
    }
  }
  return out;
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
  const emptyPx = rects.reduce((s, r) => s + r.w * r.h, 0);
  const atlasPx = atlas.size.w * atlas.size.h;
  return {
    id: `${atlas.name}:wasted-regions`,
    rule: 'wasted-regions',
    severity: 'info',
    assetRef: atlas.name,
    title: `${rects.length} empty region${rects.length === 1 ? '' : 's'} mapped`,
    detail: `≈${pct1(emptyPx / atlasPx)}% of the atlas is contiguous empty space (grid-mapped).`,
    overlay: [{ kind: 'empty', rects }],
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
  };
}
