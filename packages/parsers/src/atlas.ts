// Parse TexturePacker JSON (Hash + Array) and PixiJS spritesheets into the normalized
// @asset-doctor/core Atlas model. Pixi's JSON is the TexturePacker Hash schema without the
// TexturePacker `meta.app` signature — that's how we tag the source kind. Pure & defensive:
// malformed input returns an error result, never throws.

import type { Atlas, AtlasSourceKind, ImageAsset, Rect, Size, Sprite, SpriteMesh, Vec2 } from '@asset-doctor/core';
import type { ParseResult } from './types';
import { readImageInfo } from './image-size';

export type AtlasParseResult = { ok: true; atlas: Atlas } | { ok: false; error: string };

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

function readRect(v: unknown): Rect | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const x = num(r.x);
  const y = num(r.y);
  const w = num(r.w);
  const h = num(r.h);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  return { x, y, w, h };
}

function readSize(v: unknown): Size | null {
  if (typeof v !== 'object' || v === null) return null;
  const s = v as Record<string, unknown>;
  const w = num(s.w);
  const h = num(s.h);
  if (w === undefined || h === undefined) return null;
  return { w, h };
}

function parseScale(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// Read an array of [x,y] integer pairs (the emit shape) into Vec2[]. Returns null on any malformed
// entry so a bad mesh degrades to a rectangle-only sprite rather than throwing.
function readVec2Pairs(v: unknown): Vec2[] | null {
  if (!Array.isArray(v)) return null;
  const out: Vec2[] = [];
  for (const pair of v) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const x = num(pair[0]);
    const y = num(pair[1]);
    if (x === undefined || y === undefined) return null;
    out.push({ x, y });
  }
  return out;
}

// Read triangle index triplets into number[][], mirroring the manifest's `triangles` shape.
function readTriangles(v: unknown): number[][] | null {
  if (!Array.isArray(v)) return null;
  const out: number[][] = [];
  for (const tri of v) {
    if (!Array.isArray(tri) || tri.length !== 3) return null;
    const a = num(tri[0]);
    const b = num(tri[1]);
    const c = num(tri[2]);
    if (a === undefined || b === undefined || c === undefined) return null;
    out.push([a, b, c]);
  }
  return out;
}

// Additive polygon-mode mesh parse-back (Phase 2). Symmetric with emitTexturePackerJson: a mesh is
// produced ONLY when all three keys (vertices/verticesUV/triangles) are present and well-formed, so
// the emit→parse→toEqual round-trip holds for meshed atlases. Absent ⇒ no mesh (behavior unchanged).
// verticesUV are packed-atlas integer px (NOT normalized), kept verbatim per the coordinate contract.
function readMesh(body: Record<string, unknown>): SpriteMesh | undefined {
  if (body.vertices === undefined && body.verticesUV === undefined && body.triangles === undefined) {
    return undefined;
  }
  const vertices = readVec2Pairs(body.vertices);
  const verticesUV = readVec2Pairs(body.verticesUV);
  const triangles = readTriangles(body.triangles);
  if (!vertices || !verticesUV || !triangles) return undefined;
  return { vertices, verticesUV, triangles };
}

function isTexturePackerApp(meta: Record<string, unknown>): boolean {
  const app = typeof meta.app === 'string' ? meta.app.toLowerCase() : '';
  return app.includes('texturepacker') || app.includes('codeandweb');
}

function bodyToSprite(name: string, body: Record<string, unknown>): Sprite | null {
  const frame = readRect(body.frame);
  if (!frame) return null;
  const sourceSize = readSize(body.sourceSize) ?? { w: frame.w, h: frame.h };
  const trimmed = body.trimmed === true;
  const sprite: Sprite = { name, frame, rotated: body.rotated === true, trimmed, sourceSize };
  const sss = readRect(body.spriteSourceSize);
  if (trimmed && sss) sprite.spriteSourceSize = sss;
  if (typeof body.pivot === 'object' && body.pivot !== null) {
    const p = body.pivot as Record<string, unknown>;
    const px = num(p.x);
    const py = num(p.y);
    if (px !== undefined && py !== undefined) sprite.pivot = { x: px, y: py };
  }
  const mesh = readMesh(body);
  if (mesh) sprite.mesh = mesh;
  return sprite;
}

