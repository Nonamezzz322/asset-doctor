// Group imported files into atlases (manifest/spine + its image) and standalone images.
// Pure and env-agnostic so it unit-tests headless and runs in the worker. Manifest→image is
// resolved within the manifest's OWN directory (via path) — this also lets Spine `.atlas` sheets
// reference page images across directories (../) correctly. Falls back to global basename for flat
// uploads. Supports TexturePacker/Pixi JSON manifests and Spine/libGDX `.atlas` text sheets.

import { parseSpineAtlasText, type SpinePage } from '@asset-doctor/parsers';

export interface RawFile {
  name: string;
  bytes: ArrayBuffer;
  /** Relative path within the imported folder, if known — enables directory-aware matching. */
  path?: string;
}

export interface GroupedAtlas {
  /** 'manifest' = TexturePacker/Pixi JSON; 'spine' = a parsed Spine page. */
  kind: 'manifest' | 'spine';
  manifest: unknown;
  image: RawFile;
  name: string;
}

export interface Grouped {
  atlases: GroupedAtlas[];
  images: RawFile[];
  /** Manifests whose referenced image is missing from the folder. */
  missing: { manifest: string; image: string }[];
}

const IMAGE_RE = /\.(png|webp|jpe?g|avif)$/i;
const baseName = (p: string): string => p.split('/').pop() ?? p;
const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}
const keyOf = (f: RawFile): string => normalizePath(f.path ?? f.name);

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

  // Resolve an image referenced by a manifest at `manifestPath`, dir-relative first then basename.
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
      } catch {
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

    // TexturePacker / Pixi JSON manifests.
    if (!/\.json$/i.test(f.name)) continue;
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(f.bytes));
    } catch {
      continue; // not JSON — skip, never throw on one bad file
    }
    if (!looksLikeManifest(json)) continue;
    const imageName = manifestImage(json);
    if (!imageName) continue;
    const image = resolve(f.path, imageName);
    if (!image) {
      missing.push({ manifest: baseName(f.name), image: baseName(imageName) });
      continue;
    }
    referenced.add(keyOf(image));
    atlases.push({ kind: 'manifest', manifest: json, image, name: atlasName(image) });
  }

  const images = files.filter((f) => IMAGE_RE.test(f.name) && !referenced.has(keyOf(f)));
  return { atlases, images, missing };
}
