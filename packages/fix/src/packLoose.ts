// Feature 4 (pack loose assets into spritesheets) — PURE orchestrator: loose images → Atlas[] + Blit[].
// Mirrors `repackAtlases` (same pack()/POT-bin/localeCompare-sort shape) but builds sheets from LOOSE
// regions rather than re-placing existing atlas sprites. NO pixels, NO canvas, NO IO — the worker reads
// each region's alpha bbox (handed in via LooseRegion.trim) and composes per the Blit contract.
//
// Two kinds, ONE asymmetry honored here (and only here, alongside trim.ts):
//   kind:'static' → spriteSourceSize.y = TOP-LEFT trim offset (spriteSourceSizeFrom; TP convention),
//                   Atlas.source.kind = 'texturepacker-hash' → emitTexturePackerJson.
//   kind:'spine'  → spriteSourceSize.y = BOTTOM-LEFT offset (spineOffsetFrom; the libGDX Y-flip),
//                   Atlas.source.kind = 'spine' → emitSpineAtlasText writes it verbatim, re-parse recovers it.
// Emitters (manifest.ts/spine-atlas.ts) stay UNCHANGED — the flip lives in trim.ts, not the emitter.
//
// v1 NEVER rotates a blit: allowRotation is a typed `false`, every Blit.rotate90 is false, every Sprite is
// asserted rotated===false at the emit boundary (fail-fast). See docs/spritesheet-packing-design.md § 3c.

import type { Atlas, Blit, ImageMime, LooseRegion, PackKind, Sprite } from '@asset-doctor/core';
import { pack, type PackItem } from './pack';
import { spriteSourceSizeFrom, spineOffsetFrom } from './trim';

const vram = (w: number, h: number): number => w * h * 4;

/** Image-file extension for a sheet page, by target MIME. PNG is the runtime-safe default for spine. */
function extFor(mime: ImageMime): string {
  switch (mime) {
    case 'image/webp':
      return '.webp';
    case 'image/jpeg':
      return '.jpg';
    case 'image/avif':
      return '.avif';
    case 'image/png':
    default:
      return '.png';
  }
}

export interface PackLooseOptions {
  kind: PackKind; // controls imageRef ext default + spriteSourceSize.y origin (§3b)
  imageBase: string; // sheet basename stem (= group.stem)
  targetMime: ImageMime; // drives the image extension
  trim: boolean; // pack trimmed content vs untrimmed
  padding: number;
  maxSize: number;
  allowRotation: false; // v1 invariant — typed literal
  format?: string; // Spine page `format:` (default RGBA8888) → Atlas.format
  /** SYMMETRIC packing gutter (px) reserved on all four sides of every packed region so the worker's
   *  edge-extrude (bleed) has its own room. Forwarded verbatim to `pack` (PackOptions.gutter). Absent/0
   *  ⇒ placements byte-identical to today. */
  gutter?: number;
}

export interface PackLooseResult {
  atlases: Atlas[]; // 1 per POT bin (static: 1 JSON each; spine: N page blocks of ONE .atlas)
  blits: Blit[]; // worker compose contract (rotate90 ALWAYS false)
  vramBytesAfter: number; // Σ w×h×4 of emitted sheets (honest GPU footprint of the new sheets)
  pageOfName: Map<string, number>; // region name → bin index (lets the worker emit per-page; §6)
}

/**
 * Pack loose images into POT sheet(s). `PackItem` dims = the TRIMMED content size when `trim` (and the
 * region actually carries a trim bbox), else the FULL `sourceSize` — we pack the trimmed content, never the
 * untrimmed footprint. Sprites carry `rotated:false`; `spriteSourceSize.y` is TOP-LEFT (static) or
 * BOTTOM-LEFT (spine). Deterministic: `pack` stable-sorts items; sprites sorted by `localeCompare` (== the
 * emitted manifest order); imageRef suffix `_${i}` deterministic; single page ⇒ NO suffix.
 */
export function packLoose(regions: LooseRegion[], opts: PackLooseOptions): PackLooseResult {
  const ext = extFor(opts.targetMime);
  const byId = new Map<string, LooseRegion>();
  const items: PackItem[] = [];
  for (const r of regions) {
    byId.set(r.name, r);
    const trimmedDims = opts.trim && r.trim ? { w: r.trim.w, h: r.trim.h } : { w: r.sourceSize.w, h: r.sourceSize.h };
    items.push({ id: r.name, w: trimmedDims.w, h: trimmedDims.h });
  }

  const bins = pack(items, { maxSize: opts.maxSize, allowRotation: false, padding: opts.padding, ...(opts.gutter ? { gutter: opts.gutter } : {}) });

  const atlases: Atlas[] = [];
  const blits: Blit[] = [];
  const pageOfName = new Map<string, number>();
  let vramBytesAfter = 0;

  bins.forEach((bin, i) => {
    vramBytesAfter += vram(bin.w, bin.h);
    // ONE documented imageRef scheme (intentionally NOT repackAtlases's): single page ⇒ no suffix; page i>0
    // ⇒ `_${i}`. These are FRESH names with no prior references, so page 0 never needs a suffix.
    const imageRef = i === 0 ? `${opts.imageBase}${ext}` : `${opts.imageBase}_${i}${ext}`;
    const sprites: Sprite[] = bin.placements.map((p) => {
      const r = byId.get(p.id)!;
      const sourceSize = r.sourceSize;
      // rotated:false ⇒ no w/h swap. `frame` is the packed rect AS PLACED.
      const frame = { x: p.x, y: p.y, w: p.w, h: p.h };
      // "trimmed" only when the opaque bbox is strictly smaller than the source (an all-opaque image with a
      // bbox === source is NOT trimmed — its frame already equals the source).
      const trimmed = !!(opts.trim && r.trim && (r.trim.w !== sourceSize.w || r.trim.h !== sourceSize.h));
      pageOfName.set(r.name, i);
      const out: Sprite = { name: r.name, frame, rotated: false, trimmed, sourceSize };
      if (trimmed) {
        if (opts.kind === 'spine') {
          // BOTTOM-LEFT offset (the Y-flip) carried in spriteSourceSize.y so emitSpineAtlasText writes it verbatim.
          const off = spineOffsetFrom(sourceSize, r.trim!);
          out.spriteSourceSize = { x: off.x, y: off.y, w: p.w, h: p.h };
        } else {
          // TOP-LEFT trim offset (TP convention).
          out.spriteSourceSize = spriteSourceSizeFrom(sourceSize, r.trim!);
        }
      }
      // v1 fail-fast: the compose path cannot rotate a blit, so no emitted sprite may be rotated.
      if (out.rotated !== false) throw new Error(`packLoose: rotated sprite emitted (${out.name}) — v1 cannot rotate a blit`);
      blits.push({
        name: r.name,
        // Source rect = the trimmed opaque bbox when trimming, else the full image.
        from: { atlasRef: r.ref, rect: opts.trim && r.trim ? r.trim : { x: 0, y: 0, w: sourceSize.w, h: sourceSize.h }, rotated: false },
        to: frame,
        rotate90: false,
      });
      return out;
    });
    sprites.sort((a, b) => a.name.localeCompare(b.name)); // deterministic, matches the emitted manifest order
    atlases.push({
      name: imageRef,
      imageRef,
      size: { w: bin.w, h: bin.h },
      sprites,
      source: { kind: opts.kind === 'spine' ? 'spine' : 'texturepacker-hash' },
      ...(opts.format ? { format: opts.format } : {}),
    });
  });

  return { atlases, blits, vramBytesAfter, pageOfName };
}