export function parseAtlasManifest(
  json: unknown,
  opts: { imageRef?: string; imageSize?: Size; name?: string } = {},
): AtlasParseResult {
  if (typeof json !== 'object' || json === null) return { ok: false, error: 'manifest is not an object' };
  const j = json as Record<string, unknown>;
  const meta = (typeof j.meta === 'object' && j.meta !== null ? j.meta : {}) as Record<string, unknown>;
  const rawFrames = j.frames;

  let layout: 'array' | 'hash';
  if (Array.isArray(rawFrames)) layout = 'array';
  else if (typeof rawFrames === 'object' && rawFrames !== null) layout = 'hash';
  else return { ok: false, error: 'manifest has no frames' };

  const kind: AtlasSourceKind =
    layout === 'array'
      ? 'texturepacker-array'
      : isTexturePackerApp(meta)
        ? 'texturepacker-hash'
        : 'pixi';

  const sprites: Sprite[] = [];
  if (layout === 'array') {
    for (const entry of rawFrames as unknown[]) {
      if (typeof entry !== 'object' || entry === null) return { ok: false, error: 'array frame is not an object' };
      const e = entry as Record<string, unknown>;
      const name = typeof e.filename === 'string' ? e.filename : undefined;
      if (!name) return { ok: false, error: 'array frame missing filename' };
      const sp = bodyToSprite(name, e);
      if (!sp) return { ok: false, error: `invalid frame "${name}"` };
      sprites.push(sp);
    }
  } else {
    for (const [name, body] of Object.entries(rawFrames as Record<string, unknown>)) {
      if (typeof body !== 'object' || body === null) return { ok: false, error: `frame "${name}" is not an object` };
      const sp = bodyToSprite(name, body as Record<string, unknown>);
      if (!sp) return { ok: false, error: `invalid frame "${name}"` };
      sprites.push(sp);
    }
  }

  const size = readSize(meta.size) ?? opts.imageSize;
  if (!size) return { ok: false, error: 'atlas size unknown (no meta.size and no image)' };

  const imageRef = (typeof meta.image === 'string' ? meta.image : undefined) ?? opts.imageRef;
  if (!imageRef) return { ok: false, error: 'atlas imageRef unknown (no meta.image and no image)' };

  const atlas: Atlas = { name: opts.name ?? imageRef, imageRef, size, sprites, source: { kind } };
  const format = typeof meta.format === 'string' ? meta.format : undefined;
  if (format) atlas.format = format;
  const scale = parseScale(meta.scale);
  if (scale !== undefined) atlas.scale = scale;
  return { ok: true, atlas };
}

/** Parse a manifest together with its atlas image bytes into an atlas `Asset`. */
export function parseAtlas(
  manifestJson: unknown,
  image: { ref: string; bytes: Uint8Array },
  opts: { name?: string } = {},
): ParseResult {
  const info = readImageInfo(image.bytes);
  if (!info) return { ok: false, error: `atlas image unrecognized: ${image.ref}` };
  const res = parseAtlasManifest(manifestJson, {
    imageRef: image.ref,
    imageSize: info.size,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
  });
  if (!res.ok) return res;
  const imageAsset: ImageAsset = {
    name: res.atlas.imageRef,
    imageRef: image.ref,
    size: info.size,
    mime: info.mime,
    byteSize: image.bytes.byteLength,
  };
  return { ok: true, asset: { kind: 'atlas', atlas: res.atlas, image: imageAsset } };
}

/** Parse a single standalone image (PNG / WebP / JPEG) into an image `Asset`. */
export function parseImage(name: string, bytes: Uint8Array): ParseResult {
  const info = readImageInfo(bytes);
  if (!info) return { ok: false, error: `unrecognized image: ${name}` };
  const image: ImageAsset = {
    name,
    imageRef: name,
    size: info.size,
    mime: info.mime,
    byteSize: bytes.byteLength,
  };
  return { ok: true, asset: { kind: 'image', image } };
}
