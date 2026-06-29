// @asset-doctor/ingest — group imported files into atlases (manifest/spine + image) and standalone
// images. Pure and env-agnostic (TextDecoder only) so it runs in a worker, the web app, or a browser
// extension. Manifest→image is resolved within the manifest's OWN directory (via path) — which also
// lets Spine `.atlas` sheets reference page images across directories (../). Falls back to global
// basename for flat uploads. Supports TexturePacker/Pixi JSON manifests and Spine/libGDX `.atlas`.

import { parseSpineAtlasText, parseFntText, type SpinePage, type FntPage } from '@asset-doctor/parsers';
import type { LooseRegion, PackGroup, Size, ThresholdConfig } from '@asset-doctor/core';

export interface RawFile {
  name: string;
  bytes: ArrayBuffer;
  /** Relative path within the imported folder, if known — enables directory-aware matching. */
  path?: string;
}

export interface GroupedAtlas {
  /** 'manifest' = TexturePacker/Pixi JSON; 'spine' = a parsed Spine page; 'bmfont' = a parsed BMFont
   *  (.fnt TEXT) glyph page. */
  kind: 'manifest' | 'spine' | 'bmfont';
  manifest: unknown;
  image: RawFile;
  name: string;
}

export interface Grouped {
  atlases: GroupedAtlas[];
  images: RawFile[];
  /** Manifests whose referenced image is missing from the folder. */
  missing: { manifest: string; image: string }[];
  /** Files that LOOK like an asset manifest but could not be used — surfaced honestly (symmetric with
   *  the fix engine's skipped[]), NEVER benign non-asset files. The "looks like a manifest but unusable"
   *  cases: a `.atlas` that threw, a `.json` that failed JSON.parse, a manifest with frames but no
   *  meta.image, or a `.fnt` that is XML/binary (not TEXT BMFont) / parsed empty. `ref` = basename.
   *  Sorted by ref; additive (absent/empty ⇒ byte-identical). */
  unparsed: { ref: string; reason: string }[];
}

const IMAGE_RE = /\.(png|webp|jpe?g|avif)$/i;
const baseName = (p: string): string => p.split('/').pop() ?? p;
const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

/** Canonicalize a folder-relative path: collapse `.`/empty segments, resolve `..`, normalize to `/`.
 *  The ONE normalizer for dir-aware keying — reused by the web app and both workers so a loose asset
 *  is keyed identically everywhere (no second hand-rolled normalizer). */
export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** The dir-aware key for a file: its normalized folder-relative path (basename fallback for flat
 *  uploads with no path). This is THE asset-keying function — use it for the loose-image assetRef, the
 *  worker byte/path/vram maps, the analysis features key, and the web app's fileMap + viewer selection
 *  so two same-basename files in different folders never collide. */
export const keyOf = (f: RawFile): string => normalizePath(f.path ?? f.name);

function looksLikeManifest(json: unknown): boolean {
  if (typeof json !== 'object' || json === null) return false;
  const frames = (json as Record<string, unknown>).frames;
  return Array.isArray(frames) || (typeof frames === 'object' && frames !== null);
}

