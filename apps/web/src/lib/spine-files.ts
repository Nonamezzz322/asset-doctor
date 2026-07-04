// PURE, Node-testable file-grouping + atlas-munging for the Spine viewer (#spine view). ZERO Pixi / DOM —
// every function here is a plain data transform, so the load-bearing format logic (which .json/.atlas/image
// belongs together, how a JSON's skin attachments name their page images, how a synthesized atlas is
// assembled when no .atlas was dropped) is unit-tested without a browser. The imperative Pixi glue
// (spine-engine.ts) calls these verbatim; SpineViewer.tsx never touches them.
//
// Ported behavior-for-behavior from docs/improvements/spine-viewer-source-App.jsx (Pixi-v7 source), with the
// URL-map refactored to a plain key list: the source resolved image names against `fileURLs` (an object of
// name→objectURL); here the caller passes the decoded texture KEYS (the PickedFile paths) and we return the
// matched key, so the engine — not this pure module — owns the actual Texture objects.

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'] as const;

/** Atlas-text passthrough hook (source `modifyAtlasText`, :7-9). Kept as a named seam so a future
 *  normalization (e.g. stripping a `pma:` line an older exporter emitted) has ONE place to live. */
export function modifyAtlasText(atlasText: string): string {
  return atlasText;
}

export interface Sequence {
  count?: number;
  digits?: number;
  start?: number;
}

/** Expand a Spine sequence attachment's base path into its per-frame paths (source `expandSequencePath`,
 *  :11-21): `expandSequencePath('img', { digits: 3, start: 1, count: 12 })` → `img001 … img012`. */
export function expandSequencePath(basePath: string, seq: Sequence): string[] {
  const count = seq.count || 0;
  const digits = seq.digits || 0;
  const start = seq.start !== undefined ? seq.start : 1;
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const frame = String(start + i);
    paths.push(basePath + '0'.repeat(Math.max(0, digits - frame.length)) + frame);
  }
  return paths;
}

/** Minimal shape of a dropped skeleton JSON — only the skin-attachment surface we read. Everything else on
 *  the real skeleton file is ignored here (the skeleton runtime parses the full document later). */
export interface SkeletonLike {
  skins?:
    | Record<string, Record<string, Record<string, AttachmentLike>>>
    | Array<{ name?: string; attachments?: Record<string, Record<string, AttachmentLike>> }>;
}
interface AttachmentLike {
  type?: string;
  name?: string;
  path?: string;
  sequence?: Sequence;
}

/** Collect every distinct image page name a skeleton JSON references across all its skins (source
 *  `extractImageNames`, :23-53). Handles BOTH skin shapes — the Hash object (`skins: { default: {…} }`)
 *  and the Array (`skins: [{ name, attachments }]`) — region/mesh/linked/weighted/skinned attachments, the
 *  `path` fallback to the attachment placeholder name, and sequence expansion. Returns a de-duplicated,
 *  first-seen-ordered array (the source returned a Set; an array keeps atlas assembly deterministic). */
export function extractImageNames(jsonData: SkeletonLike): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (n: string): void => {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  const skins = jsonData.skins;
  if (!skins) return out;
  const skinList = Array.isArray(skins)
    ? skins
    : Object.keys(skins).map((k) => ({ attachments: skins[k] }));
  for (const skin of skinList) {
    const slots = skin.attachments;
    if (!slots || typeof slots !== 'object') continue;
    for (const slotName in slots) {
      const atts = slots[slotName];
      if (!atts || typeof atts !== 'object') continue;
      for (const attKey in atts) {
        const att = atts[attKey];
        if (!att || typeof att !== 'object') continue;
        const type = att.type || 'region';
        if (
          type === 'region' ||
          type === 'mesh' ||
          type === 'linkedmesh' ||
          type === 'weightedmesh' ||
          type === 'skinnedmesh'
        ) {
          const name = att.name || attKey;
          const path = att.path || name;
          if (att.sequence) {
            for (const framePath of expandSequencePath(path, att.sequence)) add(framePath);
          } else {
            add(path);
          }
        }
      }
    }
  }
  return out;
}

const baseOf = (p: string): string => p.split('/').pop() ?? p;

/** Resolve a JSON-referenced image name to one of the actually-dropped file keys (source `findImageFile`,
 *  :55-92, refactored off the URL map to a key list). Tries, in order: (1) exact + each extension, (2) exact
 *  as-is, (3) case-insensitive full path + ext, (4) case-insensitive basename + ext, (5) basename without
 *  extension, (6) folder-prefix `endsWith` (handles `images/sub/name` vs a nested key). Returns the matched
 *  key or null (⇒ the engine substitutes an honest placeholder page). */
