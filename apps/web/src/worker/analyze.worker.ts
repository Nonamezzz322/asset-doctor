/// <reference lib="webworker" />
// Runs parsing + analysis off the main thread. WebP size estimation uses OffscreenCanvas —
// that's the one impure dependency, injected into the pure analysis core via encodeWebp.

import type { Asset, ImageMime } from '@asset-doctor/core';
import { parseAtlas, parseImage } from '@asset-doctor/parsers';
import { analyze, type WebpSizer } from '@asset-doctor/analysis';
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

    const report = await analyze(assets, undefined, { encodeWebp: makeWebpSizer(imageBytes) });
    post({ type: 'done', report });
  } catch (err) {
    post({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};

function makeWebpSizer(imageBytes: Map<string, ArrayBuffer>): WebpSizer {
  return async (assetRef: string, mime: ImageMime): Promise<number | null> => {
    if (mime === 'image/webp' || typeof OffscreenCanvas === 'undefined') return null;
    const bytes = imageBytes.get(assetRef);
    if (!bytes) return null;
    try {
      const bmp = await createImageBitmap(new Blob([bytes]));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const c2d = canvas.getContext('2d');
      if (!c2d) return null;
      c2d.drawImage(bmp, 0, 0);
      bmp.close();
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
      // convertToBlob falls back to PNG where WebP is unsupported — don't count that.
      return blob.type === 'image/webp' ? blob.size : null;
    } catch {
      return null;
    }
  };
}