function manifestImage(json: unknown): string | undefined {
  const meta = (json as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  const image = (meta as Record<string, unknown>).image;
  return typeof image === 'string' ? image : undefined;
}

export function groupFiles(files: RawFile[]): Grouped {
  const byBase = new Map<string, RawFile>();
  const byPath = new Map<string, RawFile>();
  for (const f of files) {
    byBase.set(baseName(f.name), f);
    byPath.set(keyOf(f), f);
  }

  const referenced = new Set<string>();
  const atlases: GroupedAtlas[] = [];
  const missing: { manifest: string; image: string }[] = [];
  // Honest "looks like a manifest but unusable" surface (NOT benign non-asset files — see :111/:118).
  const unparsed: { ref: string; reason: string }[] = [];
  const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  const resolve = (manifestPath: string | undefined, imageName: string): RawFile | undefined => {
    const dirHit = manifestPath ? byPath.get(normalizePath(`${dirOf(manifestPath)}/${imageName}`)) : undefined;
    return dirHit ?? byBase.get(baseName(imageName));
  };
  const atlasName = (image: RawFile): string => (image.path ? keyOf(image) : baseName(image.name));

  for (const f of files) {
    // Spine / libGDX .atlas text sheets (one or more pages).
    if (/\.atlas$/i.test(f.name)) {
      let pages: SpinePage[];
      try {
        pages = parseSpineAtlasText(new TextDecoder().decode(f.bytes));
      } catch (e) {
        unparsed.push({ ref: baseName(f.name), reason: `Spine .atlas parse failed: ${msg(e)}` });
        continue;
      }
      for (const page of pages) {
        const image = resolve(f.path, page.image);
        if (!image) {
          missing.push({ manifest: baseName(f.name), image: baseName(page.image) });
          continue;
        }
        referenced.add(keyOf(image));
        atlases.push({ kind: 'spine', manifest: page, image, name: atlasName(image) });
      }
      continue;
    }

    // AngelCode BMFont .fnt glyph sheets (TEXT format; one or more page images). XML (leading `<`) and
    // binary (`BMF\x03`) .fnt are a different serialization we don't parse in v1 — surfaced honestly in
    // unparsed[], NEVER silently dropped (same honesty contract as the `.atlas` / `.json` skip-points).
    if (/\.fnt$/i.test(f.name)) {
      const text = new TextDecoder().decode(f.bytes);
      // Binary BMFont starts with the magic `BMF` + version byte 3 (0x03); XML BMFont starts with `<`.
      // Both are a different serialization we don't parse in v1 — surface honestly, never silent-drop.
      const isBinaryBmf = text.startsWith('BMF') && text.charCodeAt(3) === 3;
      if (text.trimStart().startsWith('<') || isBinaryBmf) {
        unparsed.push({ ref: baseName(f.name), reason: 'BMFont .fnt not in TEXT format (XML/binary unsupported in v1)' });
        continue;
      }
      let pages: FntPage[];
      try {
        pages = parseFntText(text);
      } catch (e) {
        unparsed.push({ ref: baseName(f.name), reason: `BMFont .fnt parse failed: ${msg(e)}` });
        continue;
      }
      if (pages.length === 0) {
        unparsed.push({ ref: baseName(f.name), reason: 'BMFont .fnt has no page/char lines' });
        continue;
      }
      for (const page of pages) {
        const image = resolve(f.path, page.image);
        if (!image) {
          missing.push({ manifest: baseName(f.name), image: baseName(page.image) });
          continue;
        }
        referenced.add(keyOf(image));
        atlases.push({ kind: 'bmfont', manifest: page, image, name: atlasName(image) });
      }
      continue;
    }

    // TexturePacker / Pixi JSON manifests.
    if (!/\.json$/i.test(f.name)) continue;
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(f.bytes));
    } catch (e) {
      unparsed.push({ ref: baseName(f.name), reason: `manifest JSON parse failed: ${msg(e)}` });
      continue;
    }
    if (!looksLikeManifest(json)) continue; // a .json config / non-manifest is legitimately not an asset — stay silent
    const imageName = manifestImage(json);
    if (!imageName) {
      unparsed.push({ ref: baseName(f.name), reason: 'manifest has frames but no meta.image' });
      continue;
    }
    const image = resolve(f.path, imageName);
    if (!image) {
      missing.push({ manifest: baseName(f.name), image: baseName(imageName) });
      continue;
    }
    referenced.add(keyOf(image));
    atlases.push({ kind: 'manifest', manifest: json, image, name: atlasName(image) });
  }

  const images = files.filter((f) => IMAGE_RE.test(f.name) && !referenced.has(keyOf(f)));
  unparsed.sort((a, b) => a.ref.localeCompare(b.ref));
  return { atlases, images, missing, unparsed };
}

/* ── Feature 4: group loose images into pack groups (design §4) ─────────────────────────────────
 * A deterministic, dir-aware helper that turns loose image refs into PackGroup[] for the pack fix.
 * It is RE-DERIVED, not finding-driven: it independently re-applies `shouldAtlas.maxSpriteEdgePx`
 * per image (the SAME predicate `shouldAtlasFinding` uses) and never reads the should-atlas finding's
 * relatedRefs. SPINE roots are detected FIRST (correctness > efficiency): a directory holding a
 * `.skel`, a skeleton `.json` (top-level skeleton+bones+slots, NOT frames/meta.image), or matching the
 * `animations/<name>` | `spine/<name>` convention becomes one spine PackGroup; everything else groups
 * into STATIC sheets (one per leaf folder by default). Pure: no DOM/canvas/Node-FS — TextDecoder only
 * (same as groupFiles), no Date.now / Math.random. */

