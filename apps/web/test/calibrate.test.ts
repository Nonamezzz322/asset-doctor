/* eslint-disable @typescript-eslint/no-explicit-any */
// Calibration harness (not a normal test — gated on CALIBRATE=1). Runs the real pipeline
// (whole-tree path-aware group → parse[TP/Pixi/Spine] → analyze) over local asset trees and
// writes an aggregated report for threshold calibration + coverage measurement.
//   CALIBRATE=1 pnpm --filter @asset-doctor/web exec vitest run test/calibrate.test.ts
import { describe, it } from 'vitest';
import { readdirSync, statSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import type { Asset, ImageFeatures } from '@asset-doctor/core';
import { parseAtlas, parseImage, parseSpinePage, type SpinePage } from '@asset-doctor/parsers';
import { analyze, occupancyValue, mergeSharedAtlases, DEFAULT_THRESHOLDS } from '@asset-doctor/analysis';
import { groupFiles, type RawFile } from '../src/lib/group';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = join(REPO, 'tools/calibrate/out');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const pot = (n: number) => n > 0 && (n & (n - 1)) === 0;
const IMG = /^(png|webp|jpe?g|avif)$/;

function walk(dir: string, prefix: string, out: { rel: string; full: string; ext: string }[]) {
  for (const e of readdirSync(dir)) {
    if (e === '__MACOSX') continue;
    const full = join(dir, e);
    const rel = prefix ? `${prefix}/${e}` : e;
    if (statSync(full).isDirectory()) walk(full, rel, out);
    else if (e !== '.DS_Store' && !e.endsWith('.meta')) out.push({ rel, full, ext: e.toLowerCase().split('.').pop() ?? '' });
  }
}

function quantiles(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9), max: s[s.length - 1] };
}

describe.runIf(process.env.CALIBRATE)('calibration audit (real assets)', () => {
  it('aggregates metrics + verdicts + coverage', async () => {
    const roots = (process.env.CALIBRATE_ROOTS || 'assets,raw')
      .split(',')
      .map((r) => join(REPO, r.trim()))
      .filter(existsSync);
    const report: any = { roots: [], thresholds: DEFAULT_THRESHOLDS };

    for (const root of roots) {
      const all: { rel: string; full: string; ext: string }[] = [];
      walk(root, '', all);

      const raws: RawFile[] = [];
      const toFull = new Map<string, string>();
      const byExt: Record<string, number> = {};
      for (const f of all) {
        byExt[f.ext] = (byExt[f.ext] ?? 0) + 1;
        if (f.ext === 'json' || f.ext === 'atlas') {
          raws.push({ name: basename(f.rel), path: f.rel, bytes: new Uint8Array(readFileSync(f.full)).buffer });
        } else if (IMG.test(f.ext)) {
          raws.push({ name: basename(f.rel), path: f.rel, bytes: new ArrayBuffer(0) });
          toFull.set(f.rel, f.full);
        }
      }

      const g = groupFiles(raws);
      const assets: Asset[] = [];
      const features: ImageFeatures[] = [];
      const occ: number[] = [], edges: number[] = [];
      let parsedManifest = 0, parsedSpine = 0, parseErrors = 0, npot = 0;
      const big: { name: string; w: number; h: number }[] = [];
      const lowOcc: any[] = [];

      for (const a of g.atlases) {
        const full = a.image.path ? toFull.get(a.image.path) : undefined;
        if (!full) continue;
        const bytes = new Uint8Array(readFileSync(full));
        const r = a.kind === 'spine' ? parseSpinePage(a.manifest as SpinePage, { ref: a.name, bytes }) : parseAtlas(a.manifest, { ref: a.name, bytes });
        if (r.ok && r.asset.kind === 'atlas') {
          if (a.kind === 'spine') parsedSpine++;
          else parsedManifest++;
          assets.push(r.asset);
          features.push({ assetRef: r.asset.atlas.name, contentHash: sha(bytes) });
        } else parseErrors++;
      }
      for (const im of g.images) {
        const full = im.path ? toFull.get(im.path) : undefined;
        if (!full) continue;
        const bytes = new Uint8Array(readFileSync(full));
        const r = parseImage(basename(im.name), bytes);
        if (r.ok && r.asset.kind === 'image') {
          assets.push(r.asset);
          features.push({ assetRef: r.asset.image.name, contentHash: sha(bytes) });
        } else parseErrors++;
      }

      // Merge atlases that share a page image (Spine cross-page sharing, variant references),
      // then compute stats + analyze from the de-duplicated set.
      const merged = mergeSharedAtlases(assets);
      let mergedAtlases = 0;
      for (const a of merged) {
        if (a.kind === 'atlas') {
          mergedAtlases++;
          const o = occupancyValue(a.atlas);
          occ.push(o);
          if (o < 0.02) lowOcc.push({ name: a.atlas.name, size: a.atlas.size, sprites: a.atlas.sprites.length });
          edges.push(Math.max(a.atlas.size.w, a.atlas.size.h));
          if (!pot(a.atlas.size.w) || !pot(a.atlas.size.h)) npot++;
          big.push({ name: a.atlas.name, w: a.atlas.size.w, h: a.atlas.size.h });
        } else {
          edges.push(Math.max(a.image.size.w, a.image.size.h));
          if (!pot(a.image.size.w) || !pot(a.image.size.h)) npot++;
        }
      }
      const rep = await analyze(merged, DEFAULT_THRESHOLDS, { features, missingImages: g.missing });
      const byRule: Record<string, number> = {};
      for (const f of rep.findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
      big.sort((a, b) => b.w * b.h - a.w * a.h);

      report.roots.push({
        root: basename(root),
        fileExt: byExt,
        coverage: { atlasesParsed: parsedManifest + parsedSpine, fromManifest: parsedManifest, fromSpine: parsedSpine, mergedAtlases, looseImages: g.images.length, parseErrors, missingImages: g.missing.length },
        occupancy: quantiles(occ),
        occBelowWarn: occ.filter((o) => o < DEFAULT_THRESHOLDS.occupancy.warn).length,
        longestEdge: quantiles(edges),
        oversizeWarn: edges.filter((e) => e > DEFAULT_THRESHOLDS.oversizePx.warn).length,
        oversizeCrit: edges.filter((e) => e > DEFAULT_THRESHOLDS.oversizePx.crit).length,
        npot,
        findingsByRule: byRule,
        totals: rep.totals,
        top10Largest: big.slice(0, 10),
        lowOcc,
      });
    }

    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log('CALIBRATION_REPORT ' + JSON.stringify(report));
  }, 600000);
});
