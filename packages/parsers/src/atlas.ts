// Parse TexturePacker JSON (Hash + Array) and PixiJS spritesheets into the normalized
// @asset-doctor/core Atlas model. Pixi's JSON is the TexturePacker Hash schema without the
// TexturePacker `meta.app` signature — that's how we tag the source kind. Pure & defensive:
// malformed input returns an error result, never throws.

import type { Atlas, AtlasSourceKind, ImageAsset, Rect, Size, Sprite, SpriteMesh, Vec2 } from '@asset-doctor/core';
import type { ParseResult } from './types';
import { readImageInfo, strippableMetadataBytes } from './image-size';
import { iccAssetField } from './icc';

/** A frame that named a sprite but could not be used (degenerate/negative/OOB rect, missing filename,
 *  non-object body). Per-frame recovery: the sheet keeps its good sprites; only the bad ones are
 *  surfaced. Additive — present on the ok-branch ONLY when ≥1 frame was dropped (mirrors
 *  `SpinePage.malformedRegions`). Absent ⇒ byte-identical to before. */
export interface MalformedFrame {
  name: string;
  reason: string;
}

export type AtlasParseResult =
  | { ok: true; atlas: Atlas; malformedFrames?: MalformedFrame[] }
  | { ok: false; error: string };

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
  // Reject degenerate / negative rects: a 0×0 or negative frame is not a usable sprite, and a negative
  // origin would place it outside the page. Safe for spriteSourceSize too (trim offsets are ≥0, w/h>0).
  if (w <= 0 || h <= 0 || x < 0 || y < 0) return null;
  return { x, y, w, h };
}

function readSize(v: unknown): Size | null {
  if (typeof v !== 'object' || v === null) return null;
  const s = v as Record<string, unknown>;
  const w = num(s.w);
  const h = num(s.h);
  if (w === undefined || h === undefined) return null;
  // Reject a degenerate / non-positive size: a 0×0 or negative meta.size is not a usable atlas
  // dimension and, being truthy, would DEFEAT the `?? opts.imageSize` fallback (below) — whole-
  // rejecting or mis-sizing an otherwise-good atlas. Falling through to null lets the real image
  // size take over. Mirrors readRect's w<=0/h<=0 guard (no x/y here); also protects the sourceSize
  // fallback, where a degenerate 0×0 collapses to the frame size instead of poisoning the sprite.
  if (w <= 0 || h <= 0) return null;
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

// Read an array of strings (the meta.related_multi_packs shape) order-preservingly. Non-array ⇒ undefined
// (matches Pixi's Array.isArray gate, spritesheetAsset.mjs:121); non-string/empty entries are skipped (Pixi
// skips non-strings :125); an empty result ⇒ undefined (omit ⇒ byte-identical). Total & deterministic.
function readStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const e of v) if (typeof e === 'string' && e.length > 0) out.push(e);
  return out.length ? out : undefined;
}

