/// <reference lib="webworker" />
// Runs parsing + analysis off the main thread. Two impure bits live here (injected into the
// pure analysis core): per-image features (SHA-256 content hash + perceptual dHash) for
// folder-level duplicate detection, and format sizing (OffscreenCanvas → WebP/AVIF).

import type { Asset, ImageFeatures, ImageMime } from '@asset-doctor/core';
import { parseAtlas, parseImage, parseSpinePage, type SpinePage } from '@asset-doctor/parsers';
import { analyze, mergeSharedAtlases, type EncodeSizer, type OpaqueEncodeSizer } from '@asset-doctor/analysis';
import { groupFiles, keyOf, type RawFile } from '../lib/group';
import { alphaFullyOpaque, classifyContent, dHashFromGray, isFlat, isSolidColor, luma } from '../lib/perceptual';
import type { ContentClass } from '@asset-doctor/core';
import type { WorkerRequest, WorkerResponse } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: WorkerResponse): void => ctx.postMessage(m);

ctx.onmessage = async (e: MessageEvent<WorkerRequest>): Promise<void> => {
  const msg = e.data;
  if (msg.type !== 'analyze') return;
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

    const report = await analyze(mergeSharedAtlases(assets), undefined, {
      encodeImage: makeEncoder(imageBytes),
      encodeOpaque: makeOpaqueEncoder(imageBytes),
      features,
      missingImages: grouped.missing,
      ...(unparsed.length ? { unparsed } : {}),
    });
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
