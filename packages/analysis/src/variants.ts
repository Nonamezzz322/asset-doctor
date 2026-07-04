// Format/resolution variant grouping. A project commonly ships one logical asset as
// <name>_<res>[_<fmt>] across formats (png/webp/avif) and resolutions (540p/720p/1080p). At
// runtime ONE variant loads per asset, so summing every variant's VRAM over-counts by up to ~9×.
// We group by name-stem + aspect ratio (resolution variants keep their proportions), then report
// the realistic loaded VRAM as a range: format variants are VRAM-identical (counted once);
// resolution variants load one tier per device (min..max across the group).

import type { Asset, Finding, ImageMime, Size } from '@asset-doctor/core';
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
  /** Texture PAGES this variant BINDS when loaded — a loose image = 1; an atlas = 1, because the
   *  normalized model is one Atlas per texture PAGE (multi-page atlases are split into one Atlas per page
   *  at parse — spine-atlas.ts "One Atlas per page"), so there is no multi-page count to fabricate. Kept
   *  per-item so the loaded-texture (draw-call-floor) count is page-accurate for what the folder actually
   *  contains AND future-proof the day the model exposes a real multi-page count. */
  pages: number;
}
const aspectBucket = (s: Size): number => (s.h > 0 ? Math.round((s.w / s.h) * 50) : 0);

// Resolution-only subset of TOKEN (EXCLUDES the format tokens png|webp|avif|jpeg): a true resolution
// tier suffix. Matched against the ext-stripped basename's trailing token.
const RES_TOKEN = /[_-](\d{2,4}p|@?\d+x|hd|sd)$/i;

/** True when a name is one RESOLUTION TIER of a logical asset — i.e. a resolution token
 *  (720p / @2x / hd / sd) appears among its trailing tokens, EVEN when a format suffix
 *  (_webp / _avif / _jpg) trails it ("hero_1080p_webp"). A format-only name ("sprite_webp")
 *  is NOT a tier. Checking only the LAST token (old behavior) mis-read every
 *  `<stem>_<res>_<fmt>` file as a non-tier, splitting one logical image across two variant
 *  buckets and ~2× over-counting loaded VRAM. Peels res OR format tokens off the end one at a
 *  time (mirroring stemOf); any peeled token that IS a res token ⇒ tier. */
export function hasResolutionToken(name: string): boolean {
  let base = baseOf(name).toLowerCase().replace(/\.[a-z0-9]+$/, '');
  let prev = '';
  while (base !== prev) {
    prev = base;
    const tok = base.match(TOKEN); // peel res OR format tokens off the end, one at a time
    if (tok && RES_TOKEN.test(tok[0])) return true; // any peeled token that IS a res token ⇒ tier
    base = base.replace(TOKEN, '');
  }
  return false;
}

export interface VariantGroups {
  /** Groups with >1 member (i.e. actual variant sets). */
  groups: { stem: string; members: VItem[] }[];
  summedVram: number;
  loadedVramMin: number;
  loadedVramMax: number;
  variantFiles: number;
  /** Distinct LOGICAL images = bucket count after variant clustering (one bucket per stem+aspect /
   *  resolution-stem key). `logicalImages ≤ assets.length` ALWAYS (a partition can only merge). This is
   *  the runtime-honest count: at runtime ONE variant loads per logical image, so this — not the raw file
   *  count — is the true texture-bind / draw-call count. Inert to `variantsFinding`/analyze (unread there);
   *  consumed by `shouldAtlasFinding` to gate & report the loose-sprite count honestly. */
  logicalImages: number;
  /** STRUCTURAL draw-call FLOOR: distinct loaded GPU textures over the SAME loaded set as loadedVramMax —
   *  the ONE variant that loads per bucket (the max-VRAM tier) contributes its `pages` (loose=1, atlas=1
   *  in the one-Atlas-per-page model). Numerically == logicalImages while every page count is 1, but kept
   *  page-summed (not a bucket count) so it stays honest & page-accurate if the model ever exposes real
   *  multi-page atlases. A LOWER BOUND on draw calls — NEVER the measured probe.drawCalls (surfaced on
   *  totals as loadedTextures). Same population as loadedVramMax ⇒ the two can never drift. */
  loadedTextures: number;
}