// Read a verbatim, order-preserving frame-animation map (the top-level `animations` shape). Each value must
// be a non-empty array of non-empty strings; coerce nothing, drop a WHOLE group only if its value is not such
// an array (so a single malformed group cannot poison a valid neighbor). Returns undefined when no usable
// group (⇒ field omitted ⇒ Atlas byte-identical). Insertion order of valid keys preserved (Object.entries order
// = JSON source order); arrays copied verbatim, NO sort (array order + key order are play order). Total & deterministic.
function readAnimations(v: unknown): Record<string, string[]> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [group, val] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(val) || val.length === 0) continue;
    let ok = true;
    for (const e of val) {
      if (typeof e !== 'string' || e.length === 0) {
        ok = false;
        break;
      }
    }
    if (ok) out[group] = val as string[];
  }
  return Object.keys(out).length ? out : undefined;
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
  const raw = readRect(body.frame);
  if (!raw) return null;
  const rotated = body.rotated === true;
  // TexturePacker/Pixi write frame.w/h in UN-ROTATED (source) orientation and set rotated:true; the loader
  // swaps to the on-page footprint (PixiJS Spritesheet builds Rectangle(x,y,rect.h,rect.w) when rotated). The
  // core Atlas contract (core/index.ts:53) stores `frame` AS PLACED, so swap w/h here — exactly like the Spine
  // parser (spine-atlas.ts toSprite). x/y are placement coords (never swapped); sourceSize/spriteSourceSize
  // stay in un-rotated source space.
  const frame: Rect = rotated ? { x: raw.x, y: raw.y, w: raw.h, h: raw.w } : raw;
  const sourceSize = readSize(body.sourceSize) ?? { w: raw.w, h: raw.h };
  const trimmed = body.trimmed === true;
  const sprite: Sprite = { name, frame, rotated, trimmed, sourceSize };
  const sss = readRect(body.spriteSourceSize);
  if (trimmed && sss) sprite.spriteSourceSize = sss; // already un-rotated source space — NOT swapped
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

  // Per-frame recovery (round21 #1): collect each unusable frame into malformedFrames instead of bailing
  // the WHOLE sheet on the first bad one (mirrors the Spine per-region recovery). Reason strings are kept
  // byte-identical to the pre-recovery whole-reject errors so the single-frame-sheet case (F3 tests) keeps
  // returning the same `error` via the zero-survivor guard below.
  const sprites: Sprite[] = [];
  const malformedFrames: MalformedFrame[] = [];
  if (layout === 'array') {
    let i = -1;
    // Duplicate-filename guard (P3 ingest/fix audit #6): a hash-layout re-emit collapses same-named frames
    // to ONE key and the repack's id map resolves both placements to the LAST sprite — one region's pixels
    // silently lost downstream. Keep the FIRST, surface the duplicate (never two sprites with one name).
    const seenNames = new Set<string>();
    for (const entry of rawFrames as unknown[]) {
      i++;
      if (typeof entry !== 'object' || entry === null) {
        malformedFrames.push({ name: `#${i}`, reason: 'array frame is not an object' });
        continue;
      }
      const e = entry as Record<string, unknown>;
      const name = typeof e.filename === 'string' ? e.filename : undefined;
      if (!name) {
        malformedFrames.push({ name: `#${i}`, reason: 'array frame missing filename' });
        continue;
      }
      if (seenNames.has(name)) {
        malformedFrames.push({ name, reason: `duplicate frame name "${name}"` });
        continue;
      }
      seenNames.add(name);
      const sp = bodyToSprite(name, e);
      if (!sp) {
        malformedFrames.push({ name, reason: `invalid frame "${name}"` });
        continue;
      }
      sprites.push(sp);
    }
  } else {
    for (const [name, body] of Object.entries(rawFrames as Record<string, unknown>)) {
      if (typeof body !== 'object' || body === null) {
        malformedFrames.push({ name, reason: `frame "${name}" is not an object` });
        continue;
      }
      const sp = bodyToSprite(name, body as Record<string, unknown>);
      if (!sp) {
        malformedFrames.push({ name, reason: `invalid frame "${name}"` });
        continue;
      }
      sprites.push(sp);
    }
  }

  const size = readSize(meta.size) ?? opts.imageSize;
  if (!size) return { ok: false, error: 'atlas size unknown (no meta.size and no image)' };

  // Out-of-bounds pass (after size is known): a frame placed past the page edge is a corrupt frame, not a
  // usable sprite. Per-frame recovery: partition rather than whole-reject. `frame` is the rect AS PLACED
  // (already w/h-swapped when rotated), so `x+w > size.w` is correct without any further swap. `===` at the
  // edge is fine (`>`, not `>=`). Order preserved (good frames stay in source order).
  const placed: Sprite[] = [];
  for (const s of sprites) {
    if (s.frame.x + s.frame.w > size.w || s.frame.y + s.frame.h > size.h) {
      malformedFrames.push({ name: s.name, reason: `frame "${s.name}" extends past atlas ${size.w}×${size.h}` });
    } else {
      placed.push(s);
    }
  }

  // Zero-survivor guard, gated on a real malformed frame: an all-bad manifest still wholesale-fails (with
  // today's first-failure error), preserving the F3 single-frame-sheet tests. An EMPTY `frames` object/array
  // (no malformed frames, no survivors) falls through to {ok:true, sprites:[]} — byte-identical to before.
  if (placed.length === 0 && malformedFrames.length > 0) {
    return { ok: false, error: malformedFrames[0]!.reason };
  }

  const imageRef = (typeof meta.image === 'string' ? meta.image : undefined) ?? opts.imageRef;
  if (!imageRef) return { ok: false, error: 'atlas imageRef unknown (no meta.image and no image)' };

  const atlas: Atlas = { name: opts.name ?? imageRef, imageRef, size, sprites: placed, source: { kind } };
  const format = typeof meta.format === 'string' ? meta.format : undefined;
  if (format) atlas.format = format;
  const scale = parseScale(meta.scale);
  if (scale !== undefined) atlas.scale = scale;
  // Multipack linkage (round28): carry the sibling-JSON list VERBATIM (order-preserving). Absent/non-array/
  // empty ⇒ field omitted ⇒ Atlas byte-identical to before. The emitter re-writes it only on byte-stable paths.
  const relatedMultiPacks = readStringArray(meta.related_multi_packs);
  if (relatedMultiPacks) atlas.relatedMultiPacks = relatedMultiPacks;
  // Frame-animation map (round29): carry the TOP-LEVEL `animations` (NOT meta) VERBATIM, order-preserving. It
  // references frame KEYS (not file names), so it stays valid under hashFilenames/cache-bust AND the KTX2 second
  // sidecar (those rename FILES, not frame keys). Absent/non-object/empty/all-malformed ⇒ omitted ⇒ byte-identical.
  const animations = readAnimations(j.animations);
  if (animations) atlas.animations = animations;
  return malformedFrames.length ? { ok: true, atlas, malformedFrames } : { ok: true, atlas };
}

