// Parse Spine / libGDX `.atlas` text sheets into the normalized @asset-doctor/core Atlas model.
// One Atlas per page (a .atlas may hold several page images). Pure & defensive: the text parser
// never throws. Handles the legacy region format (rotate/xy/size/orig/offset) and the modern one
// (bounds/offsets). Page boundaries follow the CANONICAL libGDX/spine-ts contract: pages are
// separated by BLANK lines (a blank line closes the current page; the next non-blank line names the
// next page image). The old `size:`-lookahead heuristic mis-split real files both ways — a size-less
// legacy multi-page atlas collapsed into one page (page-2 regions landed on page 1's coordinates),
// and a region whose first key happened to be `size:` was misread as a new page (P3 parsers audit).

import type { Atlas, ImageAsset, Rect, Size, Sprite } from '@asset-doctor/core';
import type { ParseResult } from './types';
import { readImageInfo, strippableMetadataBytes } from './image-size';
import { iccAssetField } from './icc';

export interface SpinePage {
  image: string;
  size?: Size;
  format?: string;
  /** Page `scale:` factor (Spine "scaled variants" export). Carried onto Atlas.scale — dropping it made
   *  downstream oversize/variant math treat a 0.5× page as 1× (P3 parsers audit #8). */
  scale?: number;
  sprites: Sprite[];
  /** Regions on THIS page that named an asset but were unusable (a required field — xy/size/orig/bounds —
   *  had a non-finite OR non-positive value, or the region fell outside the page). Per-region recovery: the page keeps its
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
  /** modern `offsets: offsetX, offsetY, origW, origH` — ALL FOUR carried. x/y are the trim offset within
   *  the original (spine-ts reads them exactly so); dropping them zeroed every modern trimmed region's
   *  offset and the fix-path re-emit shipped `offset: 0, 0` — sprites rendered shifted in-engine (P3 #1). */
  offsets?: { x: number; y: number; w: number; h: number };
  /** legacy `offset: x, y` — the trimmed region's offset within the original. */
  offset?: { x: number; y: number };
  /** Set when a REQUIRED field had a non-finite OR non-positive value — the region is dropped + surfaced
   *  (not silently coerced to 0 or kept degenerate, which would fabricate a placement). First failure wins (??=). */
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
  } else if (key === 'scale') {
    // fractional (e.g. `scale: 0.5`) — parseFloat, NOT the integer numsRaw. Only a finite positive
    // factor is carried; garbage stays absent (never a fabricated 1× or 0×).
    const s = parseFloat(val.trim());
    if (Number.isFinite(s) && s > 0) page.scale = s;
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
    // Require BOTH finite AND > 0: a zero/negative region size is a degenerate placement (a 0×0 or
    // negative frame), not a usable sprite. Reject + surface honestly rather than fabricate a positive
    // size — mirrors the page `size:` guard (applyPageKey) and readRect's w<=0/h<=0 guard.
    if (!fin(n[0]) || !fin(n[1])) r.malformed ??= `region "${r.name}": non-finite size "${val.trim()}"`;
    else if (n[0]! <= 0 || n[1]! <= 0) r.malformed ??= `region "${r.name}": non-positive size "${val.trim()}"`;
    else r.size = { w: n[0]!, h: n[1]! };
  } else if (key === 'orig') {
    // orig is the ORIGINAL (untrimmed) size — like `size`, a zero/negative value would fabricate a
    // degenerate sourceSize AND a phantom `trimmed:true`; reject + surface (P3 audit #4 symmetry).
    if (!fin(n[0]) || !fin(n[1])) r.malformed ??= `region "${r.name}": non-finite orig "${val.trim()}"`;
    else if (n[0]! <= 0 || n[1]! <= 0) r.malformed ??= `region "${r.name}": non-positive orig "${val.trim()}"`;
    else r.orig = { w: n[0]!, h: n[1]! };
  } else if (key === 'bounds') {
    // bounds = x,y,w,h. x/y are placement coords (0 is valid); w/h must be finite AND > 0 (same reason
    // as `size` above — bounds supplies the frame w/h in toSprite when there is no `size` token).
    if (!fin(n[0]) || !fin(n[1]) || !fin(n[2]) || !fin(n[3]))
      r.malformed ??= `region "${r.name}": non-finite bounds "${val.trim()}"`;
    else if (n[2]! <= 0 || n[3]! <= 0) r.malformed ??= `region "${r.name}": non-positive bounds "${val.trim()}"`;
    else r.bounds = { x: n[0]!, y: n[1]!, w: n[2]!, h: n[3]! };
  } else if (key === 'offsets') {
    // MODERN `offsets: offsetX, offsetY, origW, origH` — the original-size carrier, NOT an optional
    // offset. All four must be finite and origW/origH positive; a short/garbage token used to default
    // n[2]/n[3] to 0, fabricating `sourceSize {0,0}` + a phantom `trimmed:true` (P3 audit #4). Reject +
    // surface instead — never fabricate a default for a required field.
    if (!fin(n[0]) || !fin(n[1]) || !fin(n[2]) || !fin(n[3]))
      r.malformed ??= `region "${r.name}": non-finite offsets "${val.trim()}"`;
    else if (n[2]! <= 0 || n[3]! <= 0) r.malformed ??= `region "${r.name}": non-positive offsets "${val.trim()}"`;
    else r.offsets = { x: n[0]!, y: n[1]!, w: n[2]!, h: n[3]! };
  } else if (key === 'offset') {
    r.offset = { x: Number.isFinite(n[0]) ? n[0]! : 0, y: Number.isFinite(n[1]) ? n[1]! : 0 };
  }
}

