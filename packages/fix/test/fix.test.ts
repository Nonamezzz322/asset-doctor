import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AnalysisReport, Atlas } from '@asset-doctor/core';
import { parseAtlas, parseAtlasManifest } from '@asset-doctor/parsers';
import { analyze, DEFAULT_THRESHOLDS } from '@asset-doctor/analysis';
import { emitTexturePackerJson, pack, planFix, repackAtlases, type Placement } from '../src/index';

const fixDir = fileURLToPath(new URL('../../../fixtures/sample-projects/tp-hash-symbols/', import.meta.url));
function loadAtlas(): Atlas {
  const manifest = JSON.parse(readFileSync(`${fixDir}symbols.json`, 'utf8')) as unknown;
  const bytes = new Uint8Array(readFileSync(`${fixDir}symbols.png`));
  const res = parseAtlas(manifest, { ref: 'symbols.png', bytes });
  if (!res.ok || res.asset.kind !== 'atlas') throw new Error('fixture parse failed');
  return res.asset.atlas;
}

const overlap = (a: Placement, b: Placement): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('pack (MaxRects)', () => {
  it('places every rect overlap-free within a POT bin', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, w: 30 + (i % 7) * 11, h: 20 + (i % 5) * 13 }));
    const bins = pack(items, { maxSize: 2048, allowRotation: false, padding: 1 });
    const placed = bins.flatMap((b) => b.placements);
    expect(placed.length).toBe(items.length); // all placed exactly once
    expect(new Set(placed.map((p) => p.id)).size).toBe(items.length);
    for (const bin of bins) {
      expect(Number.isInteger(Math.log2(bin.w))).toBe(true); // POT
      expect(Number.isInteger(Math.log2(bin.h))).toBe(true);
      for (const p of bin.placements) {
        expect(p.x + p.w).toBeLessThanOrEqual(bin.w);
        expect(p.y + p.h).toBeLessThanOrEqual(bin.h);
      }
      for (let i = 0; i < bin.placements.length; i++)
        for (let j = i + 1; j < bin.placements.length; j++) expect(overlap(bin.placements[i]!, bin.placements[j]!)).toBe(false);
    }
  });

  it('spills into multiple maxSize bins when items exceed one', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: `big${i}`, w: 200, h: 200 }));
    const bins = pack(items, { maxSize: 256, allowRotation: false, padding: 0 }); // only 1 per 256² bin
    expect(bins.length).toBe(6);
  });
});

describe('repackAtlases (golden, on tp-hash-symbols)', () => {
  it('tightens a sparse sheet: occupancy up, VRAM down, every sprite kept', () => {
    const atlas = loadAtlas();
    const r = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 });
    expect(r.occupancyAfter).toBeGreaterThan(r.occupancyBefore);
    expect(r.vramBytesAfter).toBeLessThanOrEqual(r.vramBytesBefore);
    const names = r.atlases.flatMap((a) => a.sprites.map((s) => s.name)).sort();
    expect(names).toEqual(atlas.sprites.map((s) => s.name).sort());
    expect(r.blits.length).toBe(atlas.sprites.length);
  });

  it('is non-destructive: trim / sourceSize / spriteSourceSize / pivot copied verbatim', () => {
    const atlas = loadAtlas();
    const r = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 });
    const out = new Map(r.atlases.flatMap((a) => a.sprites).map((s) => [s.name, s]));
    for (const src of atlas.sprites) {
      const o = out.get(src.name)!;
      expect(o.rotated).toBe(src.rotated);
      expect(o.trimmed).toBe(src.trimmed);
      expect(o.sourceSize).toEqual(src.sourceSize);
      expect(o.spriteSourceSize).toEqual(src.spriteSourceSize);
      expect(o.pivot).toEqual(src.pivot);
      expect(o.frame.w).toBe(src.frame.w); // pixels relocated, not resized
      expect(o.frame.h).toBe(src.frame.h);
    }
  });

  it('emits a deterministic manifest that round-trips through the parser', () => {
    const atlas = loadAtlas();
    const repacked = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 }).atlases[0]!;
    const json1 = emitTexturePackerJson(repacked);
    const json2 = emitTexturePackerJson(repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 }).atlases[0]!);
    expect(json1).toBe(json2); // byte-identical → determinism

    const res = parseAtlasManifest(JSON.parse(json1), { imageRef: repacked.imageRef, imageSize: repacked.size });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.atlas).toEqual(repacked); // the contract closes: emit → parse → same Atlas
  });
});

