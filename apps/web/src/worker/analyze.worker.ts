/// <reference lib="webworker" />
// Runs parsing + analysis off the main thread. Two impure bits live here (injected into the
// pure analysis core): per-image features (SHA-256 content hash + perceptual dHash) for
// folder-level duplicate detection, and format sizing (OffscreenCanvas → WebP/AVIF).

import type { Asset, AtlasFrameHashes, AtlasFrameTrims, ImageFeatures, ImageMime, Sprite, TrimRect } from '@asset-doctor/core';
import { parseAtlas, parseImage, parseSpinePage, type SpinePage } from '@asset-doctor/parsers';
import { analyze, mergeSharedAtlases, type EncodeSizer, type OpaqueEncodeSizer } from '@asset-doctor/analysis';
import { alphaBBox } from '@asset-doctor/fix';
import { groupFiles, keyOf, type RawFile } from '../lib/group';
import {
  alphaFullyOpaque,
  classifyContent,
  dHashFromGray,
  extractFrameRegions,
  isFlat,
  isSolidColor,
  luma,
} from '../lib/perceptual';
import type { ContentClass } from '@asset-doctor/core';
import type { WorkerRequest, WorkerResponse } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: WorkerResponse): void => ctx.postMessage(m);

// round18-abortable-workers: cooperative cancel. Set on {type:'cancel'}; checked at the top of each
// per-asset loop + before the terminal `done` post, so a superseded run stops doing heavy work in the
// microtask gap before terminate() lands and never posts a `done` that races the terminate. ADDITIVE:
// a non-aborted run never sees a cancel ⇒ this stays false ⇒ every guard is a dead `if`.
let cancelled = false;