/** A loose image candidate for packing. `ref` = dir-aware key (keyOf); `size` = its full pixel size
 *  (drives the per-image maxSpriteEdgePx re-application). */
export interface LooseImage {
  ref: string;
  size: Size;
}

export type PackMode = 'auto' | 'force-static' | 'force-spine';
export type StaticGranularity = 'per-leaf-folder' | 'one-sheet-for-all' | 'per-top-level-bundle';

export interface GroupLooseOptions {
  /** Thresholds (shouldAtlas.maxSpriteEdgePx + minLooseImages) — re-applied per image (§4). */
  thresholds: ThresholdConfig;
  /** Auto (spine where a skeleton is detected) | force static | force spine. Default 'auto'. */
  mode?: PackMode;
  /** Static sheet output granularity (§4c). Default 'per-leaf-folder'. */
  granularity?: StaticGranularity;
  /** Bypass the minLooseImages floor (a forced 1-region sheet is valid). Default false. */
  forced?: boolean;
  /** Spine folder-convention prefixes (configurable; default ['animations', 'spine'] per §4a). */
  spineConventions?: string[];
}

/** Two distinct loose source files resolving to the SAME region name within one group — surfaced so the
 *  worker never silently overwrites one with the other. (Multiple skeleton slots sharing one region is
 *  NOT a collision and is never reported here; that is the worker verifier's concern.) */
export interface RegionCollision {
  groupId: string;
  name: string;
  /** The colliding refs (sorted), e.g. items/sword.png + items/sword.webp → 'items/sword'. */
  refs: string[];
}

export interface GroupLooseResult {
  groups: PackGroup[];
  /** File→region name collisions (two distinct files, one region name). */
  collisions: RegionCollision[];
}

/** Strip the image extension from a dir-aware ref, slash-preserved (the region/frame name). */
function stripImageExt(ref: string): string {
  return ref.replace(IMAGE_RE, '');
}

/** Path relative to a root directory (root is a normalized dir; '' = repo root). Slash-preserved.
 *  Assumes `ref` is already under `root` (the caller guarantees this). */
function relativeTo(ref: string, root: string): string {
  if (root === '') return ref;
  return ref.startsWith(`${root}/`) ? ref.slice(root.length + 1) : ref;
}

/** Longest common ancestor DIRECTORY of a set of dir-aware refs. '' = repo root. */
function commonAncestorDir(refs: string[]): string {
  if (refs.length === 0) return '';
  const dirs = refs.map((r) => dirOf(r).split('/').filter(Boolean));
  let common = dirs[0]!;
  for (let i = 1; i < dirs.length; i++) {
    const d = dirs[i]!;
    let k = 0;
    while (k < common.length && k < d.length && common[k] === d[k]) k++;
    common = common.slice(0, k);
    if (common.length === 0) break;
  }
  return common.join('/');
}

/** Detect whether a parsed JSON object is a Spine skeleton (top-level skeleton+bones+slots).
 *  Defensive: explicitly NOT a TexturePacker/Pixi manifest (those carry frames/meta.image). */
function looksLikeSkeleton(json: unknown): boolean {
  if (typeof json !== 'object' || json === null) return false;
  const o = json as Record<string, unknown>;
  if ('frames' in o || 'meta' in o) return false; // TexturePacker / Pixi, not a skeleton
  return (
    typeof o.skeleton === 'object' &&
    o.skeleton !== null &&
    (Array.isArray(o.bones) || typeof o.bones === 'object') &&
    o.bones !== null &&
    (Array.isArray(o.slots) || typeof o.slots === 'object') &&
    o.slots !== null
  );
}

/** Match the `animations/<name>` | `spine/<name>` directory convention against a normalized dir path.
 *  Returns the spine-root dir (`<prefix>/<name>`) when a path segment equals a convention prefix and at
 *  least one more segment follows; else null. The DEEPEST (last) match wins so a nested convention root
 *  is honored. */
