// Group imported files into atlases (manifest + its image) and standalone images.
// Pure and env-agnostic (TextDecoder only) so it unit-tests headless and runs in the worker.
// Manifest→image is resolved within the manifest's OWN directory (via path) to avoid cross-folder
// basename collisions in deeply-nested real projects; falls back to global basename for flat uploads.

export interface RawFile {
  name: string;
  bytes: ArrayBuffer;
  /** Relative path within the imported folder, if known — enables directory-aware matching. */
  path?: string;
}

export interface GroupedAtlas {
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

  for (const f of files) {
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

    // Resolve the image within the manifest's own directory first, then fall back to basename.
    let image: RawFile | undefined;
    if (f.path) image = byPath.get(normalizePath(`${dirOf(f.path)}/${imageName}`));
    image = image ?? byBase.get(baseName(imageName));
    if (!image) {
      missing.push({ manifest: baseName(f.name), image: baseName(imageName) });
      continue;
    }
    referenced.add(keyOf(image));
    atlases.push({ manifest: json, image, name: image.path ? keyOf(image) : baseName(image.name) });
  }

  const images = files.filter((f) => IMAGE_RE.test(f.name) && !referenced.has(keyOf(f)));
  return { atlases, images, missing };
}
