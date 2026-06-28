// Parse Spine / libGDX `.atlas` text sheets into the normalized @asset-doctor/core Atlas model.
// One Atlas per page (a .atlas may hold several page images). Pure & defensive: the text parser
// never throws. Handles the legacy region format (rotate/xy/size/orig/offset) and the modern one
// (bounds/offsets); page boundaries are detected by the page header's leading `size:` line.

import type { Atlas, ImageAsset, Rect, Size, Sprite } from '@asset-doctor/core';
import type { ParseResult } from './types';
import { readImageInfo } from './image-size';

export interface SpinePage {
  image: string;
  size?: Size;
  format?: string;
  sprites: Sprite[];
  /** Regions on THIS page that named an asset but were unusable (a required field — xy/size/orig/bounds —
   *  had a non-finite value, or the region fell outside the page). Per-region recovery: the page keeps its
   *  good sprites; only the bad ones are surfaced. Additive: absent/empty ⇒ byte-identical to today. */
  malformedRegions?: { name: string; reason: string }[];
}

interface RegionAcc {
  name: string;
  rotated: boolean;
  xy?: { x: number; y: number };
  size?: { w: number; h: number };
  orig?: { w: number; h: number };
  bounds?: Rect;
  offsets?: { w: number; h: number };
  /** legacy `offset: x, y` — the trimmed region's offset within the original. */
  offset?: { x: number; y: number };
  /** Set when a REQUIRED field had a non-finite value — the region is dropped + surfaced (not silently
   *  coerced to 0, which would fabricate a placement). First failure wins (??=). */
  malformed?: string;
}

// FIXED-ARITY, NaN-PRESERVING parse: keep one entry per comma-separated token by POSITION (NOT the old
// `.filter(Number.isFinite)`, which SHIFTED coords — `'xy: , 100'` collapsed to `[100]` → `{x:100,y:0}`,
// silently misplacing the region). A blank/garbage token now yields NaN at its true index, so a required
// field reads as non-finite and the region is flagged malformed instead of misplaced.
const numsRaw = (v: string): number[] => v.split(',').map((s) => parseInt(s.trim(), 10));

const PAGE_KEYS = new Set(['size', 'format', 'filter', 'repeat', 'pma', 'scale']);
const REGION_KEYS = new Set(['rotate', 'xy', 'size', 'orig', 'offset', 'offsets', 'index', 'bounds', 'split', 'pad']);

function rotatedFrom(v: string): boolean {
  const s = v.trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false' || s === '0') return false;
  const n = parseInt(s, 10);
  return n === 90 || n === 270;
}

function applyPageKey(page: SpinePage, key: string, val: string): void {
  if (key === 'size') {
    const [w, h] = numsRaw(val);
    if (Number.isFinite(w) && Number.isFinite(h) && w! > 0 && h! > 0) page.size = { w: w!, h: h! };
  } else if (key === 'format') {
    page.format = val.trim();
  }
}

/** Required region fields whose non-finite value invalidates the placement (vs offset/offsets, which
 *  default to 0 tolerantly). The arity each must satisfy. */
const fin = (n: number | undefined): boolean => n !== undefined && Number.isFinite(n);

function applyRegionKey(r: RegionAcc, key: string, val: string): void {
  const n = numsRaw(val);
  if (key === 'rotate') r.rotated = rotatedFrom(val);
  else if (key === 'xy') {
    if (!fin(n[0]) || !fin(n[1])) r.malformed ??= `region "${r.name}": non-finite xy "${val.trim()}"`;
    else r.xy = { x: n[0]!, y: n[1]! };
  } else if (key === 'size') {
    if (!fin(n[0]) || !fin(n[1])) r.malformed ??= `region "${r.name}": non-finite size "${val.trim()}"`;
    else r.size = { w: n[0]!, h: n[1]! };
  } else if (key === 'orig') {
    if (!fin(n[0]) || !fin(n[1])) r.malformed ??= `region "${r.name}": non-finite orig "${val.trim()}"`;
    else r.orig = { w: n[0]!, h: n[1]! };
  } else if (key === 'bounds') {
    if (!fin(n[0]) || !fin(n[1]) || !fin(n[2]) || !fin(n[3]))
      r.malformed ??= `region "${r.name}": non-finite bounds "${val.trim()}"`;
    else r.bounds = { x: n[0]!, y: n[1]!, w: n[2]!, h: n[3]! };
  } else if (key === 'offsets') {
    // tolerant: a malformed optional offset defaults to 0 (today's behavior).
    r.offsets = { w: Number.isFinite(n[2]) ? n[2]! : 0, h: Number.isFinite(n[3]) ? n[3]! : 0 };
  } else if (key === 'offset') {
    r.offset = { x: Number.isFinite(n[0]) ? n[0]! : 0, y: Number.isFinite(n[1]) ? n[1]! : 0 };
  }
}

