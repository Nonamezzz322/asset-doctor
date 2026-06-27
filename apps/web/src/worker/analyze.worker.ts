/// <reference lib="webworker" />
// Runs parsing + analysis off the main thread. Two impure bits live here (injected into the
// pure analysis core): per-image features (SHA-256 content hash + perceptual dHash) for
// folder-level duplicate detection, and format sizing (OffscreenCanvas → WebP/AVIF).

import type { Asset, ImageFeatures, ImageMime } from '@asset-doctor/core';
import { parseAtlas, parseImage, parseSpinePage, type SpinePage } from '@asset-doctor/parsers';
import { analyze, mergeSharedAtlases, type EncodeSizer } from '@asset-doctor/analysis';
import { groupFiles, keyOf, type RawFile } from '../lib/group';
import { classifyContent, dHashFromGray, isFlat, luma } from '../lib/perceptual';
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
    const total = grouped.atlases.length + grouped.images.length;
    let done = 0;

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
      }
    }

    // Per-image features for folder-level duplicate detection + the content-class format verdict.
    // ONE decode per image yields both the dHash AND the content class (zero extra getImageData).
    const features: ImageFeatures[] = [];
    for (const [assetRef, bytes] of imageBytes) {
      const contentHash = await sha256Hex(bytes);
      const { dHash, contentClass } = await decodeFeatures(bytes);
      const feat: ImageFeatures = { assetRef, contentHash };
      if (dHash) feat.dHash = dHash;
      if (contentClass !== 'unknown') feat.contentClass = contentClass;
      features.push(feat);
    }

    const report = await analyze(mergeSharedAtlases(assets), undefined, {
      encodeImage: makeEncoder(imageBytes),
      features,
      missingImages: grouped.missing,
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

/** ONE 9×8 decode → BOTH the dHash (near-dup detection) AND the content class (format verdict). The
 *  9×8 RGBA sample is read once with getImageData; `dHash` is null for featureless fills (they collapse
 *  to one hash → false near-dup matches), `contentClass` is the lossy-vs-lossless hint (Inv 4: NO
 *  encode here — the class is pure math over the already-decoded sample). 'unknown' on any decode
 *  failure or when OffscreenCanvas is unavailable. */
async function decodeFeatures(bytes: ArrayBuffer): Promise<{ dHash: string | null; contentClass: ContentClass }> {
  if (typeof OffscreenCanvas === 'undefined') return { dHash: null, contentClass: 'unknown' };
  try {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const canvas = new OffscreenCanvas(9, 8);
    const c2d = canvas.getContext('2d');
    if (!c2d) return { dHash: null, contentClass: 'unknown' };
    c2d.drawImage(bmp, 0, 0, 9, 8);
    bmp.close();
    const data = c2d.getImageData(0, 0, 9, 8).data;
    const gray: number[] = [];
    for (let p = 0; p < 9 * 8; p++) gray.push(luma(data, p * 4));
    const dHash = isFlat(gray) ? null : dHashFromGray(gray); // featureless → skip perceptual matching
    return { dHash, contentClass: classifyContent(gray, data) };
  } catch {
    return { dHash: null, contentClass: 'unknown' };
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
