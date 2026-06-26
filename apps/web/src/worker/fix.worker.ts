/// <reference lib="webworker" />
// The Phase-2 fix executor (impure half). Reuses the analysis pipeline to diagnose, plans the fix
// (@asset-doctor/fix, pure), then does the pixel work: repack atlases (crop each sprite from the source
// sheet → compose a tighter POT sheet → re-emit a deterministic manifest), transcode loose images
// (native WebP, or AVIF via @jsquash with honest fallback), drop exact duplicates, and zip a drop-in
// optimized folder. Assets never leave the device. Every fix the browser can't do lands in skipped[].

import type { Asset, Atlas, ImageFeatures, ImageMime } from '@asset-doctor/core';
import { groupFiles, type RawFile } from '@asset-doctor/ingest';
import { parseAtlas, parseImage, parseSpineAtlasText, parseSpinePage, type SpinePage } from '@asset-doctor/parsers';
import { analyze, mergeSharedAtlases, type EncodeSizer } from '@asset-doctor/analysis';
import { emitSpineAtlasText, emitTexturePackerJson, planFix, repackAtlases, scaleAtlas } from '@asset-doctor/fix';
import { dHashFromGray, isFlat, luma } from '../lib/perceptual';
import { makeZip, type ZipEntry } from './zip';
import type { FixInputFile, FixOptions, FixReceipt, FixRequest, FixResponse } from './fix-protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FixResponse): void => ctx.postMessage(m);
const basename = (p: string): string => p.split('/').pop() ?? p;
const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i + 1);
};
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

  // manifest file path per atlas image (so we can rewrite it in place): TexturePacker / Pixi JSON …
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
  // … and Spine `.atlas` (page image → its atlas file + page count, for single-page Spine repack)
  const spineAtlasInfo = new Map<string, { path: string; pages: number }>();
  for (const f of files) {
    if (!/\.atlas$/i.test(f.name)) continue;
    try {
      const pages = parseSpineAtlasText(td.decode(f.bytes));
      for (const pg of pages) spineAtlasInfo.set(basename(pg.image), { path: f.path, pages: pages.length });
    } catch {
      /* not a spine atlas */
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

  // aggressive dedup needs per-image features (SHA-256 + dHash); skip the decode cost otherwise.
  const features = opts.aggressive ? await computeFeatures(bytesByRef) : undefined;
  // measure format savings (native WebP) so format findings → transcode ops appear
  const report = await analyze(merged, undefined, { missingImages: grouped.missing, encodeImage: makeEncoder(bytesByRef), ...(features ? { features } : {}) });
  const plan = planFix(report, { targetMime: opts.targetMime, quality: opts.quality, lossless: true, padding: opts.padding, maxSize: opts.maxSize, maxEdge: opts.maxEdge, aggressive: opts.aggressive });

  // ── execute ──
  const out: { path: string; bytes: Uint8Array }[] = [];
  const replaced = new Set<string>();
  const dropped = new Set<string>();
  const skipped: { assetRef: string; reason: string }[] = [];
  const operations: string[] = [];
  let referencesChanged = false;
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
      // Spine single-page repack: emit a .atlas (not JSON) and keep PNG (Spine-runtime safe). Drop-in.
      if (op.atlasRefs.length === 1 && spineRefs.has(op.atlasRefs[0]!)) {
        const ref = op.atlasRefs[0]!;
        const info = spineAtlasInfo.get(basename(ref));
        const atlas = atlasByRef.get(ref);
        if (!atlas || !info || info.pages > 1) {
          skipped.push({ assetRef: ref, reason: info && info.pages > 1 ? 'multi-page Spine repack not supported in v1' : 'Spine atlas not found' });
          continue;
        }
        const r = repackAtlases([atlas], { allowRotation: false, padding: op.padding, maxSize: op.maxSize });
        if (r.atlases.length !== 1) {
          skipped.push({ assetRef: ref, reason: 'Spine repack spilled into multiple sheets' });
          continue;
        }
        const na = r.atlases[0]!;
        const canvas = new OffscreenCanvas(na.size.w, na.size.h);
        const c2d = canvas.getContext('2d');
        let ok = !!c2d;
        if (c2d) {
          for (const blit of r.blits) {
            const bmp = await bitmapOf(blit.from.atlasRef);
            if (!bmp) {
              ok = false;
              break;
            }
            c2d.drawImage(bmp, blit.from.rect.x, blit.from.rect.y, blit.from.rect.w, blit.from.rect.h, blit.to.x, blit.to.y, blit.to.w, blit.to.h);
          }
        }
        if (!ok) {
          skipped.push({ assetRef: ref, reason: 'source sheet unavailable' });
          continue;
        }
        const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
        const imagePath = pathByRef.get(ref)!;
        out.push({ path: imagePath, bytes: png });
        out.push({ path: info.path, bytes: te.encode(emitSpineAtlasText(na)) });
        replaced.add(imagePath);
        replaced.add(info.path);
        vramSaved += r.vramBytesBefore - r.vramBytesAfter;
        operations.push(`repack ${basename(ref)} (spine) → ${na.size.w}×${na.size.h}`);
        continue;
      }
      for (const rf of op.atlasRefs) if (spineRefs.has(rf)) skipped.push({ assetRef: rf, reason: 'Spine atlas not mergeable in v1' });
      const refs = op.atlasRefs.filter((rf) => !spineRefs.has(rf));
      const group = refs.map((rf) => atlasByRef.get(rf)).filter((a): a is Atlas => !!a);
      if (group.length === 0) {
        if (refs[0]) skipped.push({ assetRef: refs[0], reason: 'atlas not found' });
        continue;
      }
      const merge = group.length > 1; // multi-atlas op = the non-drop-in "merge atlases" mode
      const r = repackAtlases(group, { allowRotation: false, padding: op.padding, maxSize: op.maxSize });
      if (!merge && r.atlases.length !== 1) {
        skipped.push({ assetRef: refs[0]!, reason: 'repack spilled into multiple sheets (v1 keeps single-sheet atlases)' });
        continue;
      }
      // merging atlases with a shared sprite name would clobber manifest keys — skip honestly
      const names = r.atlases.flatMap((a) => a.sprites.map((s) => s.name));
      if (merge && new Set(names).size !== names.length) {
        for (const rf of refs) skipped.push({ assetRef: rf, reason: 'merge skipped: sprite-name collision across atlases' });
        continue;
      }

      let composeOk = true;
      const baseDir = merge ? dirOf(pathByRef.get(refs[0]!) ?? '') : '';
      for (let i = 0; i < r.atlases.length && composeOk; i++) {
        const na = r.atlases[i]!;
        const naNames = new Set(na.sprites.map((s) => s.name));
        const canvas = new OffscreenCanvas(na.size.w, na.size.h);
        const c2d = canvas.getContext('2d');
        if (!c2d) {
          composeOk = false;
          break;
        }
        for (const blit of r.blits.filter((b) => naNames.has(b.name))) {
          const bmp = await bitmapOf(blit.from.atlasRef); // per-blit source (correct across merged pages)
          if (!bmp) {
            composeOk = false;
            break;
          }
          c2d.drawImage(bmp, blit.from.rect.x, blit.from.rect.y, blit.from.rect.w, blit.from.rect.h, blit.to.x, blit.to.y, blit.to.w, blit.to.h);
        }
        if (!composeOk) break;
        const sheet = await encodeCanvas(canvas, c2d, 'image/webp', { lossless: true, allowPngFallback: true });
        const ext = EXT[sheet!.mime] ?? '.png';
        if (merge) {
          const stem = `atlas-merged${r.atlases.length > 1 ? `-${i}` : ''}`;
          na.imageRef = `${stem}${ext}`;
          out.push({ path: `${baseDir}${stem}${ext}`, bytes: sheet!.bytes });
          out.push({ path: `${baseDir}${stem}.json`, bytes: te.encode(emitTexturePackerJson(na)) });
        } else {
          const ref = refs[0]!;
          const origPath = pathByRef.get(ref)!;
          const imagePath = sheet!.mime === 'image/webp' ? origPath.replace(/\.[a-z0-9]+$/i, '.webp') : origPath;
          if (sheet!.mime === 'image/webp') na.imageRef = na.imageRef.replace(/\.[a-z0-9]+$/i, '.webp');
          out.push({ path: imagePath, bytes: sheet!.bytes });
          replaced.add(origPath);
          replaced.add(imagePath);
          const mPath = manifestPathByImage.get(basename(ref));
          if (mPath) {
            out.push({ path: mPath, bytes: te.encode(emitTexturePackerJson(na)) });
            replaced.add(mPath);
          }
          operations.push(`repack ${basename(ref)} → ${na.size.w}×${na.size.h} ${sheet!.mime.replace('image/', '')}`);
        }
      }
      if (!composeOk) {
        for (const rf of refs) skipped.push({ assetRef: rf, reason: 'source sheet unavailable' });
        continue;
      }
      if (merge) {
        for (const rf of refs) {
          const ip = pathByRef.get(rf);
          if (ip) dropped.add(ip);
          const mp = manifestPathByImage.get(basename(rf));
          if (mp) dropped.add(mp);
        }
        referencesChanged = true;
        operations.push(`merge ${refs.length} atlases → ${r.atlases.length} sheet${r.atlases.length === 1 ? '' : 's'}`);
      }
      vramSaved += r.vramBytesBefore - r.vramBytesAfter;
    } else if (op.kind === 'resize') {
      const ref = op.assetRef;
      const path = pathByRef.get(ref);
      const bytes = bytesByRef.get(ref);
      if (!path || !bytes) {
        skipped.push({ assetRef: ref, reason: 'image unavailable' });
        continue;
      }
      const bmp = await createImageBitmap(new Blob([bytes]));
      const origPx = bmp.width * bmp.height;
      const atlas = atlasByRef.get(ref);

      if (atlas) {
        // resize an ATLAS: scale the manifest frames too, keep the filename + source format → drop-in.
        const scaled = scaleAtlas(atlas, op.to.w / atlas.size.w);
        const canvas = new OffscreenCanvas(scaled.size.w, scaled.size.h);
        const c2d = canvas.getContext('2d');
        if (!c2d) {
          bmp.close();
          skipped.push({ assetRef: ref, reason: 'no 2D context' });
          continue;
        }
        c2d.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, scaled.size.w, scaled.size.h);
        bmp.close();
        const srcMime = mimeOf(path);
        const blob = await canvas.convertToBlob({ type: srcMime });
        out.push({ path, bytes: new Uint8Array(await blob.arrayBuffer()) });
        replaced.add(path);
        if (spineRefs.has(ref)) {
          const info = spineAtlasInfo.get(basename(ref));
          if (info) {
            out.push({ path: info.path, bytes: te.encode(emitSpineAtlasText(scaled)) });
            replaced.add(info.path);
          }
        } else {
          const mPath = manifestPathByImage.get(basename(ref));
          if (mPath) {
            out.push({ path: mPath, bytes: te.encode(emitTexturePackerJson(scaled)) });
            replaced.add(mPath);
          }
        }
        vramSaved += Math.max(0, (origPx - scaled.size.w * scaled.size.h) * 4);
        operations.push(`resize atlas ${basename(ref)} → ${scaled.size.w}×${scaled.size.h}`);
      } else {
        // loose image: downscale + transcode to the target format
        const canvas = new OffscreenCanvas(op.to.w, op.to.h);
        const c2d = canvas.getContext('2d');
        if (!c2d) {
          bmp.close();
          skipped.push({ assetRef: ref, reason: 'no 2D context' });
          continue;
        }
        c2d.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, op.to.w, op.to.h);
        bmp.close();
        const enc = await encodeCanvas(canvas, c2d, op.targetMime, { quality: op.quality, allowPngFallback: true });
        const newPath = path.replace(/[^/]+$/, basename(path).replace(/\.[a-z0-9]+$/i, EXT[enc!.mime] ?? '.png'));
        out.push({ path: newPath, bytes: enc!.bytes });
        replaced.add(path);
        vramSaved += Math.max(0, (origPx - op.to.w * op.to.h) * 4);
        operations.push(`resize ${basename(path)} → ${op.to.w}×${op.to.h} ${enc!.mime.replace('image/', '')}`);
      }
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
        referencesChanged = true; // removing a file changes the folder's references
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
    referencesChanged,
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

