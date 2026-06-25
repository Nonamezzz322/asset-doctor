// Group imported files into atlases (manifest + its image) and standalone images.
// Pure and env-agnostic (TextDecoder only) so it unit-tests headless and runs in the worker.

export interface RawFile {
  name: string;
  bytes: ArrayBuffer;
}

export interface GroupedAtlas {
  manifest: unknown;
  image: RawFile;
  name: string;
}

export interface Grouped {
  atlases: GroupedAtlas[];
  images: RawFile[];
}

const IMAGE_RE = /\.(png|webp|jpe?g)$/i;
const baseName = (p: string): string => p.split('/').pop() ?? p;

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
  for (const f of files) byBase.set(baseName(f.name), f);

  const referenced = new Set<string>();
  const atlases: GroupedAtlas[] = [];

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
    const image = byBase.get(baseName(imageName));
    if (!image) continue;
    referenced.add(baseName(image.name));
    atlases.push({ manifest: json, image, name: baseName(image.name) });
  }

  const images = files.filter((f) => IMAGE_RE.test(f.name) && !referenced.has(baseName(f.name)));
  return { atlases, images };
}