ctx.onmessage = async (e: MessageEvent<WorkerRequest>): Promise<void> => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (msg.type !== 'analyze') return;
  cancelled = false; // defensive reset (clients build a fresh worker per run today, so this is normally moot)
  try {
    const files: RawFile[] = msg.files.map((f) => ({ name: f.name, path: f.path, bytes: f.bytes }));
    const grouped = groupFiles(files);
    const assets: Asset[] = [];
    const imageBytes = new Map<string, ArrayBuffer>();
    // mime of each LOOSE image, keyed by assetRef — gates the full-frame opaque scan to alpha-bearing
    // formats (PNG/WebP) only; atlases are never keyed here (the wasted-alpha rule is loose-only).
    const looseMime = new Map<string, ImageMime>();
    const total = grouped.atlases.length + grouped.images.length;
    let done = 0;
    // Honest unparsed surface: ingest's "looks like a manifest but unusable" skip-points + the worker's
    // own parse failures (atlas/spine threw or image header unrecognized) + per-region Spine recovery.
    // Sorted by ref before handing to analyze (which passes it through verbatim).
    const unparsed = [...grouped.unparsed];

    for (const a of grouped.atlases) {
      if (cancelled) return; // superseded — stop before the next parse (terminate() will land shortly)
      const image = { ref: a.name, bytes: new Uint8Array(a.image.bytes) };
      // a.name is the dir-aware key from ingest — pass it as the asset name so two atlases sharing a
      // meta.image basename across folders stay distinct (atlas.name defaults to the bare imageRef).
      const res =
        a.kind === 'spine'
          ? parseSpinePage(a.manifest as SpinePage, image, { name: a.name })
          : parseAtlas(a.manifest, image, { name: a.name });
      post({ type: 'progress', done: ++done, total, label: a.name });
      if (res.ok && res.asset.kind === 'atlas') {
        assets.push(res.asset);
        imageBytes.set(res.asset.atlas.name, a.image.bytes);
      } else if (!res.ok) {
        unparsed.push({ ref: a.name, reason: res.error });
      }
      // Per-region Spine recovery: the page kept its good sprites; surface the bad regions individually.
      if (a.kind === 'spine') {
        for (const mr of (a.manifest as SpinePage).malformedRegions ?? []) {
          unparsed.push({ ref: `${a.name}#${mr.name}`, reason: mr.reason });
        }
      }
    }
    for (const im of grouped.images) {
      if (cancelled) return; // superseded — stop before the next parse
      // Key loose images by the dir-aware path (keyOf) so same-basename files in different folders are
      // two distinct assets instead of silently overwriting each other in the bytes map + features.
      const ref = keyOf(im);
      const res = parseImage(ref, new Uint8Array(im.bytes));
      post({ type: 'progress', done: ++done, total, label: ref });
      if (res.ok && res.asset.kind === 'image') {
        assets.push(res.asset);
        imageBytes.set(res.asset.image.name, im.bytes);
        looseMime.set(res.asset.image.name, res.asset.image.mime);
      } else if (!res.ok) {
        unparsed.push({ ref, reason: res.error });
      }
    }
    unparsed.sort((a, b) => a.ref.localeCompare(b.ref));

    // Per-image features for folder-level duplicate detection + the content-class format verdict.
    // ONE decode per image yields both the dHash AND the content class (zero extra getImageData).
    const features: ImageFeatures[] = [];
    for (const [assetRef, bytes] of imageBytes) {
      if (cancelled) return; // superseded — stop before the next (heavy) decode/hash
      const contentHash = await sha256Hex(bytes);
      // Only a LOOSE alpha-bearing image (PNG/WebP) needs the full-frame opaque scan — gate it so atlases
      // and JPEG/AVIF loose images never pay the full-resolution decode (instant-wow: most files skip it).
      const m = looseMime.get(assetRef);
      const scanAlpha = m === 'image/png' || m === 'image/webp';
      const { dHash, contentClass, solid, opaque } = await decodeFeatures(bytes, scanAlpha);
      const feat: ImageFeatures = { assetRef, contentHash };
      if (dHash) feat.dHash = dHash;
      if (contentClass !== 'unknown') feat.contentClass = contentClass;
      if (solid) feat.solid = true; // additive: only ever set when true
      if (opaque) feat.opaque = true; // additive: only ever set when true (full-frame alpha === 255)
      features.push(feat);
    }

    // Hoisted so the frame-redundancy hashing runs on the POST-MERGE sprite list (mergeSharedAtlases unions
    // shared-page regions by name into the first atlas; the index alignment + atlasRef keying must match the
    // list analyze() sees). imageBytes is keyed by atlas.name === merged atlas.name (the shared-page case).
    const merged = mergeSharedAtlases(assets);

    // Per-atlas sprite-region hashes for the within-atlas frame-redundancy check. ONE full-resolution decode
    // per atlas page (a NEW decode — owned cost, same magnitude as the main-thread FilmViewer decode), then
    // each sprite region is read off that single bitmap. Bounded by a size cap (very large pages skipped
    // honestly). Absent (no OffscreenCanvas / skipped) ⇒ the rule never fires (additive, gated like dHash).
    const frameHashes: AtlasFrameHashes[] = [];
    const frameTrims: AtlasFrameTrims[] = []; // computed in the SAME decode pass — no extra page decode
    for (const a of merged) {
      if (cancelled) return; // superseded — stop before the next (heavy) page decode
      if (a.kind !== 'atlas' || a.atlas.sprites.length === 0) continue;
      const bytes = imageBytes.get(a.atlas.name);
      if (!bytes) continue;
      const res = await hashAtlasFrames(bytes, a.atlas.sprites);
      if (res) {
        frameHashes.push({ atlasRef: a.atlas.name, frameHashes: res.hashes });
        frameTrims.push({ atlasRef: a.atlas.name, bboxes: res.bboxes });
      }
    }

    const report = await analyze(merged, undefined, {
      encodeImage: makeEncoder(imageBytes),
      encodeOpaque: makeOpaqueEncoder(imageBytes),
      features,
      missingImages: grouped.missing,
      ...(frameHashes.length ? { frameHashes } : {}),
      ...(frameTrims.length ? { frameTrims } : {}),
      ...(unparsed.length ? { unparsed } : {}),
    });
    if (cancelled) return; // superseded — suppress a `done` that would race the terminate
    post({ type: 'done', report });
  } catch (err) {
    post({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Per-image cap (px) on the full-frame opaque scan. The 9×8 path is always cheap; the opaque scan needs
 *  a FULL-RESOLUTION getImageData (one extra full decode), so we cap it to keep the free diagnosis ≤10s.
 *  ~24 MP covers 4096×4096 (a generous loose-art ceiling); above it we skip honestly (no `opaque`
 *  feature ⇒ no finding) rather than risk a slow read on an outlier. Short-circuit means most images bail
 *  on the first transparent pixel well before the scan cost matters; this cap bounds the worst case. */
const ALPHA_SCAN_MAX_PX = 4096 * 4096 * 1.5; // ≈ 25.2 MP

/** ONE 9×8 decode → BOTH the dHash (near-dup detection) AND the content class (format verdict). The
 *  9×8 RGBA sample is read once with getImageData; `dHash` is null for featureless fills (they collapse
 *  to one hash → false near-dup matches), `contentClass` is the lossy-vs-lossless hint (Inv 4: NO
 *  encode here — the class is pure math over the already-decoded sample). The same sample also yields
 *  `solid` (single-color / fully transparent — drives the loose-only solid-fill finding). When
 *  `scanAlpha` (a loose PNG/WebP), the SAME decoded bitmap is also drawn at FULL resolution for a
 *  full-frame opaque scan (`opaque` — alpha === 255 on every pixel; short-circuits on the first
 *  non-opaque pixel, so most images bail instantly). 'unknown' / solid:false / opaque:false on any
 *  decode failure, when OffscreenCanvas is unavailable, or when the image exceeds ALPHA_SCAN_MAX_PX. */
async function decodeFeatures(
  bytes: ArrayBuffer,
  scanAlpha: boolean,
): Promise<{ dHash: string | null; contentClass: ContentClass; solid: boolean; opaque: boolean }> {
  if (typeof OffscreenCanvas === 'undefined')
    return { dHash: null, contentClass: 'unknown', solid: false, opaque: false };
  try {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const canvas = new OffscreenCanvas(9, 8);
    const c2d = canvas.getContext('2d');
    if (!c2d) {
      bmp.close();
      return { dHash: null, contentClass: 'unknown', solid: false, opaque: false };
    }
    c2d.drawImage(bmp, 0, 0, 9, 8);
    const data = c2d.getImageData(0, 0, 9, 8).data;
    // Full-frame opaque scan: reuse the SAME bitmap (already decoded) at full resolution. Gated to loose
    // alpha-bearing formats and a size cap; alphaFullyOpaque short-circuits on the first non-opaque pixel.
    let opaque = false;
    if (scanAlpha && bmp.width > 0 && bmp.height > 0 && bmp.width * bmp.height <= ALPHA_SCAN_MAX_PX) {
      const full = new OffscreenCanvas(bmp.width, bmp.height);
      const fctx = full.getContext('2d', { willReadFrequently: true });
      if (fctx) {
        fctx.drawImage(bmp, 0, 0);
        opaque = alphaFullyOpaque(fctx.getImageData(0, 0, bmp.width, bmp.height).data);
      }
    }
    bmp.close();
    const gray: number[] = [];
    for (let p = 0; p < 9 * 8; p++) gray.push(luma(data, p * 4));
    const dHash = isFlat(gray) ? null : dHashFromGray(gray); // featureless → skip perceptual matching
    return { dHash, contentClass: classifyContent(gray, data), solid: isSolidColor(gray, data), opaque };
  } catch {
    return { dHash: null, contentClass: 'unknown', solid: false, opaque: false };
  }
}

/** Hash each sprite's PIXEL REGION off the atlas page (within-atlas frame-redundancy) AND compute each
 *  UNtrimmed sprite's OPAQUE bounding box (within-atlas trim-margin) — BOTH off ONE shared decode. ONE
 *  `createImageBitmap` + ONE full-resolution `getImageData` per page (a NEW decode — owned cost, same
 *  magnitude as the main-thread FilmViewer decode); the trim bboxes piggyback on that SAME `page` buffer, so
 *  the trim feature adds ZERO extra decode (instant-wow ≤10s). The PURE `extractFrameRegions` does the
 *  load-bearing redundancy work canvas-free (caps / bounds / region extraction / box-averaged 9×8 flat-guard);
 *  the pure `alphaBBox` reads the SAME buffer for the trim bbox. Each surviving region's RGBA bytes are
 *  SHA-256'd here (crypto.subtle is async). Both arrays are index-aligned to `sprites`. A bbox is computed ONLY
 *  for an UNtrimmed sprite (`!sp.trimmed`) — an already-trimmed sprite is `null` (skipped; the rule re-gates on
 *  Sprite.trimmed anyway); a fully-transparent untrimmed frame is `null` too (alphaBBox finds no opaque pixel —
 *  the rule reads that as a whole-frame margin). Reuses the SAME caps: `extractFrameRegions` returns null ⇒ the
 *  WHOLE page is skipped for BOTH halves. Returns null when OffscreenCanvas is unavailable, the decode fails,
 *  the 2d context is unavailable, or the page exceeds the size/sprite cap. Deterministic. */
async function hashAtlasFrames(
  pageBytes: ArrayBuffer,
  sprites: Sprite[],
): Promise<{ hashes: (string | null)[]; bboxes: (TrimRect | null)[] } | null> {
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    const bmp = await createImageBitmap(new Blob([pageBytes]));
    const { width, height } = bmp;
    if (width <= 0 || height <= 0) {
      bmp.close();
      return null;
    }
    const canvas = new OffscreenCanvas(width, height);
    const c2d = canvas.getContext('2d', { willReadFrequently: true });
    if (!c2d) {
      bmp.close();
      return null;
    }
    c2d.drawImage(bmp, 0, 0);
    bmp.close();
    const page = c2d.getImageData(0, 0, width, height).data; // one full-res read; both halves read this buffer
    const regions = extractFrameRegions(
      page,
      width,
      height,
      sprites.map((sp) => sp.frame),
    );
    if (!regions) return null; // whole page skipped (caps) — honest, BOTH rules never fire for it
    const hashes: (string | null)[] = [];
    for (const region of regions) hashes.push(region === null ? null : await sha256Hex(region.buffer as ArrayBuffer));
    // Trim bboxes off the SAME page buffer (no second decode). Only for UNtrimmed sprites; alphaBBox returns a
    // bbox RELATIVE to the frame top-left (exactly what trimMarginFinding expects), or null for a fully
    // transparent frame. `regions` already cleared the caps, so this loop is bounded by the same ceilings.
    const src = { data: page, width };
    const bboxes: (TrimRect | null)[] = sprites.map((sp) =>
      sp.trimmed ? null : alphaBBox(src, { x: sp.frame.x, y: sp.frame.y, w: sp.frame.w, h: sp.frame.h }),
    );
    return { hashes, bboxes };
  } catch {
    return null;
  }
}

function makeEncoder(imageBytes: Map<string, ArrayBuffer>): EncodeSizer {
  return async (assetRef: string, _sourceMime: ImageMime, targetMime: ImageMime) => {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const bytes = imageBytes.get(assetRef);
    if (!bytes) return null;
    try {
      const bmp = await createImageBitmap(new Blob([bytes]));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const c2d = canvas.getContext('2d');
      if (!c2d) return null;
      c2d.drawImage(bmp, 0, 0);
      bmp.close();
      const blob = await canvas.convertToBlob({ type: targetMime, quality: 0.9 });
      // convertToBlob falls back to PNG where the target codec is unavailable — don't count that.
      return blob.type === targetMime ? blob.size : null;
    } catch {
      return null;
    }
  };
}

/** MEASURE the disk size of an asset re-encoded OPAQUE (alpha channel dropped) to its SAME format. Used
 *  only to size the wasted-alpha finding's honest disk saving (byteSize − this) — it sizes, it never emits
 *  a file (invariant 3). Composes onto an `{alpha:false}` OffscreenCanvas (a genuinely opaque surface —
 *  the strongest signal that the encoder may omit the channel), then convertToBlob to the source mime.
 *  Returns null when OffscreenCanvas is unavailable, the bytes are missing, or convertToBlob falls back to
 *  a different codec (so the size is never miscounted). */
function makeOpaqueEncoder(imageBytes: Map<string, ArrayBuffer>): OpaqueEncodeSizer {
  return async (assetRef: string, mime: ImageMime) => {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const bytes = imageBytes.get(assetRef);
    if (!bytes) return null;
    try {
      const bmp = await createImageBitmap(new Blob([bytes]));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const c2d = canvas.getContext('2d', { alpha: false }); // genuinely opaque surface → drop the channel
      if (!c2d) {
        bmp.close();
        return null;
      }
      c2d.drawImage(bmp, 0, 0);
      bmp.close();
      const blob = await canvas.convertToBlob({ type: mime, quality: 0.9 });
      return blob.type === mime ? blob.size : null;
    } catch {
      return null;
    }
  };
}