/** Parse a manifest together with its atlas image bytes into an atlas `Asset`. */
export function parseAtlas(
  manifestJson: unknown,
  image: { ref: string; bytes: Uint8Array },
  opts: { name?: string } = {},
): ParseResult & { malformedFrames?: MalformedFrame[] } {
  const info = readImageInfo(image.bytes);
  if (!info) return { ok: false, error: `atlas image unrecognized: ${image.ref}` };
  const res = parseAtlasManifest(manifestJson, {
    imageRef: image.ref,
    imageSize: info.size,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
  });
  if (!res.ok) return res;
  const strippable = strippableMetadataBytes(image.bytes);
  const icc = iccAssetField(image.bytes);
  const imageAsset: ImageAsset = {
    name: res.atlas.imageRef,
    imageRef: image.ref,
    size: info.size,
    mime: info.mime,
    byteSize: image.bytes.byteLength,
    ...(strippable > 0 ? { strippableBytes: strippable } : {}),
    ...(icc ? { icc } : {}),
  };
  // Forward per-frame recovery onto the success result (additive intersection). All other callers
  // destructure {ok, asset} and ignore the extra prop; the worker fans it into unparsed[] (§5).
  return res.malformedFrames
    ? { ok: true, asset: { kind: 'atlas', atlas: res.atlas, image: imageAsset }, malformedFrames: res.malformedFrames }
    : { ok: true, asset: { kind: 'atlas', atlas: res.atlas, image: imageAsset } };
}

/** Parse a single standalone image (PNG / WebP / JPEG) into an image `Asset`. */
export function parseImage(name: string, bytes: Uint8Array): ParseResult {
  const info = readImageInfo(bytes);
  if (!info) return { ok: false, error: `unrecognized image: ${name}` };
  const strippable = strippableMetadataBytes(bytes);
  const icc = iccAssetField(bytes);
  const image: ImageAsset = {
    name,
    imageRef: name,
    size: info.size,
    mime: info.mime,
    byteSize: bytes.byteLength,
    ...(strippable > 0 ? { strippableBytes: strippable } : {}),
    ...(icc ? { icc } : {}),
  };
  return { ok: true, asset: { kind: 'image', image } };
}
