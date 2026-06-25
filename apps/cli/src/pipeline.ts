// Node-side audit pipeline — mirrors the web worker (group → parse → mergeSharedAtlases → analyze)
// but reads files from disk and computes features with node:crypto SHA-256 (exact-dup detection).
// No canvas/WebGL, so format-audit and near-dup (dHash) self-skip; VRAM is pure w×h×4 math. Inputs
// are sorted for deterministic output regardless of readdir order.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { AnalysisReport, Asset, ImageFeatures } from '@asset-doctor/core';
import { groupFiles, type RawFile } from '@asset-doctor/ingest';
import { parseAtlas, parseImage, parseSpinePage, type SpinePage } from '@asset-doctor/parsers';
import { analyze, mergeSharedAtlases } from '@asset-doctor/analysis';
import { resolveThresholds, type BudgetConfig } from '@asset-doctor/budget';
import { InputError } from './errors';

const RELEVANT = /\.(json|atlas|png|webp|jpe?g|avif)$/i;

export function walkDir(dir: string): RawFile[] {
  const out: RawFile[] = [];
  const walk = (d: string): void => {
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && RELEVANT.test(e.name)) {
        const buf = readFileSync(full);
        const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        out.push({ name: e.name, path: relative(dir, full).split(sep).join('/'), bytes });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path ?? a.name).localeCompare(b.path ?? b.name));
}

export interface AuditResult {
  report: AnalysisReport;
  /** Per-asset pixel sizes for per-asset oversizePx budgets, keyed by assetRef. */
  assetSizes: Record<string, { w: number; h: number }>;
  fileCount: number;
}

const sha256 = (ab: ArrayBuffer): string => createHash('sha256').update(Buffer.from(ab)).digest('hex');

export async function auditDir(dir: string, config?: BudgetConfig): Promise<AuditResult> {
  const files = walkDir(dir);
  const grouped = groupFiles(files);

  const assets: Asset[] = [];
  const imageBytes = new Map<string, ArrayBuffer>();
  for (const a of grouped.atlases) {
    const image = { ref: a.name, bytes: new Uint8Array(a.image.bytes) };
    const res = a.kind === 'spine' ? parseSpinePage(a.manifest as SpinePage, image) : parseAtlas(a.manifest, image);
    if (res.ok && res.asset.kind === 'atlas') {
      assets.push(res.asset);
      imageBytes.set(res.asset.atlas.name, a.image.bytes);
    }
  }
  for (const im of grouped.images) {
    const name = im.name.split('/').pop() ?? im.name;
    const res = parseImage(name, new Uint8Array(im.bytes));
    if (res.ok && res.asset.kind === 'image') {
      assets.push(res.asset);
      imageBytes.set(res.asset.image.name, im.bytes);
    }
  }
  if (assets.length === 0) throw new InputError(`no parseable assets found in ${dir} (looked for png/webp/jpg/avif + json/atlas manifests)`);

  const merged = mergeSharedAtlases(assets);

  // Exact-dup only: SHA-256 of the raw bytes. dHash is omitted, so duplicate-similar self-skips.
  const features: ImageFeatures[] = [];
  for (const [assetRef, bytes] of imageBytes) features.push({ assetRef, contentHash: sha256(bytes) });

  const assetSizes: Record<string, { w: number; h: number }> = {};
  for (const a of merged) {
    if (a.kind === 'atlas') assetSizes[a.atlas.name] = { w: a.atlas.size.w, h: a.atlas.size.h };
    else assetSizes[a.image.name] = { w: a.image.size.w, h: a.image.size.h };
  }

  const report = await analyze(merged, resolveThresholds(config?.thresholds), {
    features,
    missingImages: grouped.missing,
  });
  return { report, assetSizes, fileCount: files.length };
}
