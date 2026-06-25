/* eslint-disable @typescript-eslint/no-explicit-any */
// Calibration harness (not a normal test — gated on CALIBRATE=1). Runs the real pipeline
// (group → parse → analyze, grouping per-directory to avoid cross-folder basename collisions)
// over local asset trees and writes an aggregated report for threshold calibration.
//   CALIBRATE=1 pnpm --filter @asset-doctor/web exec vitest run test/calibrate.test.ts
import { describe, it } from 'vitest';
import { readdirSync, statSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import type { Asset, ImageFeatures } from '@asset-doctor/core';
import { parseAtlas, parseImage } from '@asset-doctor/parsers';
import { analyze, occupancyValue, DEFAULT_THRESHOLDS } from '@asset-doctor/analysis';
import { groupFiles, type RawFile } from '../src/lib/group';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = join(REPO, 'tools/calibrate/out');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const pot = (n: number) => n > 0 && (n & (n - 1)) === 0;

function bucketByDir(root: string): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  const rec = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === '__MACOSX') continue;
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) rec(p);
      else if (e !== '.DS_Store' && !e.endsWith('.meta')) {
        const arr = buckets.get(d) ?? [];
        arr.push(p);
        buckets.set(d, arr);
      }
    }
  };
  rec(root);
  return buckets;
}

function quantiles(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], p10: q(0.1), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9), max: s[s.length - 1] };
}

describe.runIf(process.env.CALIBRATE)('calibration audit (real assets)', () => {
  it('aggregates metrics + verdicts', async () => {
    const roots = (process.env.CALIBRATE_ROOTS || 'assets,raw')
      .split(',')
      .map((r) => join(REPO, r.trim()))
      .filter(existsSync);

    const report: any = { roots: [], thresholds: DEFAULT_THRESHOLDS };

    for (const root of roots) {
      const buckets = bucketByDir(root);
      const assets: Asset[] = [];
      const features: ImageFeatures[] = [];
      const missing: { manifest: string; image: string }[] = [];
      let jsonFiles = 0, spineAtlas = 0, imageFiles = 0, parsedAtlases = 0, looseImages = 0, parseErrors = 0;
      const occ: number[] = [], edges: number[] = [], dupBytes: number[] = [];
      let npot = 0;
      const big: { name: string; w: number; h: number }[] = [];
      const byExt: Record<string, number> = {};

      for (const [, files] of buckets) {
        const raws: RawFile[] = [];
        const imgPath = new Map<string, string>();
        for (const p of files) {
          const n = basename(p);
          const ext = (n.toLowerCase().split('.').pop() ?? '');
          byExt[ext] = (byExt[ext] ?? 0) + 1;
          if (ext === 'atlas') spineAtlas++;
          else if (ext === 'json') {
            jsonFiles++;
            raws.push({ name: n, bytes: new Uint8Array(readFileSync(p)).buffer });
          } else if (/^(png|webp|jpe?g|avif)$/.test(ext)) {
            imageFiles++;
            imgPath.set(n, p);
            raws.push({ name: n, bytes: new ArrayBuffer(0) }); // grouping only needs the name
          }
        }
        const g = groupFiles(raws);
        for (const a of g.atlases) {
          const p = imgPath.get(a.name);
          if (!p) continue;
          const bytes = new Uint8Array(readFileSync(p));
          const r = parseAtlas(a.manifest, { ref: a.name, bytes });
          if (r.ok && r.asset.kind === 'atlas') {
            parsedAtlases++;
            assets.push(r.asset);
            features.push({ assetRef: r.asset.atlas.name, contentHash: sha(bytes) });
            occ.push(occupancyValue(r.asset.atlas));
            const e = Math.max(r.asset.atlas.size.w, r.asset.atlas.size.h);
            edges.push(e);
            if (!pot(r.asset.atlas.size.w) || !pot(r.asset.atlas.size.h)) npot++;
            big.push({ name: a.name, w: r.asset.atlas.size.w, h: r.asset.atlas.size.h });
          } else parseErrors++;
        }
        for (const im of g.images) {
          const p = imgPath.get(basename(im.name));
          if (!p) continue;
          const bytes = new Uint8Array(readFileSync(p));
          const r = parseImage(basename(im.name), bytes);
          if (r.ok && r.asset.kind === 'image') {
            looseImages++;
            assets.push(r.asset);
            features.push({ assetRef: r.asset.image.name, contentHash: sha(bytes) });
            const e = Math.max(r.asset.image.size.w, r.asset.image.size.h);
            edges.push(e);
            if (!pot(r.asset.image.size.w) || !pot(r.asset.image.size.h)) npot++;
            big.push({ name: basename(im.name), w: r.asset.image.size.w, h: r.asset.image.size.h });
          } else parseErrors++;
        }
        missing.push(...g.missing);
      }

      const rep = await analyze(assets, DEFAULT_THRESHOLDS, { features, missingImages: missing });
      const byRule: Record<string, number> = {};
      for (const f of rep.findings) {
        byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
        if (f.rule === 'duplicate-exact') dupBytes.push(f.estimate?.diskBytesSaved ?? 0);
      }
      big.sort((a, b) => b.w * b.h - a.w * a.h);

      report.roots.push({
        root: basename(root),
        fileExt: byExt,
        coverage: { jsonFiles, spineAtlasFiles: spineAtlas, imageFiles, parsedAtlases, looseImages, parseErrors, missingImages: missing.length },
        occupancy: quantiles(occ),
        occBelowWarn: occ.filter((o) => o < DEFAULT_THRESHOLDS.occupancy.warn).length,
        occBelowCrit: occ.filter((o) => o < DEFAULT_THRESHOLDS.occupancy.crit).length,
        longestEdge: quantiles(edges),
        oversizeWarn: edges.filter((e) => e > DEFAULT_THRESHOLDS.oversizePx.warn).length,
        oversizeCrit: edges.filter((e) => e > DEFAULT_THRESHOLDS.oversizePx.crit).length,
        npot,
        dupExactGroups: dupBytes.length,
        dupWastedBytes: dupBytes.reduce((s, b) => s + b, 0),
        findingsByRule: byRule,
        totals: rep.totals,
        top10Largest: big.slice(0, 10),
      });
    }

    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log('CALIBRATION_REPORT ' + JSON.stringify(report));
  }, 300000);
});
