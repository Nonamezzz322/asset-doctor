import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AnalysisReport, Atlas } from '@asset-doctor/core';
import { parseAtlas, parseAtlasManifest, parseSpineAtlasText, parseSpinePage } from '@asset-doctor/parsers';
import { analyze, DEFAULT_THRESHOLDS } from '@asset-doctor/analysis';
import { emitSpineAtlasText, emitTexturePackerJson, pack, planFix, repackAtlases, scaleAtlas, type Placement } from '../src/index';

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
    const plan = planFix(report, { targetMime: 'image/webp', quality: 0.9, lossless: true, padding: 2, maxSize: 4096, maxEdge: 2048, aggressive: false });
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
    const plan = planFix(report, { targetMime: 'image/avif', quality: 0.85, lossless: false, padding: 2, maxSize: 4096, maxEdge: 2048, aggressive: false });
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

    const merged = planFix(report, { ...base, aggressive: true });
    const repacks = merged.ops.filter((o) => o.kind === 'repack');
    expect(repacks).toHaveLength(1); // one merge op, not two individual repacks
    if (repacks[0]?.kind === 'repack') expect(repacks[0].atlasRefs).toEqual(['atlas_a.png', 'atlas_b.png']);

    const dropIn = planFix(report, { ...base, aggressive: false });
    const single = dropIn.ops.filter((o) => o.kind === 'repack' && o.atlasRefs.length === 1);
    expect(single).toHaveLength(2); // each atlas repacked in place
    expect(dropIn.ops.some((o) => o.kind === 'repack' && o.atlasRefs.length > 1)).toBe(false);
  });

  it('drops near-duplicates only in aggressive mode', () => {
    const report: AnalysisReport = {
      assets: [{ assetRef: 'a.png', diskBytes: 100, vramBytes: 0 }, { assetRef: 'b.png', diskBytes: 100, vramBytes: 0 }],
      findings: [{ id: 'dup-similar:a.png', rule: 'duplicate-similar', severity: 'info', scope: 'folder', assetRef: 'a.png', relatedRefs: ['a.png', 'b.png'], title: '', detail: '' }],
      totals: { diskBytes: 200, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
      thresholds: DEFAULT_THRESHOLDS,
    };
    const base = { targetMime: 'image/webp' as const, quality: 0.9, lossless: true, padding: 2, maxSize: 4096, maxEdge: 2048 };
    expect(planFix(report, { ...base, aggressive: false }).ops.some((o) => o.kind === 'drop')).toBe(false);
    const drops = planFix(report, { ...base, aggressive: true }).ops.filter((o) => o.kind === 'drop');
    expect(drops).toHaveLength(1);
    if (drops[0]?.kind === 'drop') expect(drops[0].assetRef).toBe('b.png');
  });

  it('plans a resize for an oversized ATLAS (occupancy-defined, not repacked)', () => {
    const report: AnalysisReport = {
      assets: [{ assetRef: 'big.json', diskBytes: 1000, vramBytes: 0, occupancy: 0.9 }],
      findings: [{ id: 'big.json:oversize', rule: 'dimensions-oversize', severity: 'crit', assetRef: 'big.json', title: '', detail: '', messageKey: 'oversize', params: { w: 4096, h: 4096, edge: 4096, budget: 2730, sev: 'crit', vram: 0 } }],
      totals: { diskBytes: 1000, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
      thresholds: DEFAULT_THRESHOLDS,
    };
    const resize = planFix(report, { targetMime: 'image/webp', quality: 0.9, lossless: true, padding: 2, maxSize: 4096, maxEdge: 2048, aggressive: false }).ops.find((o) => o.kind === 'resize');
    expect(resize).toBeDefined();
    if (resize?.kind === 'resize') {
      expect(resize.assetRef).toBe('big.json');
      expect(resize.to).toEqual({ w: 2048, h: 2048 });
    }
  });
});

describe('emitSpineAtlasText (inverse of the parser)', () => {
  const spineDir = fileURLToPath(new URL('../../../fixtures/sample-projects/spine-basic/', import.meta.url));
  it('round-trips: emit → parse → identical sprites', () => {
    const page = parseSpineAtlasText(readFileSync(`${spineDir}sheet.atlas`, 'utf8'))[0]!;
    const res = parseSpinePage(page, { ref: 'sheet.png', bytes: new Uint8Array(readFileSync(`${spineDir}sheet.png`)) });
    if (!res.ok || res.asset.kind !== 'atlas') throw new Error('spine fixture parse failed');
    const atlas = res.asset.atlas;
    const reParsed = parseSpineAtlasText(emitSpineAtlasText(atlas))[0]!;
    const sortByName = <T extends { name: string }>(a: T[]) => [...a].sort((x, y) => x.name.localeCompare(y.name));
    expect(sortByName(reParsed.sprites)).toEqual(sortByName(atlas.sprites));
    expect(reParsed.size).toEqual(atlas.size);
  });

  it('round-trips a trimmed region offset (spriteSourceSize)', () => {
    const atlas: Atlas = { name: 's', imageRef: 'sheet.png', size: { w: 256, h: 256 }, sprites: [{ name: 'r', frame: { x: 10, y: 20, w: 50, h: 40 }, rotated: false, trimmed: true, sourceSize: { w: 80, h: 60 }, spriteSourceSize: { x: 5, y: 8, w: 50, h: 40 } }], source: { kind: 'spine' } };
    const sp = parseSpineAtlasText(emitSpineAtlasText(atlas))[0]!.sprites[0]!;
    expect(sp.trimmed).toBe(true);
    expect(sp.spriteSourceSize).toEqual({ x: 5, y: 8, w: 50, h: 40 });
  });
});

describe('scaleAtlas', () => {
  it('uniformly halves the sheet and every frame', () => {
    const atlas = loadAtlas(); // 512²
    const s = scaleAtlas(atlas, 0.5);
    expect(s.size).toEqual({ w: 256, h: 256 });
    for (const src of atlas.sprites) {
      const o = s.sprites.find((x) => x.name === src.name)!;
      expect(o.frame.w).toBe(Math.max(1, Math.round(src.frame.w * 0.5)));
      expect(o.frame.h).toBe(Math.max(1, Math.round(src.frame.h * 0.5)));
      expect(o.rotated).toBe(src.rotated); // metadata preserved
    }
  });

  it('clamps frames inside the scaled sheet (no out-of-bounds after rounding)', () => {
    const atlas: Atlas = { name: 'a', imageRef: 'a.png', size: { w: 512, h: 512 }, sprites: [{ name: 'edge', frame: { x: 509, y: 509, w: 3, h: 3 }, rotated: false, trimmed: false, sourceSize: { w: 3, h: 3 } }], source: { kind: 'pixi' } };
    const s = scaleAtlas(atlas, 0.5); // independent rounding would push x+w to 257 > 256
    const f = s.sprites[0]!.frame;
    expect(f.x + f.w).toBeLessThanOrEqual(s.size.w);
    expect(f.y + f.h).toBeLessThanOrEqual(s.size.h);
  });
});