/** A region must resolve BOTH a placement (xy or bounds) AND a frame extent (size or bounds) — a region
 *  with neither is not a usable sprite, and defaulting to 0×0 used to push a phantom degenerate sprite
 *  with NO malformed surface (P3 audit #3: the silence that also masked mis-split pages). */
function missingGeometry(r: RegionAcc): string | null {
  if (r.xy === undefined && r.bounds === undefined) return `region "${r.name}": missing xy/bounds`;
  if (r.size === undefined && r.bounds === undefined) return `region "${r.name}": missing size/bounds`;
  return null;
}

function toSprite(r: RegionAcc): Sprite {
  const x = r.xy?.x ?? r.bounds!.x;
  const y = r.xy?.y ?? r.bounds!.y;
  const w = r.size?.w ?? r.bounds!.w;
  const h = r.size?.h ?? r.bounds!.h;
  // frame = packed rect AS PLACED in the page (w/h swapped when rotated 90°/270°)
  const frame: Rect = r.rotated ? { x, y, w: h, h: w } : { x, y, w, h };
  const sourceSize: Size = r.orig ?? (r.offsets ? { w: r.offsets.w, h: r.offsets.h } : { w, h });
  const trimmed = sourceSize.w !== w || sourceSize.h !== h;
  const sprite: Sprite = { name: r.name, frame, rotated: r.rotated, trimmed, sourceSize };
  // a trimmed region carries its offset within the original (so a repack can re-emit it). The MODERN
  // format puts that offset in `offsets[0..1]` (offsetX, offsetY — spine-ts reads them exactly so);
  // the legacy format in `offset:`. Discarding the modern pair zeroed every 4.x trimmed region's
  // offset and the repack re-emitted `offset: 0, 0` — shifted sprites in-engine (P3 audit #1).
  if (trimmed) sprite.spriteSourceSize = { x: r.offset?.x ?? r.offsets?.x ?? 0, y: r.offset?.y ?? r.offsets?.y ?? 0, w, h };
  return sprite;
}

export function parseSpineAtlasText(text: string): SpinePage[] {
  const pages: SpinePage[] = [];
  const lines = text.split(/\r?\n/);
  let page: SpinePage | null = null;
  let region: RegionAcc | null = null;

  const flushRegion = () => {
    if (page && region) {
      const missing = missingGeometry(region);
      if (region.malformed || missing) {
        (page.malformedRegions ??= []).push({ name: region.name, reason: region.malformed ?? missing! });
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

  // CANONICAL page detection (libGDX TextureAtlasData / spine-ts TextureAtlas contract): a BLANK line
  // closes the current page; the first non-blank line while no page is open names the next page image.
  // Every non-blank line inside a page is a key line (contains `:`) or a region name. This replaces the
  // old `size:`-lookahead, which mis-split real files both ways (P3 audit #2/#6): a size-less legacy
  // multi-page atlas collapsed into ONE page (page 2's image became a phantom 0×0 sprite and its regions
  // landed on page 1), and a region whose first key was `size:` was misread as a new page.
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === '') {
      // blank line = the page-separator token. Close the open region AND the page.
      flushRegion();
      page = null;
      continue;
    }
    const m = t.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/);

    if (m && page === null) continue; // a key line before any page header — orphaned noise, no page to blame
    if (m && PAGE_KEYS.has(m[1]!) && region === null) {
      if (page) applyPageKey(page, m[1]!, m[2]!);
      continue;
    }
    if (m && REGION_KEYS.has(m[1]!)) {
      if (region) applyRegionKey(region, m[1]!, m[2]!);
      else if (page) {
        // Orphaned region geometry — its name line was swallowed as something else (e.g. a region named
        // with a colon parses as an unknown key). Surface it instead of silently vanishing (P3 audit #7).
        (page.malformedRegions ??= []).push({ name: t, reason: `orphaned region key "${t}" (no open region)` });
      }
      continue;
    }
    if (m) continue; // unknown key inside a page/region — forward-compat tolerance (libGDX skips too)
    // bare (colon-less) line: a page image when no page is open (file start / after a blank line),
    // else a region name on the current page.
    flushRegion();
    if (page === null) {
      page = { image: t, sprites: [] };
      pages.push(page);
    } else {
      region = { name: t, rotated: false };
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
  if (page.scale !== undefined) atlas.scale = page.scale; // P3 #8: a 0.5× page is not a 1× page
  const strippable = strippableMetadataBytes(image.bytes);
  const icc = iccAssetField(image.bytes);
  const imageAsset: ImageAsset = {
    name: atlas.name,
    imageRef: image.ref,
    size: info.size,
    mime: info.mime,
    byteSize: image.bytes.byteLength,
    ...(strippable > 0 ? { strippableBytes: strippable } : {}),
    ...(icc ? { icc } : {}),
  };
  return { ok: true, asset: { kind: 'atlas', atlas, image: imageAsset } };
}
