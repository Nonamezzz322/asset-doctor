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
}

interface RegionAcc {
  name: string;
  rotated: boolean;
  xy?: { x: number; y: number };
  size?: { w: number; h: number };
  orig?: { w: number; h: number };
  bounds?: Rect;
  offsets?: { w: number; h: number };
}

const ints = (v: string): number[] =>
  v
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));

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
    const [w, h] = ints(val);
    if (w && h) page.size = { w, h };
  } else if (key === 'format') {
    page.format = val.trim();
  }
}

function applyRegionKey(r: RegionAcc, key: string, val: string): void {
  const n = ints(val);
  if (key === 'rotate') r.rotated = rotatedFrom(val);
  else if (key === 'xy') r.xy = { x: n[0] ?? 0, y: n[1] ?? 0 };
  else if (key === 'size') r.size = { w: n[0] ?? 0, h: n[1] ?? 0 };
  else if (key === 'orig') r.orig = { w: n[0] ?? 0, h: n[1] ?? 0 };
  else if (key === 'bounds') r.bounds = { x: n[0] ?? 0, y: n[1] ?? 0, w: n[2] ?? 0, h: n[3] ?? 0 };
  else if (key === 'offsets') r.offsets = { w: n[2] ?? 0, h: n[3] ?? 0 };
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
  return { name: r.name, frame, rotated: r.rotated, trimmed, sourceSize };
}

export function parseSpineAtlasText(text: string): SpinePage[] {
  const pages: SpinePage[] = [];
  const lines = text.split(/\r?\n/);
  let page: SpinePage | null = null;
  let region: RegionAcc | null = null;

  const flushRegion = () => {
    if (page && region) page.sprites.push(toSprite(region));
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