interface EncodeOpts {
  quality?: number;
  lossless?: boolean;
  /** When the target codec is unavailable: true → fall back to PNG, false → return null (honest skip). */
  allowPngFallback?: boolean;
}

/** Encode an OffscreenCanvas: AVIF + lossless-WebP via lazy @jsquash (the codecs native canvas lacks),
 *  lossy WebP/PNG native. Feature-detects the silent PNG fallback so we never mislabel an output. */
async function encodeCanvas(canvas: OffscreenCanvas, c2d: OffscreenCanvasRenderingContext2D, target: ImageMime, opts: EncodeOpts): Promise<{ bytes: Uint8Array; mime: ImageMime } | null> {
  const q = opts.quality ?? 0.85;
  if (target === 'image/avif') {
    try {
      const data = c2d.getImageData(0, 0, canvas.width, canvas.height);
      const m = (await import('@jsquash/avif')) as { encode: (d: ImageData, o?: { quality?: number }) => Promise<ArrayBuffer> };
      const buf = await m.encode(data, { quality: Math.round(q * 100) });
      if (buf && buf.byteLength > 0) return { bytes: new Uint8Array(buf), mime: 'image/avif' };
    } catch {
      /* fall through to WebP */
    }
    target = 'image/webp';
  }
  if (target === 'image/webp' && opts.lossless) {
    try {
      const data = c2d.getImageData(0, 0, canvas.width, canvas.height);
      const m = (await import('@jsquash/webp')) as { encode: (d: ImageData, o?: { lossless?: number }) => Promise<ArrayBuffer> };
      const buf = await m.encode(data, { lossless: 1 });
      if (buf && buf.byteLength > 0) return { bytes: new Uint8Array(buf), mime: 'image/webp' };
    } catch {
      /* fall through to native */
    }
  }
  const blob = await canvas.convertToBlob({ type: target, quality: q });
  if (blob.type === target) return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type as ImageMime };
  if (!opts.allowPngFallback) return null;
  const png = await canvas.convertToBlob({ type: 'image/png' });
  return { bytes: new Uint8Array(await png.arrayBuffer()), mime: 'image/png' };
}

