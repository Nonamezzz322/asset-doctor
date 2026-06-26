/// <reference lib="webworker" />
// The Phase-2 fix executor (impure half). Reuses the analysis pipeline to diagnose, plans the fix
// (@asset-doctor/fix, pure), then does the pixel work: repack atlases (crop each sprite from the source
// sheet → compose a tighter POT sheet → re-emit a deterministic manifest), transcode loose images
// (native WebP, or AVIF via @jsquash with honest fallback), drop exact duplicates, and zip a drop-in
// optimized folder. Assets never leave the device. Every fix the browser can't do lands in skipped[].

import type { Asset, Atlas, ImageMime } from '@asset-doctor/core';
import { groupFiles, type RawFile } from '@asset-doctor/ingest';
import { parseAtlas, parseImage, parseSpinePage, type SpinePage } from '@asset-doctor/parsers';
import { analyze, mergeSharedAtlases, type EncodeSizer } from '@asset-doctor/analysis';
import { emitTexturePackerJson, planFix, repackAtlases } from '@asset-doctor/fix';
import { makeZip, type ZipEntry } from './zip';
import type { FixInputFile, FixOptions, FixReceipt, FixRequest, FixResponse } from './fix-protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FixResponse): void => ctx.postMessage(m);
const basename = (p: string): string => p.split('/').pop() ?? p;
const td = new TextDecoder();
const te = new TextEncoder();
const EXT: Record<string, string> = { 'image/webp': '.webp', 'image/avif': '.avif', 'image/png': '.png', 'image/jpeg': '.jpg' };

ctx.onmessage = async (e: MessageEvent<FixRequest>): Promise<void> => {
  if (e.data.type !== 'fix') return;
  try {
    await runFix(e.data.files, e.data.options);
  } catch (err) {
    post({ type: 'fix-error', error: err instanceof Error ? err.message : String(err) });
  }
};