function conventionRoot(dir: string, prefixes: string[]): string | null {
  const segs = dir.split('/').filter(Boolean);
  let root: string | null = null;
  for (let i = 0; i < segs.length - 1; i++) {
    if (prefixes.includes(segs[i]!)) root = segs.slice(0, i + 2).join('/');
  }
  return root;
}

/** Group loose images into deterministic PackGroups (§4). Spine roots first, then static per-mode.
 *  `markers` = the non-image files (skeleton .json/.skel; .atlas markers are ignored as pack inputs)
 *  used purely to detect spine roots; only their `path`/`bytes` are read (TextDecoder), nothing decoded
 *  to pixels. PURE & deterministic: identical inputs → identical groups regardless of array order. */
export function groupLooseForPacking(
  images: LooseImage[],
  markers: RawFile[],
  opts: GroupLooseOptions,
): GroupLooseResult {
  const mode = opts.mode ?? 'auto';
  const granularity = opts.granularity ?? 'per-leaf-folder';
  const forced = opts.forced ?? false;
  const conventions = opts.spineConventions ?? ['animations', 'spine'];
  const { maxSpriteEdgePx, minLooseImages } = opts.thresholds.shouldAtlas;

  // 1) Detect spine roots FIRST, over ALL images (NOT size-filtered): a Spine atlas must contain EVERY
  //    region the skeleton references regardless of size, so spine membership must never depend on the
  //    should-atlas size heuristic (else a large background/logo region is silently dropped — the `fss`
  //    bug). From markers (.skel / skeleton .json) + the folder convention. force-static skips spine.
  //    `allImages` sorted by ref so all downstream iteration is order-independent (determinism §10a).
  const allImages = images.slice().sort((a, b) => a.ref.localeCompare(b.ref));
  const spineRoots = new Set<string>();
  if (mode !== 'force-static') {
    for (const m of markers) {
      const key = keyOf(m);
      const dir = dirOf(key);
      if (/\.skel$/i.test(m.name)) {
        spineRoots.add(dir);
        continue;
      }
      if (/\.json$/i.test(m.name)) {
        let json: unknown;
        try {
          json = JSON.parse(new TextDecoder().decode(m.bytes));
        } catch {
          continue;
        }
        if (looksLikeSkeleton(json)) spineRoots.add(dir);
      }
    }
    // Folder-convention roots derived from ALL image paths (not the size-filtered subset).
    for (const im of allImages) {
      const root = conventionRoot(dirOf(im.ref), conventions);
      if (root !== null) spineRoots.add(root);
    }
  }
  // force-spine with no detected root ⇒ treat the whole input as one spine root at the common ancestor.
  if (mode === 'force-spine' && spineRoots.size === 0 && allImages.length > 0) {
    spineRoots.add(commonAncestorDir(allImages.map((c) => c.ref)));
  }

  // Map a ref to its spine root (the LONGEST matching root dir; '' matches everything).
  const sortedRoots = [...spineRoots].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const rootOf = (ref: string): string | null => {
    for (const r of sortedRoots) {
      if (r === '' || ref === r || ref.startsWith(`${r}/`)) return r;
    }
    return null;
  };

  // 2) Candidate filter (§4): a SPINE-root image is ALWAYS a candidate (the skeleton dictates membership —
  //    never drop a large region by size); a NON-spine (static) image is a candidate only if it passes the
  //    should-atlas size heuristic max(w,h) <= maxSpriteEdgePx. Order-independent (allImages pre-sorted).
  const candidates = allImages.filter(
    (im) => rootOf(im.ref) !== null || Math.max(im.size.w, im.size.h) <= maxSpriteEdgePx,
  );

  // skeletonRef per spine root: the lexicographically-first skeleton marker under that root (deterministic).
  const skeletonByRoot = new Map<string, string>();
  for (const m of markers) {
    if (!/\.(skel|json)$/i.test(m.name)) continue;
    const key = keyOf(m);
    const r = rootOf(key);
    if (r === null) continue;
    const prev = skeletonByRoot.get(r);
    if (prev === undefined || key.localeCompare(prev) < 0) skeletonByRoot.set(r, key);
  }

  // 3) Bucket candidates: spine (by root) vs static (by granularity key).
  const spineBuckets = new Map<string, LooseImage[]>();
  const staticBuckets = new Map<string, LooseImage[]>();
  for (const im of candidates) {
    const root = rootOf(im.ref);
    if (root !== null) {
      (spineBuckets.get(root) ?? spineBuckets.set(root, []).get(root)!).push(im);
    } else {
      const bk = staticBucketKey(im.ref, granularity);
      (staticBuckets.get(bk) ?? staticBuckets.set(bk, []).get(bk)!).push(im);
    }
  }

  const groups: PackGroup[] = [];
  const collisions: RegionCollision[] = [];

  // 4a) Spine groups — region name relative to root, ext stripped, slash-preserved.
  for (const [root, ims] of spineBuckets) {
    const stem = leaf(root) || 'spine';
    const id = `spine:${root}/${stem}`;
    const { regions, cols } = buildRegions(ims, (ref) => stripImageExt(relativeTo(ref, root)), id);
    collisions.push(...cols);
    groups.push({
      id,
      kind: 'spine',
      root,
      outDir: root,
      stem,
      regions,
      ...(skeletonByRoot.has(root) ? { skeletonRef: skeletonByRoot.get(root)! } : {}),
    });
  }

  // 4b) Static groups — one per granularity bucket; skip < minLooseImages unless forced.
  for (const [bucket, ims] of staticBuckets) {
    if (!forced && ims.length < minLooseImages) continue;
    const refs = ims.map((i) => i.ref);
    const outDir = staticOutDir(bucket, refs, granularity);
    const stem = leaf(outDir) || 'sheet';
    const id = `static:${outDir}/${stem}`;
    const { regions, cols } = buildRegions(ims, (ref) => stripImageExt(relativeTo(ref, outDir)), id);
    collisions.push(...cols);
    groups.push({ id, kind: 'static', root: outDir, outDir, stem, regions });
  }

  groups.sort((a, b) => a.id.localeCompare(b.id));
  collisions.sort((a, b) => a.groupId.localeCompare(b.groupId) || a.name.localeCompare(b.name));
  return { groups, collisions };
}

