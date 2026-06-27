// Format/resolution variant grouping. A project commonly ships one logical asset as
// <name>_<res>[_<fmt>] across formats (png/webp/avif) and resolutions (540p/720p/1080p). At
// runtime ONE variant loads per asset, so summing every variant's VRAM over-counts by up to ~9×.
// We group by name-stem + aspect ratio (resolution variants keep their proportions), then report
// the realistic loaded VRAM as a range: format variants are VRAM-identical (counted once);
// resolution variants load one tier per device (min..max across the group).

import type { Asset, Finding, Size } from '@asset-doctor/core';
import { fmtBytes, vramBytes } from './rules';

// Strip the extension, then peel resolution/format tokens off the end (in any order).
const TOKEN = /[_-](\d{2,4}p|@?\d+x|hd|sd|png|webp|avif|jpe?g)$/i;
const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i + 1);
};
const baseOf = (p: string): string => p.split('/').pop() ?? p;

/** The directory-relative variant stem. Inputs are now dir-aware (e.g. "ui/hero_1080p.png"), so we
 *  STRIP the directory before peeling tokens off the BASENAME, then re-prefix the directory — a
 *  path-prefixed name is never mis-stemmed, yet two same-stem files in different folders stay
 *  distinct (their stems differ by the dir prefix). */
export function stemOf(name: string): string {
  const dir = dirOf(name);
  let s = baseOf(name).toLowerCase().replace(/\.[a-z0-9]+$/, '');
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(TOKEN, '');
  }
  return dir + s;
}

interface VItem {
  name: string;
  size: Size;
}
const aspectBucket = (s: Size): number => (s.h > 0 ? Math.round((s.w / s.h) * 50) : 0);

export interface VariantGroups {
  /** Groups with >1 member (i.e. actual variant sets). */
  groups: { stem: string; members: VItem[] }[];
  summedVram: number;
  loadedVramMin: number;
  loadedVramMax: number;
  variantFiles: number;
}

export function groupVariants(assets: Asset[]): VariantGroups {
  const items: VItem[] = assets.map((a) =>
    a.kind === 'atlas' ? { name: a.atlas.name, size: a.atlas.size } : { name: a.image.name, size: a.image.size },
  );

  const buckets = new Map<string, VItem[]>();
  for (const it of items) {
    const key = `${stemOf(it.name)}|${aspectBucket(it.size)}`;
    const arr = buckets.get(key);
    if (arr) arr.push(it);
    else buckets.set(key, [it]);
  }

  let summedVram = 0;
  let loadedVramMin = 0;
  let loadedVramMax = 0;
  let variantFiles = 0;
  const groups: { stem: string; members: VItem[] }[] = [];

  for (const [key, members] of buckets) {
    const vrams = members.map((m) => vramBytes(m.size));
    summedVram += vrams.reduce((s, v) => s + v, 0);
    loadedVramMax += Math.max(...vrams); // one variant loads: at worst the largest tier
    loadedVramMin += Math.min(...vrams); // at best the smallest tier
    if (members.length > 1) {
      variantFiles += members.length;
      groups.push({ stem: key.split('|')[0] ?? key, members });
    }
  }

  return { groups, summedVram, loadedVramMin, loadedVramMax, variantFiles };
}

export function variantsFinding(v: VariantGroups): Finding | null {
  if (v.groups.length === 0) return null;
  const inflation = v.summedVram - v.loadedVramMax;
  if (inflation <= 0) return null;
  return {
    id: 'folder:variants',
    rule: 'variants',
    severity: 'warn',
    scope: 'folder',
    assetRef: v.groups[0]?.stem ?? 'variants',
    relatedRefs: v.groups.slice(0, 12).map((g) => g.stem),
    title: `Format/resolution variants inflate VRAM`,
    detail:
      `${v.variantFiles} variant files across ${v.groups.length} logical images. At runtime one ` +
      `variant loads per image, so GPU VRAM is ~${fmtBytes(v.loadedVramMin)}–${fmtBytes(v.loadedVramMax)} ` +
      `(one resolution tier), not ${fmtBytes(v.summedVram)}. Format variants (png/webp/avif) are ` +
      `identical in VRAM — ship one per platform; resolution variants load one tier per device.`,
    fix: 'Serve one format per platform and one resolution tier per device; don’t treat all variants as concurrent VRAM.',
    estimate: { vramBytesSaved: inflation },
    messageKey: 'variants',
    params: { variantFiles: v.variantFiles, groups: v.groups.length, loadedMin: v.loadedVramMin, loadedMax: v.loadedVramMax, summed: v.summedVram },
  };
}