async function runFix(files: FixInputFile[], opts: FixOptions): Promise<void> {
  post({ type: 'fix-progress', label: 'analyzing', done: 0, total: 1 });

  // ── parse + analyze (same pipeline as the diagnosis) ──
  const raw: RawFile[] = files.map((f) => ({ name: f.name, path: f.path, bytes: f.bytes }));
  const grouped = groupFiles(raw);
  const assets: Asset[] = [];
  const bytesByRef = new Map<string, ArrayBuffer>();
  const pathByRef = new Map<string, string>();
  const spineRefs = new Set<string>();
  for (const a of grouped.atlases) {
    const image = { ref: a.name, bytes: new Uint8Array(a.image.bytes) };
    const res = a.kind === 'spine' ? parseSpinePage(a.manifest as SpinePage, image) : parseAtlas(a.manifest, image);
    if (res.ok && res.asset.kind === 'atlas') {
      assets.push(res.asset);
      bytesByRef.set(res.asset.atlas.name, a.image.bytes);
      pathByRef.set(res.asset.atlas.name, a.image.path ?? a.image.name);
      if (a.kind === 'spine') spineRefs.add(res.asset.atlas.name);
    }
  }
  for (const im of grouped.images) {
    const res = parseImage(basename(im.name), new Uint8Array(im.bytes));
    if (res.ok && res.asset.kind === 'image') {
      assets.push(res.asset);
      bytesByRef.set(res.asset.image.name, im.bytes);
      pathByRef.set(res.asset.image.name, im.path ?? im.name);
    }
  }

  // manifest file path per atlas image (so we can rewrite it in place)
  const manifestPathByImage = new Map<string, string>();
  for (const f of files) {
    if (!/\.json$/i.test(f.name)) continue;
    try {
      const j = JSON.parse(td.decode(f.bytes)) as { meta?: { image?: unknown } };
      if (typeof j.meta?.image === 'string') manifestPathByImage.set(basename(j.meta.image), f.path);
    } catch {
      /* not a manifest */
    }
  }

  const merged = mergeSharedAtlases(assets);
  const atlasByRef = new Map<string, Atlas>();
  const vramByRef = new Map<string, number>();
  for (const a of merged) {
    if (a.kind === 'atlas') {
      atlasByRef.set(a.atlas.name, a.atlas);
      vramByRef.set(a.atlas.name, a.atlas.size.w * a.atlas.size.h * 4);
    } else {
      vramByRef.set(a.image.name, a.image.size.w * a.image.size.h * 4);
    }
  }

  // measure format savings (native WebP) so format findings → transcode ops appear
  const report = await analyze(merged, undefined, { missingImages: grouped.missing, encodeImage: makeEncoder(bytesByRef) });
  const plan = planFix(report, { targetMime: opts.targetMime, quality: opts.quality, lossless: true, padding: opts.padding, maxSize: opts.maxSize });

  // ── execute ──
  const out: { path: string; bytes: Uint8Array }[] = [];
  const replaced = new Set<string>();
  const dropped = new Set<string>();
  const skipped: { assetRef: string; reason: string }[] = [];
  const operations: string[] = [];
  const bmpCache = new Map<string, ImageBitmap>();
  const bitmapOf = async (ref: string): Promise<ImageBitmap | null> => {
    if (bmpCache.has(ref)) return bmpCache.get(ref)!;
    const b = bytesByRef.get(ref);
    if (!b) return null;
    const bmp = await createImageBitmap(new Blob([b]));
    bmpCache.set(ref, bmp);
    return bmp;
  };

  let vramSaved = 0;
  let done = 0;
  const total = plan.ops.length + 1;

  for (const op of plan.ops) {
    post({ type: 'fix-progress', label: op.kind, done: done++, total });

    if (op.kind === 'repack') {
      const ref = op.atlasRefs[0]!;
      if (spineRefs.has(ref)) {
        skipped.push({ assetRef: ref, reason: 'Spine atlas repack not supported in v1' });
        continue;
      }
      const atlas = atlasByRef.get(ref);
      const srcBmp = atlas ? await bitmapOf(ref) : null;
      if (!atlas || !srcBmp) {
        skipped.push({ assetRef: ref, reason: 'atlas image unavailable' });
        continue;
      }
      const r = repackAtlases([atlas], { allowRotation: false, padding: op.padding, maxSize: op.maxSize });
      if (r.atlases.length !== 1) {
        skipped.push({ assetRef: ref, reason: 'repack spilled into multiple sheets (v1 keeps single-sheet atlases)' });
        continue;
      }
      const na = r.atlases[0]!;
      const canvas = new OffscreenCanvas(na.size.w, na.size.h);
      const c2d = canvas.getContext('2d');
      if (!c2d) {
        skipped.push({ assetRef: ref, reason: 'no 2D context' });
        continue;
      }
      for (const blit of r.blits) {
        c2d.drawImage(srcBmp, blit.from.rect.x, blit.from.rect.y, blit.from.rect.w, blit.from.rect.h, blit.to.x, blit.to.y, blit.to.w, blit.to.h);
      }
      const imgBytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      const imagePath = pathByRef.get(ref)!;
      out.push({ path: imagePath, bytes: imgBytes });
      replaced.add(imagePath);
      const mPath = manifestPathByImage.get(basename(na.imageRef)) ?? manifestPathByImage.get(basename(ref));
      if (mPath) {
        out.push({ path: mPath, bytes: te.encode(emitTexturePackerJson(na)) });
        replaced.add(mPath);
      }
      vramSaved += r.vramBytesBefore - r.vramBytesAfter;
      operations.push(`repack ${basename(ref)} ${na.size.w}×${na.size.h}`);
    } else if (op.kind === 'transcode') {
      const ref = op.assetRef;
      const path = pathByRef.get(ref);
      const bytes = bytesByRef.get(ref);
      if (!path || !bytes) {
        skipped.push({ assetRef: ref, reason: 'image unavailable' });
        continue;
      }
      const enc = await transcode(bytes, op.targetMime, op.quality);
      if (!enc) {
        skipped.push({ assetRef: ref, reason: `transcode to ${op.targetMime} unavailable` });
        continue;
      }
      const newPath = path.replace(/[^/]+$/, basename(path).replace(/\.[a-z0-9]+$/i, EXT[enc.mime] ?? '.webp'));
      out.push({ path: newPath, bytes: enc.bytes });
      replaced.add(path);
      operations.push(`transcode ${basename(path)} → ${enc.mime.replace('image/', '')}`);
    } else if (op.kind === 'drop') {
      const path = pathByRef.get(op.assetRef);
      if (path) {
        dropped.add(path);
        vramSaved += vramByRef.get(op.assetRef) ?? 0;
        operations.push(`drop duplicate ${basename(path)}`);
      }
    }
  }

  // ── pass-through untouched files → drop-in optimized folder ──
  for (const f of files) {
    if (replaced.has(f.path) || dropped.has(f.path)) continue;
    out.push({ path: f.path, bytes: new Uint8Array(f.bytes) });
  }

  post({ type: 'fix-progress', label: 'zipping', done: total - 1, total });
  const entries: ZipEntry[] = out.map((e) => ({ name: e.path, bytes: e.bytes }));
  const zip = makeZip(entries);

  const diskBefore = files.reduce((s, f) => s + f.bytes.byteLength, 0);
  const diskAfter = out.reduce((s, e) => s + e.bytes.byteLength, 0);
  const vramBefore = report.totals.vramBytes;
  const receipt: FixReceipt = {
    diskBytesBefore: diskBefore,
    diskBytesAfter: diskAfter,
    vramBytesBefore: vramBefore,
    vramBytesAfter: Math.max(0, vramBefore - vramSaved),
    fileCount: out.length,
    changedCount: replaced.size + dropped.size,
    operations,
    skipped,
  };
  post({ type: 'fix-done', receipt, zip });
}