/** The bucket key a static candidate falls into, by granularity (§4c). */
function staticBucketKey(ref: string, g: StaticGranularity): string {
  if (g === 'one-sheet-for-all') return '';
  if (g === 'per-top-level-bundle') return ref.split('/')[0] ?? '';
  return dirOf(ref); // per-leaf-folder
}

/** The outDir a static group's sheet/JSON is written to (§4c). */
function staticOutDir(bucket: string, refs: string[], g: StaticGranularity): string {
  if (g === 'per-leaf-folder') return bucket; // bucket IS the leaf folder dir
  if (g === 'per-top-level-bundle') return bucket; // bucket IS the top-level dir
  return commonAncestorDir(refs); // one-sheet-for-all → common ancestor of the candidates
}

/** Build LooseRegions from images under a group, mapping ref→region name, surfacing file→region
 *  collisions (two distinct refs → one name). The FIRST ref (sorted) keeps the region; later ones are
 *  dropped from the group and reported. Regions are returned sorted by name (localeCompare). */
function buildRegions(
  ims: LooseImage[],
  nameOf: (ref: string) => string,
  groupId: string,
): { regions: LooseRegion[]; cols: RegionCollision[] } {
  const byName = new Map<string, LooseImage[]>();
  for (const im of ims) {
    const n = nameOf(im.ref);
    (byName.get(n) ?? byName.set(n, []).get(n)!).push(im);
  }
  const regions: LooseRegion[] = [];
  const cols: RegionCollision[] = [];
  for (const [name, group] of byName) {
    if (group.length > 1) {
      const refs = group.map((g) => g.ref).sort((a, b) => a.localeCompare(b));
      cols.push({ groupId, name, refs });
    }
    const keep = group.slice().sort((a, b) => a.ref.localeCompare(b.ref))[0]!;
    regions.push({ ref: keep.ref, name, sourceSize: keep.size });
  }
  regions.sort((a, b) => a.name.localeCompare(b.name));
  return { regions, cols };
}

/** Leaf (last segment) of a normalized dir path; '' for the repo root. */
function leaf(dir: string): string {
  const segs = dir.split('/').filter(Boolean);
  return segs.length ? segs[segs.length - 1]! : '';
}