/** Transcode raw image bytes (decode → canvas → encode). null = target codec unavailable (skip). */
async function transcode(bytes: ArrayBuffer, target: ImageMime, quality: number): Promise<{ bytes: Uint8Array; mime: ImageMime } | null> {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const c2d = canvas.getContext('2d');
  if (!c2d) return null;
  c2d.drawImage(bmp, 0, 0);
  bmp.close();
  return encodeCanvas(canvas, c2d, target, { quality, allowPngFallback: false });
}

const MIME_BY_EXT: Record<string, ImageMime> = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', avif: 'image/avif' };
const mimeOf = (path: string): ImageMime => MIME_BY_EXT[(path.split('.').pop() ?? '').toLowerCase()] ?? 'image/png';

/** Per-image features for aggressive dedup: SHA-256 content hash (exact) + dHash (near). Same as the
 *  analysis worker, so the dedup findings match the diagnosis. */
async function computeFeatures(bytesByRef: Map<string, ArrayBuffer>): Promise<ImageFeatures[]> {
  const out: ImageFeatures[] = [];
  for (const [assetRef, bytes] of bytesByRef) {
    const contentHash = await sha256Hex(bytes);
    const dHash = await dHashHex(bytes);
    out.push(dHash ? { assetRef, contentHash, dHash } : { assetRef, contentHash });
  }
  return out;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function dHashHex(bytes: ArrayBuffer): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const canvas = new OffscreenCanvas(9, 8);
    const c2d = canvas.getContext('2d');
    if (!c2d) return null;
    c2d.drawImage(bmp, 0, 0, 9, 8);
    bmp.close();
    const data = c2d.getImageData(0, 0, 9, 8).data;
    const gray: number[] = [];
    for (let p = 0; p < 72; p++) gray.push(luma(data, p * 4));
    if (isFlat(gray)) return null; // flat fills collapse to one hash → false near-dup matches
    return dHashFromGray(gray);
  } catch {
    return null;
  }
}