export function findImageFile(imgName: string, keys: string[]): string | null {
  const baseName = baseOf(imgName);
  // 1. exact match with extension
  for (const ext of IMAGE_EXTS) {
    if (keys.includes(imgName + ext)) return imgName + ext;
  }
  // 2. exact match as-is
  if (keys.includes(imgName)) return imgName;
  // 3. case-insensitive full path
  for (const ext of IMAGE_EXTS) {
    const target = (imgName + ext).toLowerCase();
    for (const key of keys) if (key.toLowerCase() === target) return key;
  }
  // 4. case-insensitive basename only
  for (const ext of IMAGE_EXTS) {
    const target = (baseName + ext).toLowerCase();
    for (const key of keys) if (baseOf(key).toLowerCase() === target) return key;
  }
  // 5. basename without extension match
  const targetBase = baseName.toLowerCase();
  for (const key of keys) {
    const keyBase = baseOf(key).toLowerCase().replace(/\.[^.]+$/, '');
    if (keyBase === targetBase) return key;
  }
  // 6. endsWith match (folder prefixes like "images/subfolder/name")
  for (const ext of IMAGE_EXTS) {
    const suffix = ('/' + imgName + ext).toLowerCase();
    for (const key of keys) if (('/' + key).toLowerCase().endsWith(suffix)) return key;
  }
  return null;
}

/** Resolve an atlas PAGE name line to a decoded texture key (source `getTextureForLine`, :785-796, minus the
 *  Pixi `BaseTexture.from`). Name-tolerant: exact, case-insensitive full, then case-insensitive basename.
 *  Returns the matched key or null (⇒ the engine wires an honest 2×2 placeholder into that page). */
export function getTextureLineKey(line: string, keys: string[]): string | null {
  if (keys.includes(line)) return line;
  const lowerLine = line.toLowerCase();
  for (const key of keys) if (key.toLowerCase() === lowerLine) return key;
  const baseLine = baseOf(lowerLine);
  for (const key of keys) if (baseOf(key).toLowerCase() === baseLine) return key;
  return null;
}

export interface SpineGroup {
  jsonName: string | null;
  atlasName: string | null;
  imageNames: string[];
}

/** Group a flat list of dropped file names into the skeleton JSON, its optional `.atlas`, and the image
 *  pages (source :413-423). The FIRST `.json` / `.atlas` wins (deterministic — the source's last-wins
 *  object iteration is replaced by a stable first-match). `jsonName === null` ⇒ the caller emits `noJson`. */
export function groupSpineFiles(names: string[]): SpineGroup {
  let jsonName: string | null = null;
  let atlasName: string | null = null;
  const imageNames: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.json')) {
      if (jsonName === null) jsonName = name;
    } else if (lower.endsWith('.atlas')) {
      if (atlasName === null) atlasName = name;
    } else if (IMAGE_EXTS.some((ext) => lower.endsWith(ext))) {
      imageNames.push(name);
    }
  }
  return { jsonName, atlasName, imageNames };
}

export interface Dim {
  w: number;
  h: number;
}

/** Synthesize a TextureAtlas text when the dropped export had NO `.atlas` (string-assembly half of source
 *  `generateAtlasFromImages`, :117-133). For every image the skeleton references, resolve it to a dropped
 *  file (via `findImageFile`) and its decoded pixel size (`dims`, keyed by file key); regions that resolve
 *  to nothing get an honest 2×2 placeholder page so the region still exists and the skeleton still loads.
 *  Regions sharing one page image are grouped under a single page block. Byte-format matches the source
 *  exactly (`size: W,H` on the page line, `size: W, H` on the region line). */
export function buildAtlasFromImages(jsonData: SkeletonLike, dims: Map<string, Dim>): string {
  const imageNames = extractImageNames(jsonData);
  const keys = [...dims.keys()];
  interface Entry {
    regionName: string;
    fileName: string;
    width: number;
    height: number;
  }
  const entries: Entry[] = [];
  for (const imgName of imageNames) {
    const match = findImageFile(imgName, keys);
    if (!match) {
      entries.push({ regionName: imgName, fileName: `__placeholder_${imgName}.png`, width: 2, height: 2 });
      continue;
    }
    const d = dims.get(match) ?? { w: 2, h: 2 };
    entries.push({ regionName: imgName, fileName: match, width: d.w, height: d.h });
  }
  // Group regions by page file name (multiple regions can share one image), first-seen order.
  const pages = new Map<string, { width: number; height: number; regions: Entry[] }>();
  for (const e of entries) {
    if (!pages.has(e.fileName)) pages.set(e.fileName, { width: e.width, height: e.height, regions: [] });
    pages.get(e.fileName)!.regions.push(e);
  }
  let atlas = '';
  let first = true;
  for (const [fileName, page] of pages) {
    if (!first) atlas += '\n';
    first = false;
    atlas += `${fileName}\nsize: ${page.width},${page.height}\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n`;
    for (const r of page.regions) {
      atlas += `${r.regionName}\n  rotate: false\n  xy: 0, 0\n  size: ${r.width}, ${r.height}\n  orig: ${r.width}, ${r.height}\n  offset: 0, 0\n  index: -1\n`;
    }
  }
  return atlas;
}

/** Case-insensitive substring filter over slot names (source :1205-1207). A blank query returns all. */
export function filterSlots(all: string[], query: string): string[] {
  const q = query.toLowerCase();
  return all.filter((slot) => slot.toLowerCase().includes(q));
}