export function groupVariants(assets: Asset[]): VariantGroups {
  const items: VItem[] = assets.map((a) =>
    // pages: one Atlas === one texture page (multi-page atlases are already one-Atlas-per-page from the
    // parser); a loose image is one texture. Never a fabricated page count — see VItem.pages.
    a.kind === 'atlas'
      ? { name: a.atlas.name, size: a.atlas.size, pages: 1 }
      : { name: a.image.name, size: a.image.size, pages: 1 },
  );

  const buckets = new Map<string, VItem[]>();
  for (const it of items) {
    // Resolution variants cluster by stem ALONE: independently-rounded tiers (e.g. 100×50 → _720p
    // 75×38) land in different aspect buckets (round(w/h·50) is 100 vs 99), so keeping aspectBucket
    // would split one logical asset and over-count loaded VRAM. Non-resolution names keep the
    // stem|aspectBucket key (genuine same-stem-different-aspect collisions stay distinct).
    const key = hasResolutionToken(it.name)
      ? stemOf(it.name)
      : `${stemOf(it.name)}|${aspectBucket(it.size)}`;
    const arr = buckets.get(key);
    if (arr) arr.push(it);
    else buckets.set(key, [it]);
  }

  let summedVram = 0;
  let loadedVramMin = 0;
  let loadedVramMax = 0;
  let variantFiles = 0;
  let loadedTextures = 0;
  const groups: { stem: string; members: VItem[] }[] = [];

  for (const [key, members] of buckets) {
    const vrams = members.map((m) => vramBytes(m.size));
    summedVram += vrams.reduce((s, v) => s + v, 0);
    const maxV = Math.max(...vrams);
    loadedVramMax += maxV; // one variant loads: at worst the largest tier
    loadedVramMin += Math.min(...vrams); // at best the smallest tier
    // Draw-call FLOOR: the SAME one variant loadedVramMax counts (the max-VRAM tier — first max wins,
    // deterministic; ties are page-equal in the single-page model) binds `pages` textures. Summed over
    // the identical loaded set as loadedVramMax, never a separate dedup.
    loadedTextures += members[vrams.indexOf(maxV)]!.pages;
    if (members.length > 1) {
      variantFiles += members.length;
      groups.push({ stem: key.split('|')[0] ?? key, members });
    }
  }

  return { groups, summedVram, loadedVramMin, loadedVramMax, variantFiles, logicalImages: buckets.size, loadedTextures };
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

/* ── Format-only sibling clusters (browser-only presentation input) ──────────────────────────────
 * A TIGHTER cousin of groupVariants used ONLY by the presentation-layer format-demotion marker: it
 * clusters files that are the SAME logical image shipped in ≥2 formats (icon.png + icon.avif). Unlike
 * groupVariants (which tolerates aspect-bucket rounding to keep resolution TIERS together), a format
 * sibling must match on EXACT w×h — two files sharing a stem but differing in dimensions are NOT the
 * same image. Resolution-tier files (hasResolutionToken) are excluded outright: a _540p/_1080p pair is
 * a real ladder, not a redundant format pair. Pure, worker-safe, ZERO finding/estimate side effects. */

/** One format-only variant cluster: the SAME logical image (same dir-aware stem, exact dims, no
 *  resolution token) shipped in ≥2 distinct image formats. */
export interface FormatSiblingGroup {
  /** Dir-aware stem (via the existing stemOf), shared by every member. */
  stem: string;
  /** Members carrying each file's ref + on-disk mime (the demotion guard reads the mime). Sorted by ref. */
  members: { ref: string; mime: ImageMime }[];
}

interface FItem {
  ref: string;
  mime: ImageMime;
  size: Size;
}

/** Format-ONLY variant clusters: same dir-aware stem (existing stemOf), hasResolutionToken === false for
 *  ALL members, EXACT w==w && h==h for ALL members, and ≥2 DISTINCT image mimes. Each member maps to
 *  { ref, mime: image.mime, size } exactly as groupVariants does (atlas → atlas.name + atlas.size; loose →
 *  image.name + image.size). Members within a group are sorted by ref.localeCompare, and the group list is
 *  itself deterministically ordered (stem then first ref). Pure. */
export function formatSiblingGroups(assets: Asset[]): FormatSiblingGroup[] {
  const items: FItem[] = assets
    .map((a) =>
      a.kind === 'atlas'
        ? { ref: a.atlas.name, mime: a.image.mime, size: a.atlas.size }
        : { ref: a.image.name, mime: a.image.mime, size: a.image.size },
    )
    .filter((it) => !hasResolutionToken(it.ref));

  // Bucket by dir-aware stem + EXACT w×h (the exact-dims sub-bucket is the tightening over
  // groupVariants' aspectBucket: a 100×50 and a 50×100 share a stem but are not the same image).
  const buckets = new Map<string, FItem[]>();
  for (const it of items) {
    const key = `${stemOf(it.ref)}|${it.size.w}x${it.size.h}`;
    const arr = buckets.get(key);
    if (arr) arr.push(it);
    else buckets.set(key, [it]);
  }

  const groups: FormatSiblingGroup[] = [];
  for (const members of buckets.values()) {
    const mimes = new Set(members.map((m) => m.mime));
    if (mimes.size < 2) continue; // needs ≥2 DISTINCT formats to be a format-sibling cluster
    const sorted = [...members].sort((a, b) => a.ref.localeCompare(b.ref));
    groups.push({ stem: stemOf(sorted[0]!.ref), members: sorted.map((m) => ({ ref: m.ref, mime: m.mime })) });
  }
  groups.sort((a, b) => a.stem.localeCompare(b.stem) || a.members[0]!.ref.localeCompare(b.members[0]!.ref));
  return groups;
}

/** The refs whose per-file `format` finding is REDUNDANT because a sibling in the SAME format-only cluster
 *  already ships in the format the finding recommends (finding.params.bestMime — the MEASURED smallest-encode
 *  winner). Consumes the format findings so it reads each one's measured bestMime; returns a Set<assetRef>.
 *  Pure, deterministic, no side effects. */
export function redundantFormatRefs(assets: Asset[], formatFindings: Finding[]): Set<string> {
  // ref → the FULL mime set of the format-only cluster it belongs to (a ref not in any cluster is absent).
  const mimesByRef = new Map<string, Set<string>>();
  for (const g of formatSiblingGroups(assets)) {
    const mimes = new Set<string>(g.members.map((m) => m.mime));
    for (const m of g.members) mimesByRef.set(m.ref, mimes);
  }
  const out = new Set<string>();
  for (const f of formatFindings) {
    const best = f.params?.bestMime;
    if (typeof best !== 'string') continue; // only a MEASURED target counts
    if (mimesByRef.get(f.assetRef)?.has(best)) out.add(f.assetRef);
  }
  return out;
}
