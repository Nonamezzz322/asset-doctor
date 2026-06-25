/// <reference lib="webworker" />
// Runs parsing + analysis off the main thread. Two impure bits live here (injected into the
// pure analysis core): per-image features (SHA-256 content hash + perceptual dHash) for
// folder-level duplicate detection, and format sizing (OffscreenCanvas → WebP/AVIF).

import type { Asset, ImageFeatures, ImageMime } from '@asset-doctor/core';
import { parseAtlas, parseImage } from '@asset-doctor/parsers';
import { analyze, type EncodeSizer } from '@asset-doctor/analysis';
import { groupFiles, type RawFile } from '../lib/group';
import type { WorkerRequest, WorkerResponse } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: WorkerResponse): void => ctx.postMessage(m);
const baseName = (p: string): string => p.split('/').pop() ?? p;

ctx.onmessage = async (e: MessageEvent<WorkerRequest>): Promise<void> => {
  const msg = e.data;
  if (msg.type !== 'analyze') return;
  try {
    const files: RawFile[] = msg.files.map((f) => ({ name: f.name, bytes: f.bytes }));
    const grouped = groupFiles(files);
    const assets: Asset[] = [];
    const imageBytes = new Map<string, ArrayBuffer>();
    const total = grouped.atlases.length + grouped.images.length;
    let done = 0;

    for (const a of grouped.atlases) {
      const res = parseAtlas(a.manifest, { ref: a.name, bytes: new Uint8Array(a.image.bytes) });
      post({ type: 'progress', done: ++done, total, label: a.name });
      if (res.ok && res.asset.kind === 'atlas') {
        assets.push(res.asset);
        imageBytes.set(res.asset.atlas.name, a.image.bytes);
      }
    }
    for (const im of grouped.images) {
      const name = baseName(im.name);
      const res = parseImage(name, new Uint8Array(im.bytes));
      post({ type: 'progress', done: ++done, total, label: name });
      if (res.ok && res.asset.kind === 'image') {
        assets.push(res.asset);
        imageBytes.set(res.asset.image.name, im.bytes);
      }
    }

    // Per-image features for folder-level duplicate detection.
    const features: ImageFeatures[] = [];
    for (const [assetRef, bytes] of imageBytes) {
      const contentHash = await sha256Hex(bytes);
      const dHash = await dHashHex(bytes);
      features.push(dHash ? { assetRef, contentHash, dHash } : { assetRef, contentHash });
    }

    const report = await analyze(assets, undefined, {
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

/** 64-bit difference hash (dHash) of the image, as 16 hex chars. Null if it can't decode. */
async function dHashHex(bytes: ArrayBuffer): Promise<string | null> {
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const W = 9;
    const H = 8;
    const canvas = new OffscreenCanvas(W, H);
    const c2d = canvas.getContext('2d');
    if (!c2d) return null;
    c2d.drawImage(bmp, 0, 0, W, H);
    bmp.close();
    const data = c2d.getImageData(0, 0, W, H).data;
    const gray = (i: number): number =>
      0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    let hex = '';
    let nibble = 0;
    let bits = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W - 1; x++) {
        const i = (y * W + x) * 4;
        nibble = (nibble << 1) | (gray(i) < gray(i + 4) ? 1 : 0);
        if (++bits === 4) {
          hex += nibble.toString(16);
          nibble = 0;
          bits = 0;
        }
      }
    }
    return hex.padStart(16, '0');
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