/** Format-audit encoder: measure a candidate format's byte size via native canvas (matches the
 *  diagnosis). Returns null when the codec isn't available (silent PNG fallback). */
function makeEncoder(bytesByRef: Map<string, ArrayBuffer>): EncodeSizer {
  return async (assetRef, _sourceMime, targetMime) => {
    const bytes = bytesByRef.get(assetRef);
    if (!bytes) return null;
    try {
      const bmp = await createImageBitmap(new Blob([bytes]));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const c2d = canvas.getContext('2d');
      if (!c2d) return null;
      c2d.drawImage(bmp, 0, 0);
      bmp.close();
      const blob = await canvas.convertToBlob({ type: targetMime, quality: 0.9 });
      return blob.type === targetMime ? blob.size : null;
    } catch {
      return null;
    }
  };
}

/** Encode an ImageData to a target format; native WebP/PNG, AVIF via @jsquash (lazy). null if the
 *  browser silently fell back to another format (honest skip). */
async function transcode(bytes: ArrayBuffer, target: ImageMime, quality: number): Promise<{ bytes: Uint8Array; mime: ImageMime } | null> {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const c2d = canvas.getContext('2d');
  if (!c2d) return null;
  c2d.drawImage(bmp, 0, 0);
  bmp.close();

  if (target === 'image/avif') {
    try {
      const data = c2d.getImageData(0, 0, canvas.width, canvas.height);
      const avif = (await import('@jsquash/avif')) as { encode: (d: ImageData, o?: { quality?: number }) => Promise<ArrayBuffer> };
      const buf = await avif.encode(data, { quality: Math.round(quality * 100) });
      if (buf && buf.byteLength > 0) return { bytes: new Uint8Array(buf), mime: 'image/avif' };
    } catch {
      /* fall through to WebP */
    }
    target = 'image/webp';
  }

  const blob = await canvas.convertToBlob({ type: target, quality });
  // convertToBlob silently falls back to PNG when a codec is unavailable — only accept the real target.
  if (blob.type !== target) return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type as ImageMime };
}