function toSprite(r: RegionAcc): Sprite {
  const x = r.xy?.x ?? r.bounds?.x ?? 0;
  const y = r.xy?.y ?? r.bounds?.y ?? 0;
  const w = r.size?.w ?? r.bounds?.w ?? 0;
  const h = r.size?.h ?? r.bounds?.h ?? 0;
  // frame = packed rect AS PLACED in the page (w/h swapped when rotated 90°/270°)
  const frame: Rect = r.rotated ? { x, y, w: h, h: w } : { x, y, w, h };
  const sourceSize: Size = r.orig ?? r.offsets ?? { w, h };
  const trimmed = sourceSize.w !== w || sourceSize.h !== h;
  const sprite: Sprite = { name: r.name, frame, rotated: r.rotated, trimmed, sourceSize };
  // a trimmed region carries its offset within the original (so a repack can re-emit it)
  if (trimmed) sprite.spriteSourceSize = { x: r.offset?.x ?? 0, y: r.offset?.y ?? 0, w, h };
  return sprite;
}

export function parseSpineAtlasText(text: string): SpinePage[] {
  const pages: SpinePage[] = [];
  const lines = text.split(/\r?\n/);
  let page: SpinePage | null = null;
  let region: RegionAcc | null = null;

  const flushRegion = () => {
    if (page && region) {
      if (region.malformed) {
        (page.malformedRegions ??= []).push({ name: region.name, reason: region.malformed });
      } else {
        const sprite = toSprite(region);
        // Per-region OOB check when the page size is known: a region placed past the page edge is a
        // corrupt atlas, not a usable sprite. `frame` is AS PLACED (already swapped in toSprite when
        // rotated), so the `x+w > size.w` test is correct without double-swap. `===` at the edge is fine.
        if (
          page.size &&
          (sprite.frame.x + sprite.frame.w > page.size.w || sprite.frame.y + sprite.frame.h > page.size.h)
        ) {
          (page.malformedRegions ??= []).push({
            name: region.name,
            reason: `region "${region.name}" extends past page ${page.size.w}×${page.size.h}`,
          });
        } else {
          page.sprites.push(sprite);
        }
      }
    }
    region = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '') continue;
    const t = raw.trim();
    const m = t.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/);

    if (m && PAGE_KEYS.has(m[1]!) && region === null) {
      if (page) applyPageKey(page, m[1]!, m[2]!);
      continue;
    }
    if (m && REGION_KEYS.has(m[1]!) && region) {
      applyRegionKey(region, m[1]!, m[2]!);
      continue;
    }
    if (!m) {
      // bare line — a page image if the next non-empty line is a (non-indented) page `size:` header.
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() === '') j++;
      const pageStart = !page || /^size\s*:/.test(j < lines.length ? lines[j]! : '');
      flushRegion();
      if (pageStart) {
        page = { image: t, sprites: [] };
        pages.push(page);
      } else {
        region = { name: t, rotated: false };
      }
    }
  }
  flushRegion();
  return pages;
}

/** Build an atlas Asset from one parsed Spine page + its page-image bytes. */
export function parseSpinePage(
  page: SpinePage,
  image: { ref: string; bytes: Uint8Array },
  opts: { name?: string } = {},
): ParseResult {
  const info = readImageInfo(image.bytes);
  if (!info) return { ok: false, error: `spine atlas image unrecognized: ${image.ref}` };
  const atlas: Atlas = {
    name: opts.name ?? image.ref,
    imageRef: image.ref,
    size: page.size ?? info.size,
    sprites: page.sprites,
    source: { kind: 'spine' },
  };
  if (page.format) atlas.format = page.format;
  const imageAsset: ImageAsset = {
    name: atlas.name,
    imageRef: image.ref,
    size: info.size,
    mime: info.mime,
    byteSize: image.bytes.byteLength,
  };
  return { ok: true, asset: { kind: 'atlas', atlas, image: imageAsset } };
}