describe('planFix', () => {
  it('plans a repack for the under-filled atlas', async () => {
    const report = await analyze([{ kind: 'atlas', atlas: loadAtlas(), image: { name: 'symbols.png', imageRef: 'symbols.png', size: { w: 512, h: 512 }, mime: 'image/png', byteSize: 1747 } }]);
    const plan = planFix(report, { targetMime: 'image/webp', quality: 0.9, lossless: true, padding: 2, maxSize: 4096, maxEdge: 2048, mergeAtlases: false });
    const repack = plan.ops.find((o) => o.kind === 'repack');
    expect(repack).toBeDefined();
    if (repack?.kind === 'repack') expect(repack.atlasRefs).toContain('symbols.png');
  });

  it('plans a resize for an oversized loose image (not an atlas), preferring it over transcode', () => {
    const report: AnalysisReport = {
      assets: [{ assetRef: 'hero.png', diskBytes: 1000, vramBytes: 4096 * 4096 * 4 }],
      findings: [
        { id: 'hero.png:oversize', rule: 'dimensions-oversize', severity: 'crit', assetRef: 'hero.png', title: '', detail: '', messageKey: 'oversize', params: { w: 4096, h: 4096, edge: 4096, budget: 2730, sev: 'crit', vram: 0 } },
        { id: 'hero.png:format', rule: 'format', severity: 'warn', assetRef: 'hero.png', title: '', detail: '' },
      ],
      totals: { diskBytes: 1000, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
      thresholds: DEFAULT_THRESHOLDS,
    };
    const plan = planFix(report, { targetMime: 'image/avif', quality: 0.85, lossless: false, padding: 2, maxSize: 4096, maxEdge: 2048, mergeAtlases: false });
    const resize = plan.ops.find((o) => o.kind === 'resize');
    expect(resize).toBeDefined();
    if (resize?.kind === 'resize') expect(resize.to).toEqual({ w: 2048, h: 2048 });
    expect(plan.ops.some((o) => o.kind === 'transcode')).toBe(false); // resize wins over transcode
  });

  it('merge mode collapses an atlas-merge group into one repack op; drop-in keeps them separate', () => {
    const atlas = (ref: string) => ({ assetRef: ref, diskBytes: 100, vramBytes: 256 * 256 * 4, occupancy: 0.125 });
    const report: AnalysisReport = {
      assets: [atlas('atlas_a.png'), atlas('atlas_b.png')],
      findings: [
        { id: 'atlas_a.png:occupancy', rule: 'occupancy', severity: 'crit', assetRef: 'atlas_a.png', title: '', detail: '' },
        { id: 'atlas_b.png:occupancy', rule: 'occupancy', severity: 'crit', assetRef: 'atlas_b.png', title: '', detail: '' },
        { id: 'folder:atlas-merge', rule: 'atlas-merge', severity: 'warn', scope: 'folder', assetRef: 'atlas_a.png', relatedRefs: ['atlas_a.png', 'atlas_b.png'], title: '', detail: '' },
      ],
      totals: { diskBytes: 200, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
      thresholds: DEFAULT_THRESHOLDS,
    };
    const base = { targetMime: 'image/webp' as const, quality: 0.9, lossless: true, padding: 2, maxSize: 4096, maxEdge: 2048 };

    const merged = planFix(report, { ...base, mergeAtlases: true });
    const repacks = merged.ops.filter((o) => o.kind === 'repack');
    expect(repacks).toHaveLength(1); // one merge op, not two individual repacks
    if (repacks[0]?.kind === 'repack') expect(repacks[0].atlasRefs).toEqual(['atlas_a.png', 'atlas_b.png']);

    const dropIn = planFix(report, { ...base, mergeAtlases: false });
    const single = dropIn.ops.filter((o) => o.kind === 'repack' && o.atlasRefs.length === 1);
    expect(single).toHaveLength(2); // each atlas repacked in place
    expect(dropIn.ops.some((o) => o.kind === 'repack' && o.atlasRefs.length > 1)).toBe(false);
  });
});
