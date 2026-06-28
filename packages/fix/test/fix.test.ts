import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AnalysisReport, Atlas, Blit, DedupGroup, FixOp, PackGroup } from '@asset-doctor/core';
import { parseAtlas, parseAtlasManifest, parseSpineAtlasText, parseSpinePage } from '@asset-doctor/parsers';
import { analyze, DEFAULT_THRESHOLDS } from '@asset-doctor/analysis';
import { ACC_CELL, buildAtlasAliasMap, emitSpineAtlasText, emitTexturePackerJson, pack, planFix, repackAtlases, repackAtlasesPolygon, scaleAtlas, type AtlasAliasMap, type MaskItem, type Placement, type RawMesh } from '../src/index';

const fixDir = fileURLToPath(new URL('../../../fixtures/sample-projects/tp-hash-symbols/', import.meta.url));
function loadAtlas(): Atlas {
  const manifest = JSON.parse(readFileSync(`${fixDir}symbols.json`, 'utf8')) as unknown;
  const bytes = new Uint8Array(readFileSync(`${fixDir}symbols.png`));
  const res = parseAtlas(manifest, { ref: 'symbols.png', bytes });
  if (!res.ok || res.asset.kind !== 'atlas') throw new Error('fixture parse failed');
  return res.asset.atlas;
}

// The frame-redundant fixture: a 256×32 strip, 100% packed (8×32×32). The four idle_* frames are
// byte-identical pixel regions (one cluster of 4 distinct rects) + four distinct walk_* frames.
const frDir = fileURLToPath(new URL('../../../fixtures/sample-projects/frame-redundant/', import.meta.url));
function loadFrameRedundantAtlas(): Atlas {
  const manifest = JSON.parse(readFileSync(`${frDir}anim.json`, 'utf8')) as unknown;
  const bytes = new Uint8Array(readFileSync(`${frDir}anim.png`));
  const res = parseAtlas(manifest, { ref: 'anim.png', bytes });
  if (!res.ok || res.asset.kind !== 'atlas') throw new Error('frame-redundant fixture parse failed');
  return res.asset.atlas;
}
// The documented cluster: idle_* share one region hash, walk_* each distinct (mirrors the analysis golden,
// robust to parser ordering). The alias map is built from these hashes exactly as the worker builds it.
const frFrameHashes = (atlas: Atlas): (string | null)[] => atlas.sprites.map((s) => (s.name.startsWith('idle_') ? 'idle' : s.name));
const frAliasMaps = (atlas: Atlas): Map<string, AtlasAliasMap> =>
  new Map([[atlas.name, buildAtlasAliasMap(atlas.sprites, frFrameHashes(atlas), DEFAULT_THRESHOLDS.frameRedundancy!.minDuplicates)]]);

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

  it('a flat/alpha-art format finding ⇒ transcode lossless:true even when opts.lossless is false', () => {
    const report: AnalysisReport = {
      assets: [{ assetRef: 'flat.png', diskBytes: 1000, vramBytes: 0 }, { assetRef: 'photo.png', diskBytes: 1000, vramBytes: 0 }],
      findings: [
        { id: 'flat.png:format', rule: 'format', severity: 'warn', assetRef: 'flat.png', title: '', detail: '', messageKey: 'format-lossless', params: { contentClass: 'flat' } },
        { id: 'photo.png:format', rule: 'format', severity: 'warn', assetRef: 'photo.png', title: '', detail: '' },
      ],
      totals: { diskBytes: 2000, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
      thresholds: DEFAULT_THRESHOLDS,
    };
    const plan = planFix(report, { targetMime: 'image/webp', quality: 0.9, lossless: false, padding: 2, maxSize: 4096, maxEdge: 2048, aggressive: false });
    const transcodes = plan.ops.filter((o): o is Extract<FixOp, { kind: 'transcode' }> => o.kind === 'transcode');
    const flat = transcodes.find((o) => o.assetRef === 'flat.png');
    const photo = transcodes.find((o) => o.assetRef === 'photo.png');
    expect(flat?.lossless).toBe(true); // class forces lossless despite opts.lossless:false
    expect(photo?.lossless).toBe(false); // photographic follows opts.lossless
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

// ── Opaque-alpha (round15) — the Pro fix for `wasted-alpha` findings ──────────────────────────────
// planFix's `opts.opaqueAlpha` stamps `opaque:true` on the transcode op for every wasted-alpha-flagged
// loose ref (DISK-only, invariant 5). Pure data assertions: exactly one transcode op per ref, carrying
// opaque:true and targeting opts.targetMime (NEVER a source mime — the plan holds none). OFF ⇒ no op
// carries `opaque` ⇒ byte-identical. format + wasted-alpha ⇒ one op (folded), not two. Order-independent.
describe('planFix — opaque-alpha (wasted-alpha fix)', () => {
  const base = { targetMime: 'image/avif' as const, quality: 0.85, lossless: false, padding: 2, maxSize: 4096, maxEdge: 2048 };
  const transcodes = (plan: { ops: FixOp[] }) => plan.ops.filter((o): o is Extract<FixOp, { kind: 'transcode' }> => o.kind === 'transcode');
  const wastedAlpha = (ref: string): AnalysisReport['findings'][number] =>
    ({ id: `${ref}:wasted-alpha`, rule: 'wasted-alpha', severity: 'warn', assetRef: ref, title: '', detail: '', messageKey: 'wasted-alpha', params: { srcLabel: 'PNG', srcBytes: 1000, opaqueBytes: 700, saved: 300, frac: 0.3 } });
  const reportOf = (findings: AnalysisReport['findings']): AnalysisReport => ({
    assets: findings.map((f) => ({ assetRef: f.assetRef, diskBytes: 1000, vramBytes: 0 })),
    findings,
    totals: { diskBytes: 1000, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
    thresholds: DEFAULT_THRESHOLDS,
  });

  it('OFF ⇒ no transcode op carries opaque (byte-identical to today)', () => {
    const report = reportOf([wastedAlpha('logo.png')]);
    const plan = planFix(report, { ...base, aggressive: false }); // opaqueAlpha omitted
    expect(plan.ops.some((o) => o.kind === 'transcode' && o.opaque)).toBe(false);
    // A wasted-alpha-only finding with the toggle off emits NO transcode op at all (diagnosis-only).
    expect(transcodes(plan)).toHaveLength(0);
  });

  it('ON, wasted-alpha-only ref ⇒ a standalone opaque transcode to opts.targetMime', () => {
    const report = reportOf([wastedAlpha('logo.png')]);
    const plan = planFix(report, { ...base, aggressive: false, opaqueAlpha: true });
    const ts = transcodes(plan);
    expect(ts).toHaveLength(1);
    expect(ts[0]!.assetRef).toBe('logo.png');
    expect(ts[0]!.opaque).toBe(true);
    expect(ts[0]!.targetMime).toBe('image/avif'); // opts.targetMime, NEVER the source mime
  });

  it('ON, format + wasted-alpha for the same ref ⇒ EXACTLY ONE transcode op carrying opaque:true', () => {
    const report = reportOf([
      { id: 'logo.png:format', rule: 'format', severity: 'warn', assetRef: 'logo.png', title: '', detail: '' },
      wastedAlpha('logo.png'),
    ]);
    const plan = planFix(report, { ...base, aggressive: false, opaqueAlpha: true });
    const ts = transcodes(plan);
    expect(ts).toHaveLength(1); // folded into the format transcode — never two ops
    expect(ts[0]!.opaque).toBe(true);
    expect(ts[0]!.targetMime).toBe('image/avif');
  });

  it('ON, order-independent: wasted-alpha BEFORE the format finding still folds into one opaque op', () => {
    const report = reportOf([
      wastedAlpha('logo.png'), // appears first
      { id: 'logo.png:format', rule: 'format', severity: 'warn', assetRef: 'logo.png', title: '', detail: '' },
    ]);
    const plan = planFix(report, { ...base, aggressive: false, opaqueAlpha: true });
    const ts = transcodes(plan);
    expect(ts).toHaveLength(1);
    expect(ts[0]!.opaque).toBe(true);
  });

  it('ON, a wasted-alpha ref also RESIZED ⇒ no opaque transcode (resize owns the re-encode)', () => {
    const report = reportOf([
      { id: 'big.png:oversize', rule: 'dimensions-oversize', severity: 'crit', assetRef: 'big.png', title: '', detail: '', messageKey: 'oversize', params: { w: 4096, h: 4096, edge: 4096, budget: 2730, sev: 'crit', vram: 0 } },
      wastedAlpha('big.png'),
    ]);
    const plan = planFix(report, { ...base, aggressive: false, opaqueAlpha: true });
    expect(plan.ops.some((o) => o.kind === 'resize' && o.assetRef === 'big.png')).toBe(true);
    expect(transcodes(plan)).toHaveLength(0); // resize wins; no standalone opaque transcode
  });

  it('ON, a folder-scope wasted-alpha finding is ignored (no single op target)', () => {
    const report = reportOf([{ ...wastedAlpha('logo.png'), scope: 'folder' as const }]);
    const plan = planFix(report, { ...base, aggressive: false, opaqueAlpha: true });
    expect(transcodes(plan)).toHaveLength(0);
  });
});

// ── Per-image MEASURED best-format pick (round17) ─────────────────────────────────────────────────
// planFix's `opts.bestFormatPerImage` routes each LOOSE `format` transcode op to the winner the diagnosis
// ALREADY measured (params.bestMime) instead of the single global opts.targetMime. Pure data assertions:
// ON ⇒ each op carries its finding's bestMime; absent/malformed bestMime ⇒ opts.targetMime (fail-safe);
// OFF (default) ⇒ EVERY op carries opts.targetMime and the op array deep-equals the pre-change baseline;
// atlas/resize findings under ON ⇒ still opts.targetMime; the standalone opaque transcode keeps the global
// target. NO encoding — the plan only routes (invariant 3).
describe('planFix — per-image measured best-format pick (round17)', () => {
  const base = { targetMime: 'image/webp' as const, quality: 0.85, lossless: false, padding: 2, maxSize: 4096, maxEdge: 2048, aggressive: false };
  const transcodes = (plan: { ops: FixOp[] }) => plan.ops.filter((o): o is Extract<FixOp, { kind: 'transcode' }> => o.kind === 'transcode');
  // A loose `format` finding carrying a measured bestMime (mirrors formatFinding's params shape).
  const fmt = (ref: string, bestMime?: string): AnalysisReport['findings'][number] =>
    ({ id: `${ref}:format`, rule: 'format', severity: 'warn', assetRef: ref, title: '', detail: '', messageKey: 'format', params: bestMime === undefined ? {} : { bestMime } });
  const reportOf = (findings: AnalysisReport['findings']): AnalysisReport => ({
    assets: findings.map((f) => ({ assetRef: f.assetRef, diskBytes: 1000, vramBytes: 0 })),
    findings,
    totals: { diskBytes: 1000, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
    thresholds: DEFAULT_THRESHOLDS,
  });

  it('ON ⇒ each loose transcode targets its finding\'s MEASURED bestMime (per-image, not the global target)', () => {
    const report = reportOf([fmt('logo.png', 'image/webp'), fmt('bg.png', 'image/avif')]);
    const ts = transcodes(planFix(report, { ...base, bestFormatPerImage: true }));
    expect(ts.find((o) => o.assetRef === 'logo.png')!.targetMime).toBe('image/webp');
    expect(ts.find((o) => o.assetRef === 'bg.png')!.targetMime).toBe('image/avif'); // differs from global webp
  });

  it('ON, a finding with NO bestMime ⇒ falls back to opts.targetMime (atlas / no-encoder report)', () => {
    const ts = transcodes(planFix(reportOf([fmt('x.png')]), { ...base, bestFormatPerImage: true }));
    expect(ts).toHaveLength(1);
    expect(ts[0]!.targetMime).toBe('image/webp'); // opts.targetMime
  });

  it('ON, a MALFORMED bestMime ⇒ guard rejects ⇒ opts.targetMime (fail-safe)', () => {
    const ts = transcodes(planFix(reportOf([fmt('x.png', 'image/tiff')]), { ...base, bestFormatPerImage: true }));
    expect(ts[0]!.targetMime).toBe('image/webp');
  });

  it('OFF (default) ⇒ every op carries opts.targetMime AND the op array deep-equals the pre-change baseline', () => {
    const report = reportOf([fmt('logo.png', 'image/avif'), fmt('bg.png', 'image/webp')]);
    const off = planFix(report, base); // bestFormatPerImage omitted
    expect(transcodes(off).every((o) => o.targetMime === 'image/webp')).toBe(true);
    // Byte-identity (additivity): explicit-false === absent === the bestMime-blind run.
    expect(planFix(report, { ...base, bestFormatPerImage: false })).toEqual(off);
    expect(planFix(reportOf([fmt('logo.png'), fmt('bg.png')]), base)).toEqual(off); // bestMime is inert when OFF
  });

  it('ON, a resized ref keeps opts.targetMime (round17 routes ONLY the pass-2 format transcode)', () => {
    const report = reportOf([
      { id: 'big.png:oversize', rule: 'dimensions-oversize', severity: 'crit', assetRef: 'big.png', title: '', detail: '', messageKey: 'oversize', params: { w: 4096, h: 4096, edge: 4096, budget: 2730, sev: 'crit', vram: 0 } },
      fmt('big.png', 'image/avif'),
    ]);
    const plan = planFix(report, { ...base, bestFormatPerImage: true });
    const resize = plan.ops.find((o): o is Extract<FixOp, { kind: 'resize' }> => o.kind === 'resize')!;
    expect(resize.targetMime).toBe('image/webp'); // resize keeps the global target (measured on full size)
    expect(transcodes(plan)).toHaveLength(0); // resize wins over transcode
  });

  it('ON, the standalone opaque transcode keeps opts.targetMime (no format finding ⇒ no measured bestMime)', () => {
    const report = reportOf([{ id: 'logo.png:wasted-alpha', rule: 'wasted-alpha', severity: 'warn', assetRef: 'logo.png', title: '', detail: '', messageKey: 'wasted-alpha', params: { srcLabel: 'PNG', srcBytes: 1000, opaqueBytes: 700, saved: 300, frac: 0.3 } }]);
    const ts = transcodes(planFix(report, { ...base, bestFormatPerImage: true, opaqueAlpha: true }));
    expect(ts).toHaveLength(1);
    expect(ts[0]!.opaque).toBe(true);
    expect(ts[0]!.targetMime).toBe('image/webp'); // pass-2b uses opts.targetMime
  });

  it('ON, format + wasted-alpha for one ref ⇒ ONE op carrying bestMime AND opaque:true (folded, no double-emit)', () => {
    const report = reportOf([
      fmt('logo.png', 'image/avif'),
      { id: 'logo.png:wasted-alpha', rule: 'wasted-alpha', severity: 'warn', assetRef: 'logo.png', title: '', detail: '', messageKey: 'wasted-alpha', params: { srcLabel: 'PNG', srcBytes: 1000, opaqueBytes: 700, saved: 300, frac: 0.3 } },
    ]);
    const ts = transcodes(planFix(report, { ...base, bestFormatPerImage: true, opaqueAlpha: true }));
    expect(ts).toHaveLength(1);
    expect(ts[0]!.targetMime).toBe('image/avif'); // measured winner
    expect(ts[0]!.opaque).toBe(true); // opaque folded in
  });
});

// ── Owner-aware dedup drop path (design §3d / §10) ───────────────────────────────────────────────
// planFix's THIRD argument (DedupGroup[]) turns exact-dup drops into OWNER-AWARE drops: one drop per
// consumer carrying `ownerRef`, with `repointManifest:true` only for atlas consumers (isAtlasRef). Owners
// are added to a protectedOwners set and must NEVER be a drop/merge/resize target. These are pure data
// assertions on op kinds — the most testable part of the new fix-side logic.
describe('planFix — owner-aware dedup drops (groups)', () => {
  const base = { targetMime: 'image/webp' as const, quality: 0.9, lossless: true, padding: 2, maxSize: 4096, maxEdge: 2048 };
  const drops = (plan: { ops: FixOp[] }) => plan.ops.filter((o): o is Extract<FixOp, { kind: 'drop' }> => o.kind === 'drop');

  /** Minimal report: just the assets, no findings (the dedup plan is data-driven via groups). */
  const reportOf = (refs: string[]): AnalysisReport => ({
    assets: refs.map((assetRef) => ({ assetRef, diskBytes: 100, vramBytes: 0 })),
    findings: [],
    totals: { diskBytes: refs.length * 100, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
    thresholds: DEFAULT_THRESHOLDS,
  });

  it('each consumer becomes a drop op carrying ownerRef (one per consumer, not a bare-drop)', () => {
    const groups: DedupGroup[] = [
      {
        contentHash: 'h1',
        pool: 'pixi',
        skinGroup: 'general',
        owners: ['core/a.png'],
        consumers: [
          { ref: 'lvl1/a.png', ownerRef: 'core/a.png', reason: 'eager-owner-cross-bundle' },
          { ref: 'lvl2/a.png', ownerRef: 'core/a.png', reason: 'eager-owner-cross-bundle' },
        ],
      },
    ];
    const plan = planFix(reportOf(['core/a.png', 'lvl1/a.png', 'lvl2/a.png']), { ...base, aggressive: true }, groups);
    const d = drops(plan);
    expect(d).toHaveLength(2); // one drop per consumer
    expect(d.map((o) => o.assetRef).sort()).toEqual(['lvl1/a.png', 'lvl2/a.png']);
    for (const o of d) {
      expect(o.reason).toBe('duplicate-exact');
      expect(o.ownerRef).toBe('core/a.png'); // each drop is bound to its owner
    }
    // The OWNER is never a drop target.
    expect(d.some((o) => o.assetRef === 'core/a.png')).toBe(false);
  });

  it('repointManifest:true only when isAtlasRef returns true for the consumer', () => {
    const groups: DedupGroup[] = [
      {
        contentHash: 'h2',
        pool: 'pixi',
        skinGroup: 'general',
        owners: ['main/sheet.png'],
        consumers: [
          { ref: 'extra/sheet.png', ownerRef: 'main/sheet.png', reason: 'eager-owner-cross-bundle' }, // atlas
          { ref: 'extra/loose.png', ownerRef: 'main/sheet.png', reason: 'eager-owner-cross-bundle' }, // loose
        ],
      },
    ];
    const isAtlasRef = (ref: string) => ref === 'extra/sheet.png' || ref === 'main/sheet.png';
    const plan = planFix(reportOf(['main/sheet.png', 'extra/sheet.png', 'extra/loose.png']), { ...base, aggressive: true, isAtlasRef }, groups);
    const byRef = new Map(drops(plan).map((o) => [o.assetRef, o]));
    expect(byRef.get('extra/sheet.png')?.repointManifest).toBe(true); // atlas consumer → repoint meta.image
    expect('repointManifest' in (byRef.get('extra/loose.png') ?? {})).toBe(false); // loose consumer → bare drop, no key
  });

  it('an owner is never a drop/repack/resize target even when it also matches occupancy/oversize/atlas-merge', () => {
    // owner core/sheet.png ALSO carries an occupancy + oversize finding AND is in an atlas-merge group.
    const report: AnalysisReport = {
      assets: [
        { assetRef: 'core/sheet.png', diskBytes: 100, vramBytes: 4096 * 4096 * 4, occupancy: 0.1 },
        { assetRef: 'core/other.png', diskBytes: 100, vramBytes: 256 * 256 * 4, occupancy: 0.1 },
        { assetRef: 'extra/sheet.png', diskBytes: 100, vramBytes: 0 },
      ],
      findings: [
        { id: 'core/sheet.png:occupancy', rule: 'occupancy', severity: 'crit', assetRef: 'core/sheet.png', title: '', detail: '' },
        { id: 'core/sheet.png:oversize', rule: 'dimensions-oversize', severity: 'crit', assetRef: 'core/sheet.png', title: '', detail: '', messageKey: 'oversize', params: { w: 4096, h: 4096, edge: 4096, budget: 2730, sev: 'crit', vram: 0 } },
        { id: 'folder:atlas-merge', rule: 'atlas-merge', severity: 'warn', scope: 'folder', assetRef: 'core/sheet.png', relatedRefs: ['core/sheet.png', 'core/other.png'], title: '', detail: '' },
      ],
      totals: { diskBytes: 300, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
      thresholds: DEFAULT_THRESHOLDS,
    };
    const groups: DedupGroup[] = [
      { contentHash: 'h3', pool: 'pixi', skinGroup: 'general', owners: ['core/sheet.png'], consumers: [{ ref: 'extra/sheet.png', ownerRef: 'core/sheet.png', reason: 'eager-owner-cross-bundle' }] },
    ];
    const plan = planFix(report, { ...base, aggressive: true, isAtlasRef: (r) => r.endsWith('.png') }, groups);
    // The owner must NOT be repacked, resized, merged, or dropped — protectedOwners guards every pass.
    expect(plan.ops.some((o) => o.kind === 'repack' && o.atlasRefs.includes('core/sheet.png'))).toBe(false);
    expect(plan.ops.some((o) => o.kind === 'resize' && o.assetRef === 'core/sheet.png')).toBe(false);
    expect(plan.ops.some((o) => o.kind === 'drop' && o.assetRef === 'core/sheet.png')).toBe(false);
    // The consumer is still dropped (owner-aware), and the non-owner peer can still be repacked.
    expect(plan.ops.some((o) => o.kind === 'drop' && o.assetRef === 'extra/sheet.png' && o.ownerRef === 'core/sheet.png')).toBe(true);
  });

  it('near-duplicates still use the legacy bare-drop path when groups is supplied (only exact dupes are owner-modelled)', () => {
    const report: AnalysisReport = {
      assets: [{ assetRef: 'x/a.png', diskBytes: 100, vramBytes: 0 }, { assetRef: 'x/b.png', diskBytes: 100, vramBytes: 0 }],
      findings: [{ id: 'dup-similar', rule: 'duplicate-similar', severity: 'info', scope: 'folder', assetRef: 'x/a.png', relatedRefs: ['x/a.png', 'x/b.png'], title: '', detail: '' }],
      totals: { diskBytes: 200, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
      thresholds: DEFAULT_THRESHOLDS,
    };
    // exact-dup groups present (empty here) but the near-dup finding must still produce a BARE drop.
    const plan = planFix(report, { ...base, aggressive: true }, []);
    const d = drops(plan);
    expect(d).toHaveLength(1);
    expect(d[0]?.assetRef).toBe('x/b.png');
    expect(d[0]?.reason).toBe('duplicate-similar');
    expect(d[0]?.ownerRef).toBeUndefined(); // legacy bare-drop — no owner info for near-dupes
  });

  it('legacy two-arg path unchanged: exact dupes drop every copy after the first with NO owner info', () => {
    // No DedupGroup[] arg at all ⇒ today's behavior. An exact-duplicate finding must drop copies 2..n
    // via the bare-drop path: no ownerRef, no repointManifest, even though isAtlasRef would say "atlas".
    const report: AnalysisReport = {
      assets: ['p/a.png', 'q/a.png', 'r/a.png'].map((assetRef) => ({ assetRef, diskBytes: 100, vramBytes: 0 })),
      findings: [{ id: 'dup-exact', rule: 'duplicate-exact', severity: 'warn', scope: 'folder', assetRef: 'p/a.png', relatedRefs: ['p/a.png', 'q/a.png', 'r/a.png'], title: '', detail: '' }],
      totals: { diskBytes: 300, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
      thresholds: DEFAULT_THRESHOLDS,
    };
    // isAtlasRef is supplied but must NOT take effect — the third arg (groups) is absent, so the
    // owner-aware path is never entered and repointManifest is never set.
    const plan = planFix(report, { ...base, aggressive: true, isAtlasRef: () => true });
    const d = drops(plan);
    expect(d.map((o) => o.assetRef)).toEqual(['q/a.png', 'r/a.png']); // copies after the first, in order
    for (const o of d) {
      expect(o.reason).toBe('duplicate-exact');
      expect(o.ownerRef).toBeUndefined(); // bare-drop carries no owner
      expect('repointManifest' in o).toBe(false); // and never repoints — that's owner-aware only
    }
    expect(d.some((o) => o.assetRef === 'p/a.png')).toBe(false); // the first copy is retained
  });
});

// ── Pack pass (Feature 4, design §8) ─────────────────────────────────────────────────────────────
// planFix's FOURTH argument (PackGroup[]) emits one `pack` op per non-empty group, AFTER dedup pass 0a
// (so `dropped` is populated) and BEFORE pass 1. Pack OWNERS only: a region.ref already in `dropped` is
// excluded. A `packed` set guards pass-2 transcode so a both-findings ref → exactly one pack, zero
// transcode. No PackGroup[] ⇒ no pack ops (legacy path intact).
describe('planFix — pack pass (packGroups)', () => {
  const base = { targetMime: 'image/webp' as const, quality: 0.9, lossless: true, padding: 2, maxSize: 4096, maxEdge: 2048 };
  const region = (ref: string, name: string): { ref: string; name: string; sourceSize: { w: number; h: number } } => ({ ref, name, sourceSize: { w: 64, h: 64 } });
  const staticGroup = (id: string, refs: [string, string][]): PackGroup => ({
    id, kind: 'static', root: 'icons', outDir: 'icons', stem: id,
    regions: refs.map(([ref, name]) => region(ref, name)),
  });
  const packs = (plan: { ops: FixOp[] }) => plan.ops.filter((o): o is Extract<FixOp, { kind: 'pack' }> => o.kind === 'pack');

  /** Loose images carrying BOTH a should-atlas (folder) finding and per-asset format findings. */
  const reportOf = (refs: string[]): AnalysisReport => ({
    assets: refs.map((assetRef) => ({ assetRef, diskBytes: 100, vramBytes: 0 })),
    findings: [
      { id: 'folder:should-atlas', rule: 'should-atlas', severity: 'warn', scope: 'folder', assetRef: refs[0]!, relatedRefs: refs, title: '', detail: '' },
      ...refs.map((assetRef) => ({ id: `${assetRef}:format`, rule: 'format' as const, severity: 'warn' as const, assetRef, title: '', detail: '' })),
    ],
    totals: { diskBytes: refs.length * 100, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
    thresholds: DEFAULT_THRESHOLDS,
  });

  it('no PackGroup[] ⇒ no pack ops (legacy path unchanged; format findings still transcode)', () => {
    const plan = planFix(reportOf(['icons/a.png', 'icons/b.png']), { ...base, aggressive: false });
    expect(packs(plan)).toHaveLength(0);
    expect(plan.ops.filter((o) => o.kind === 'transcode')).toHaveLength(2); // both still transcode
  });

  it('emits one pack op per non-empty group with the approved defaults (trim, no rotation)', () => {
    const groups = [staticGroup('icons', [['icons/a.png', 'a'], ['icons/b.png', 'b']])];
    const plan = planFix(reportOf(['icons/a.png', 'icons/b.png']), { ...base, aggressive: false }, undefined, groups);
    const p = packs(plan);
    expect(p).toHaveLength(1);
    expect(p[0]!.trim).toBe(true);
    expect(p[0]!.allowRotation).toBe(false);
    expect(p[0]!.padding).toBe(2);
    expect(p[0]!.maxSize).toBe(4096);
    expect(p[0]!.targetMime).toBe('image/webp');
    expect(p[0]!.group.regions.map((r) => r.ref)).toEqual(['icons/a.png', 'icons/b.png']);
  });

  it('a ref with BOTH should-atlas and format → exactly ONE pack op and ZERO transcode ops', () => {
    const groups = [staticGroup('icons', [['icons/a.png', 'a'], ['icons/b.png', 'b']])];
    const plan = planFix(reportOf(['icons/a.png', 'icons/b.png']), { ...base, aggressive: false }, undefined, groups);
    expect(packs(plan)).toHaveLength(1);
    expect(packs(plan)[0]!.group.regions).toHaveLength(2);
    expect(plan.ops.filter((o) => o.kind === 'transcode')).toHaveLength(0); // packed refs are NOT transcoded
    // exactly one op touches each packed ref (no pack+transcode double-emit)
    for (const ref of ['icons/a.png', 'icons/b.png']) {
      const touching = plan.ops.filter((o) => (o.kind === 'transcode' || o.kind === 'resize' || o.kind === 'drop') && o.assetRef === ref);
      expect(touching).toHaveLength(0);
    }
  });

  it('pack OWNERS only: a loose ref scheduled for drop by dedup is excluded from its group', () => {
    // icons/b.png is an exact-dup consumer of icons/a.png (dropped in pass 0a) — it must NOT be packed.
    const dedup: DedupGroup[] = [
      { contentHash: 'h', pool: 'pixi', skinGroup: 'general', owners: ['icons/a.png'], consumers: [{ ref: 'icons/b.png', ownerRef: 'icons/a.png', reason: 'eager-owner-cross-bundle' }] },
    ];
    const groups = [staticGroup('icons', [['icons/a.png', 'a'], ['icons/b.png', 'b']])];
    const report: AnalysisReport = {
      assets: [{ assetRef: 'icons/a.png', diskBytes: 100, vramBytes: 0 }, { assetRef: 'icons/b.png', diskBytes: 100, vramBytes: 0 }],
      findings: [],
      totals: { diskBytes: 200, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
      thresholds: DEFAULT_THRESHOLDS,
    };
    const plan = planFix(report, { ...base, aggressive: true }, dedup, groups);
    const p = packs(plan);
    expect(p).toHaveLength(1);
    expect(p[0]!.group.regions.map((r) => r.ref)).toEqual(['icons/a.png']); // owner packed, consumer excluded
    // the dropped consumer is never in a pack group
    expect(p.some((o) => o.group.regions.some((r) => r.ref === 'icons/b.png'))).toBe(false);
  });

  it('a group whose every region is dropped emits NO pack op', () => {
    const dedup: DedupGroup[] = [
      { contentHash: 'h', pool: 'pixi', skinGroup: 'general', owners: ['kept/a.png'], consumers: [{ ref: 'icons/a.png', ownerRef: 'kept/a.png', reason: 'eager-owner-cross-bundle' }] },
    ];
    const groups = [staticGroup('icons', [['icons/a.png', 'a']])];
    const report: AnalysisReport = {
      assets: [{ assetRef: 'kept/a.png', diskBytes: 100, vramBytes: 0 }, { assetRef: 'icons/a.png', diskBytes: 100, vramBytes: 0 }],
      findings: [],
      totals: { diskBytes: 200, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
      thresholds: DEFAULT_THRESHOLDS,
    };
    const plan = planFix(report, { ...base, aggressive: true }, dedup, groups);
    expect(packs(plan)).toHaveLength(0);
  });

  // §11.11: a packed SPINE region is NEVER in `dropped`. Spine pool consumers are hard-kept by Phase C
  // (fix.worker.ts) so they're never dropped; here a spine group's regions are OWNERS → packed, and no
  // `drop` op may touch any of them (no double-handling of a region the .atlas ships).
  it('a packed spine region is never dropped (owners packed, zero drop ops on them)', () => {
    const spineGroup: PackGroup = {
      id: 'spine:char', kind: 'spine', root: 'char', outDir: 'char', stem: 'char', skeletonRef: 'char/skeleton.json',
      regions: [region('char/head.png', 'head'), region('char/items/sword.png', 'items/sword')],
    };
    // An exact-dup elsewhere that DOES drop a non-spine consumer — proves drops still happen, just not on
    // the spine regions. The spine regions are owners (never consumers), so dedup never schedules them.
    const dedup: DedupGroup[] = [
      { contentHash: 'h', pool: 'pixi', skinGroup: 'general', owners: ['kept/x.png'], consumers: [{ ref: 'other/x.png', ownerRef: 'kept/x.png', reason: 'eager-owner-cross-bundle' }] },
    ];
    const report: AnalysisReport = {
      assets: [{ assetRef: 'char/head.png', diskBytes: 100, vramBytes: 0 }, { assetRef: 'char/items/sword.png', diskBytes: 100, vramBytes: 0 }, { assetRef: 'kept/x.png', diskBytes: 100, vramBytes: 0 }, { assetRef: 'other/x.png', diskBytes: 100, vramBytes: 0 }],
      findings: [],
      totals: { diskBytes: 400, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
      thresholds: DEFAULT_THRESHOLDS,
    };
    const plan = planFix(report, { ...base, aggressive: true }, dedup, [spineGroup]);
    const p = packs(plan);
    expect(p).toHaveLength(1);
    expect(p[0]!.group.kind).toBe('spine');
    expect(p[0]!.group.regions.map((r) => r.ref)).toEqual(['char/head.png', 'char/items/sword.png']); // both owners packed
    const droppedRefs = plan.ops.filter((o): o is Extract<FixOp, { kind: 'drop' }> => o.kind === 'drop').map((o) => o.assetRef);
    for (const r of spineGroup.regions) expect(droppedRefs).not.toContain(r.ref); // never dropped
    expect(droppedRefs).toContain('other/x.png'); // unrelated dedup drop still fires (drops aren't disabled)
  });

  it('groups are emitted deterministically by PackGroup.id regardless of input order', () => {
    const a = staticGroup('aaa', [['x/a.png', 'a']]);
    const b = staticGroup('bbb', [['x/b.png', 'b']]);
    const c = staticGroup('ccc', [['x/c.png', 'c']]);
    const report = reportOf(['x/a.png', 'x/b.png', 'x/c.png']);
    const order1 = packs(planFix(report, { ...base, aggressive: false }, undefined, [c, a, b])).map((o) => o.group.id);
    const order2 = packs(planFix(report, { ...base, aggressive: false }, undefined, [b, c, a])).map((o) => o.group.id);
    expect(order1).toEqual(['aaa', 'bbb', 'ccc']);
    expect(order2).toEqual(['aaa', 'bbb', 'ccc']);
  });
});

// ── Edge-extrude threading (T6 / docs/improvements/edge-extrude.md OPTION A) ──────────────────────
// planFix stamps the requested bleed px (floored, non-negative) onto EVERY repack + pack op — the only
// ops whose worker compose blits a rectangle the symmetric gutter can wrap. resize/transcode/drop ops
// are never touched. extrude unset/0/negative ⇒ NO op carries `extrude` ⇒ ops byte-identical to today
// (default OFF). The plan does NOT size the gutter (the worker derives gutter = max(padding, extrude)).
describe('planFix — edge-extrude threading', () => {
  const base = { targetMime: 'image/webp' as const, quality: 0.9, lossless: true, padding: 2, maxSize: 4096, maxEdge: 2048, aggressive: false };
  // One occupancy atlas (→ pass-1 repack) + one should-atlas group (→ pack) + one oversized loose image
  // (→ resize) + one format-only loose image (→ transcode): all four op kinds in one plan.
  const report: AnalysisReport = {
    assets: [
      { assetRef: 'sheet.png', diskBytes: 100, vramBytes: 256 * 256 * 4, occupancy: 0.1 },
      { assetRef: 'icons/a.png', diskBytes: 100, vramBytes: 0 },
      { assetRef: 'icons/b.png', diskBytes: 100, vramBytes: 0 },
      { assetRef: 'hero.png', diskBytes: 100, vramBytes: 0 },
      { assetRef: 'logo.png', diskBytes: 100, vramBytes: 0 },
    ],
    findings: [
      { id: 'sheet.png:occupancy', rule: 'occupancy', severity: 'crit', assetRef: 'sheet.png', title: '', detail: '' },
      { id: 'folder:should-atlas', rule: 'should-atlas', severity: 'warn', scope: 'folder', assetRef: 'icons/a.png', relatedRefs: ['icons/a.png', 'icons/b.png'], title: '', detail: '' },
      { id: 'hero.png:oversize', rule: 'dimensions-oversize', severity: 'crit', assetRef: 'hero.png', title: '', detail: '', messageKey: 'oversize', params: { w: 4096, h: 4096, edge: 4096, budget: 2730, sev: 'crit', vram: 0 } },
      { id: 'logo.png:format', rule: 'format', severity: 'warn', assetRef: 'logo.png', title: '', detail: '' },
    ],
    totals: { diskBytes: 500, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
    thresholds: DEFAULT_THRESHOLDS,
  };
  const packGroups: PackGroup[] = [{ id: 'icons', kind: 'static', root: 'icons', outDir: 'icons', stem: 'icons', regions: [{ ref: 'icons/a.png', name: 'a', sourceSize: { w: 64, h: 64 } }, { ref: 'icons/b.png', name: 'b', sourceSize: { w: 64, h: 64 } }] }];

  it('stamps extrude on repack + pack ops only (never resize/transcode)', () => {
    const plan = planFix(report, { ...base, extrude: 2 }, undefined, packGroups);
    const repack = plan.ops.find((o) => o.kind === 'repack');
    const packOp = plan.ops.find((o) => o.kind === 'pack');
    const resize = plan.ops.find((o) => o.kind === 'resize');
    const transcode = plan.ops.find((o) => o.kind === 'transcode');
    expect(repack?.kind === 'repack' && repack.extrude).toBe(2);
    expect(packOp?.kind === 'pack' && packOp.extrude).toBe(2);
    // resize/transcode ops have no `extrude` field at all.
    expect(resize && 'extrude' in resize).toBe(false);
    expect(transcode && 'extrude' in transcode).toBe(false);
  });

  it('also stamps the aggressive atlas-merge repack op', () => {
    const mergeReport: AnalysisReport = {
      assets: [{ assetRef: 'a.png', diskBytes: 1, vramBytes: 0, occupancy: 0.1 }, { assetRef: 'b.png', diskBytes: 1, vramBytes: 0, occupancy: 0.1 }],
      findings: [
        { id: 'a.png:occupancy', rule: 'occupancy', severity: 'crit', assetRef: 'a.png', title: '', detail: '' },
        { id: 'b.png:occupancy', rule: 'occupancy', severity: 'crit', assetRef: 'b.png', title: '', detail: '' },
        { id: 'folder:atlas-merge', rule: 'atlas-merge', severity: 'warn', scope: 'folder', assetRef: 'a.png', relatedRefs: ['a.png', 'b.png'], title: '', detail: '' },
      ],
      totals: { diskBytes: 2, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
      thresholds: DEFAULT_THRESHOLDS,
    };
    const merge = planFix(mergeReport, { ...base, aggressive: true, extrude: 1 }).ops.find((o) => o.kind === 'repack' && o.atlasRefs.length > 1);
    expect(merge?.kind === 'repack' && merge.extrude).toBe(1);
  });

  it('extrude is floored to a non-negative integer (2.9 → 2; -3 → none)', () => {
    const frac = planFix(report, { ...base, extrude: 2.9 }, undefined, packGroups).ops.find((o) => o.kind === 'repack');
    expect(frac?.kind === 'repack' && frac.extrude).toBe(2);
    const neg = planFix(report, { ...base, extrude: -3 }, undefined, packGroups).ops;
    expect(neg.every((o) => !('extrude' in o))).toBe(true);
  });

  it('default OFF: extrude unset/0 ⇒ NO op carries extrude AND ops are deep-equal to today', () => {
    const todayOps = planFix(report, base, undefined, packGroups).ops;
    const zeroOps = planFix(report, { ...base, extrude: 0 }, undefined, packGroups).ops;
    expect(todayOps.every((o) => !('extrude' in o))).toBe(true);
    expect(zeroOps).toEqual(todayOps); // extrude:0 is byte-identical to the legacy path
  });
});

// ── Scale-tier guard (Task 8 / design §7) ────────────────────────────────────────────────────────
// When opts.scaleTiers is non-empty, every tier-eligible ref the worker's tier loop will own is folded
// into a `tiered` set that EXCLUDES it from the standalone pass-1 oversize-resize AND pass-2 transcode
// ops (the tier loop owns each tier's encode + oversize clamp). Refused refs (mesh / multi-page Spine /
// already-tiered — gated by tierEligible) keep their normal single-scale op. When aggressive AND tiering
// are both on, owner-aware dedup repoint is disabled (owners get renamed by tiering). Empty/absent
// scaleTiers ⇒ byte-identical to today. The plan NEVER emits a tier op (tiering is a worker multiplier).
describe('planFix — scale-tier guard (compose)', () => {
  const base = { targetMime: 'image/webp' as const, quality: 0.9, lossless: true, padding: 2, maxSize: 4096, maxEdge: 2048 };
  const tiers = [{ scale: 1, suffix: '_1080p' }, { scale: 0.5, suffix: '_540p' }]; // validated ladder shape

  /** A loose image carrying BOTH an oversize finding and a format finding (the two guarded passes). */
  const oversizeAndFormat = (ref: string): AnalysisReport => ({
    assets: [{ assetRef: ref, diskBytes: 1000, vramBytes: 4096 * 4096 * 4 }],
    findings: [
      { id: `${ref}:oversize`, rule: 'dimensions-oversize', severity: 'crit', assetRef: ref, title: '', detail: '', messageKey: 'oversize', params: { w: 4096, h: 4096, edge: 4096, budget: 2730, sev: 'crit', vram: 0 } },
      { id: `${ref}:format`, rule: 'format', severity: 'warn', assetRef: ref, title: '', detail: '' },
    ],
    totals: { diskBytes: 1000, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
    thresholds: DEFAULT_THRESHOLDS,
  });

  it('empty/absent scaleTiers ⇒ today’s ops unchanged (resize wins over transcode, no tier op)', () => {
    const report = oversizeAndFormat('hero.png');
    const noField = planFix(report, { ...base, aggressive: false });
    const empty = planFix(report, { ...base, aggressive: false, scaleTiers: [] });
    for (const plan of [noField, empty]) {
      expect(plan.ops.some((o) => o.kind === 'resize' && o.assetRef === 'hero.png')).toBe(true);
      expect(plan.ops.some((o) => o.kind === 'transcode')).toBe(false); // resize precedence, as today
    }
    // byte-identical op stream between absent and empty ⇒ no drift introduced by the field
    expect(JSON.stringify(empty.ops)).toBe(JSON.stringify(noField.ops));
  });

  it('a tier-eligible ref is EXCLUDED from the standalone resize AND transcode ops', () => {
    // tiering on, default-allow eligibility ⇒ hero.png is owned by the tier loop, so neither a resize nor
    // a transcode op should be emitted for it (the loop owns the oversize clamp + per-tier encode).
    const plan = planFix(oversizeAndFormat('hero.png'), { ...base, aggressive: false, scaleTiers: tiers });
    expect(plan.ops.some((o) => o.kind === 'resize' && o.assetRef === 'hero.png')).toBe(false);
    expect(plan.ops.some((o) => o.kind === 'transcode' && o.assetRef === 'hero.png')).toBe(false);
    expect(plan.ops.length).toBe(0); // no op at all — the worker tier loop does everything for this ref
  });

  it('a REFUSED ref (tierEligible=false) keeps its normal single-scale op', () => {
    // e.g. a meshed atlas / multi-page Spine / already-tiered input — the worker refuses to tier it, so
    // the plan must still emit its standalone resize (oversize precedence over transcode, as today).
    const plan = planFix(oversizeAndFormat('mesh.png'), { ...base, aggressive: false, scaleTiers: tiers, tierEligible: () => false });
    expect(plan.ops.some((o) => o.kind === 'resize' && o.assetRef === 'mesh.png')).toBe(true);
    expect(plan.ops.some((o) => o.kind === 'transcode')).toBe(false); // resize still wins
  });

  it('partial eligibility: eligible ref tiered (no op), refused ref keeps its transcode', () => {
    const report: AnalysisReport = {
      assets: [{ assetRef: 'a.png', diskBytes: 100, vramBytes: 0 }, { assetRef: 'b.png', diskBytes: 100, vramBytes: 0 }],
      findings: [
        { id: 'a.png:format', rule: 'format', severity: 'warn', assetRef: 'a.png', title: '', detail: '' },
        { id: 'b.png:format', rule: 'format', severity: 'warn', assetRef: 'b.png', title: '', detail: '' },
      ],
      totals: { diskBytes: 200, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
      thresholds: DEFAULT_THRESHOLDS,
    };
    const plan = planFix(report, { ...base, aggressive: false, scaleTiers: tiers, tierEligible: (r) => r === 'a.png' });
    expect(plan.ops.some((o) => o.kind === 'transcode' && o.assetRef === 'a.png')).toBe(false); // a tiered → no transcode
    expect(plan.ops.some((o) => o.kind === 'transcode' && o.assetRef === 'b.png')).toBe(true);  // b refused → still transcodes
  });

  it('a folder-scope format finding is never tiered (no single tier target) — still transcodes if applicable', () => {
    // folder findings have no single assetRef target; they must not be added to `tiered`. A per-asset
    // format finding on the SAME ref drives the (still-emitted) transcode when the ref is refused.
    const report: AnalysisReport = {
      assets: [{ assetRef: 'a.png', diskBytes: 100, vramBytes: 0 }],
      findings: [
        { id: 'folder:variants', rule: 'variants', severity: 'warn', scope: 'folder', assetRef: 'a.png', title: '', detail: '' },
        { id: 'a.png:format', rule: 'format', severity: 'warn', assetRef: 'a.png', title: '', detail: '' },
      ],
      totals: { diskBytes: 100, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
      thresholds: DEFAULT_THRESHOLDS,
    };
    // refuse a.png so we can observe the per-asset transcode survives (folder finding alone never tiers).
    const plan = planFix(report, { ...base, aggressive: false, scaleTiers: tiers, tierEligible: () => false });
    expect(plan.ops.some((o) => o.kind === 'transcode' && o.assetRef === 'a.png')).toBe(true);
  });

  it('dropped/repacked/packed refs are never tiered (their owning transform keeps the ref)', () => {
    // An under-filled atlas is repacked; tiering must NOT also claim it here (the repack output is what the
    // worker tier loop runs on, not a standalone tier of the source). The repack op must still be emitted.
    const report: AnalysisReport = {
      assets: [{ assetRef: 'sheet.png', diskBytes: 100, vramBytes: 256 * 256 * 4, occupancy: 0.1 }],
      findings: [{ id: 'sheet.png:occupancy', rule: 'occupancy', severity: 'crit', assetRef: 'sheet.png', title: '', detail: '' }],
      totals: { diskBytes: 100, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
      thresholds: DEFAULT_THRESHOLDS,
    };
    const plan = planFix(report, { ...base, aggressive: false, scaleTiers: tiers });
    expect(plan.ops.some((o) => o.kind === 'repack' && o.atlasRefs.includes('sheet.png'))).toBe(true);
  });

  it('aggressive + tiering DISABLES owner-aware manifest repoint (correction 8); drops still occur', () => {
    const groups: DedupGroup[] = [
      { contentHash: 'h', pool: 'pixi', skinGroup: 'general', owners: ['main/sheet.png'], consumers: [{ ref: 'extra/sheet.png', ownerRef: 'main/sheet.png', reason: 'eager-owner-cross-bundle' }] },
    ];
    const report: AnalysisReport = {
      assets: [{ assetRef: 'main/sheet.png', diskBytes: 100, vramBytes: 0 }, { assetRef: 'extra/sheet.png', diskBytes: 100, vramBytes: 0 }],
      findings: [],
      totals: { diskBytes: 200, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
      thresholds: DEFAULT_THRESHOLDS,
    };
    const isAtlasRef = (r: string) => r.endsWith('.png');

    // WITHOUT tiering: the atlas consumer's manifest is repointed (today's owner-aware behavior).
    const noTier = planFix(report, { ...base, aggressive: true, isAtlasRef }, groups);
    const dropNoTier = noTier.ops.find((o): o is Extract<FixOp, { kind: 'drop' }> => o.kind === 'drop' && o.assetRef === 'extra/sheet.png')!;
    expect(dropNoTier.repointManifest).toBe(true);

    // WITH tiering: the owner gets renamed, so the repoint is disabled — but the drop itself still fires.
    const withTier = planFix(report, { ...base, aggressive: true, isAtlasRef, scaleTiers: tiers }, groups);
    const dropTier = withTier.ops.find((o): o is Extract<FixOp, { kind: 'drop' }> => o.kind === 'drop' && o.assetRef === 'extra/sheet.png')!;
    expect(dropTier).toBeDefined();
    expect(dropTier.ownerRef).toBe('main/sheet.png');
    expect('repointManifest' in dropTier).toBe(false); // disabled — no key emitted
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

// ── Polygon mode: manifest/parser round-trip + back-compat + UV/spill ───────────────────────────
// Tests B from docs/polygon-packer-design.md § "Test plan": (f) back-compat, (g) meshed round-trip
// symmetry, (l) UV/spill correctness. All inputs are built inline (pure layer, no image files): a
// fully-opaque MaskItem at the ACC_CELL grid and a deterministic CCW triangle-fan RawMesh.

/** A fully-opaque MaskItem (every cell 1) at the ACC_CELL grid for a `w`×`h` px sprite. Drives the
 *  nester to a known packing without depending on the impure worker's mask extraction. */
function solidMask(id: string, w: number, h: number): MaskItem {
  const cols = Math.ceil(w / ACC_CELL);
  const rows = Math.ceil(h / ACC_CELL);
  return { id, w, h, cols, rows, bits: new Uint8Array(cols * rows).fill(1) };
}

/** A deterministic trimmed-local RawMesh: a CCW triangle fan over a small integer outline that fits a
 *  `w`×`h` frame. `verticesUV` is intentionally NOT carried here — repackAtlasesPolygon recomputes it
 *  from the final per-bin frame.xy, which tests (g)/(l) verify. */
function triMesh(w: number, h: number): RawMesh {
  // CCW under the Y-down shoelace convention (matches SpriteMesh's winding contract).
  const vertices = [
    { x: 0, y: h },
    { x: w, y: h },
    { x: w, y: 0 },
    { x: 0, y: 0 },
  ];
  const triangles = [
    [0, 1, 2],
    [0, 2, 3],
  ];
  return { vertices, triangles };
}

describe('polygon mode — back-compat (f)', () => {
  it('a non-mesh atlas emit is byte-identical to the current rectangle golden', () => {
    // Same atlas, two repack arms: the rectangle packer vs. the polygon repack with emitMesh:false.
    // With no mesh attached, polygon mode must reduce to the rectangle shape — so once both are packed
    // by the same family of placements the rectangle GOLDEN emit stays the source of truth and the
    // no-mesh polygon emit carries none of the additive keys.
    const atlas = loadAtlas();
    const rect = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 }).atlases[0]!;
    const golden = emitTexturePackerJson(rect);

    // The golden (rectangle) manifest must contain none of the additive polygon keys.
    expect(golden.includes('"vertices"')).toBe(false);
    expect(golden.includes('"verticesUV"')).toBe(false);
    expect(golden.includes('"triangles"')).toBe(false);

    // Re-emitting the same rectangle atlas is byte-identical (determinism unchanged by the additive code path).
    expect(emitTexturePackerJson(rect)).toBe(golden);

    // A polygon repack with emitMesh:false yields a mesh-free atlas whose emit also carries no polygon keys.
    const masks = atlas.sprites.map((s) => solidMask(`${atlas.name} ${s.name}`, s.frame.w, s.frame.h));
    const poly = repackAtlasesPolygon([atlas], masks, new Map(), { allowRotation: false, padding: 0, maxSize: 4096, emitMesh: false });
    for (const a of poly.atlases) {
      const json = emitTexturePackerJson(a);
      expect(json.includes('"vertices"')).toBe(false);
      expect(json.includes('"verticesUV"')).toBe(false);
      expect(json.includes('"triangles"')).toBe(false);
    }
    // No clip on any blit when no mesh is emitted ⇒ today's full-rect compose behavior.
    expect(poly.blits.every((b) => b.clip === undefined)).toBe(true);
  });

  it('a Blit with no clip behaves as today (clip key absent on the rectangle repack)', () => {
    const atlas = loadAtlas();
    const r = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 });
    expect(r.blits.length).toBe(atlas.sprites.length);
    for (const b of r.blits) {
      expect('clip' in b).toBe(false); // the rectangle path never sets clip — full-rect blit, unchanged
      expect(b.rotate90).toBe(false);
    }
  });
});

describe('polygon mode — round-trip symmetry for meshed atlases (g)', () => {
  it('emit → parse → toEqual for an atlas whose sprites carry mesh (exercises parse-back)', () => {
    // Build a meshed atlas through the real repack so its shape matches what the parser reconstructs
    // (Atlas.name = imageRef, source.kind = texturepacker-hash, sorted sprites). Every sprite gets a
    // mesh, so the additive vertices/verticesUV/triangles keys must survive emit → parse unchanged.
    const atlas = loadAtlas();
    const masks = atlas.sprites.map((s) => solidMask(`${atlas.name} ${s.name}`, s.frame.w, s.frame.h));
    const meshById = new Map<string, RawMesh>(atlas.sprites.map((s) => [`${atlas.name} ${s.name}`, triMesh(s.frame.w, s.frame.h)]));
    const repacked = repackAtlasesPolygon([atlas], masks, meshById, { allowRotation: false, padding: 0, maxSize: 4096, emitMesh: true }).atlases[0]!;

    // Every sprite carries a mesh (this is the meshed case we want to round-trip).
    expect(repacked.sprites.length).toBeGreaterThan(0);
    expect(repacked.sprites.every((s) => s.mesh !== undefined)).toBe(true);

    const json1 = emitTexturePackerJson(repacked);
    // Determinism: re-emitting the exact same meshed atlas is byte-identical.
    expect(emitTexturePackerJson(repacked)).toBe(json1);
    // The additive keys are actually present (otherwise the round-trip would trivially hold).
    expect(json1.includes('"vertices"')).toBe(true);
    expect(json1.includes('"verticesUV"')).toBe(true);
    expect(json1.includes('"triangles"')).toBe(true);

    const res = parseAtlasManifest(JSON.parse(json1), { imageRef: repacked.imageRef, imageSize: repacked.size });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.atlas).toEqual(repacked); // full symmetry: emit → parse → same meshed Atlas
  });
});

describe('polygon mode — UV/spill correctness (l)', () => {
  it('verticesUV[i] === vertices[i] + frame.xy (integers, not normalized) and Blit.clip equals verticesUV under spill', () => {
    // Three solid masks at maxSize=64 (16×16 ACC_CELL cells): C fills a whole bin, A+B share the next
    // — forcing a spill (≥2 bins) where B lands at a NONZERO offset, proving verticesUV is recomputed
    // from the FINAL per-bin frame.xy rather than carried from the source.
    const atlas: Atlas = {
      name: 'concave.png',
      imageRef: 'concave.png',
      size: { w: 128, h: 128 },
      source: { kind: 'texturepacker-hash' },
      sprites: [
        { name: 'wide', frame: { x: 0, y: 0, w: 64, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 32 } },
        { name: 'small', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } },
        { name: 'full', frame: { x: 0, y: 0, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 } },
      ],
    };
    const masks = atlas.sprites.map((s) => solidMask(`${atlas.name} ${s.name}`, s.frame.w, s.frame.h));
    const meshById = new Map<string, RawMesh>(atlas.sprites.map((s) => [`${atlas.name} ${s.name}`, triMesh(s.frame.w, s.frame.h)]));
    const r = repackAtlasesPolygon([atlas], masks, meshById, { allowRotation: false, padding: 0, maxSize: 64, emitMesh: true });

    // The set genuinely spilled across bins (so a `_1` sheet exists) — the load-bearing condition for (l).
    expect(r.atlases.length).toBeGreaterThanOrEqual(2);

    const blitByName = new Map<string, Blit>(r.blits.map((b) => [b.name, b]));
    let sawNonZeroOffset = false;
    for (const a of r.atlases) {
      for (const s of a.sprites) {
        const mesh = s.mesh!;
        expect(mesh).toBeDefined();
        // verticesUV is the trimmed-local outline translated by the FINAL per-bin frame.xy — integer,
        // NOT normalized (a normalized UV would be a fraction in [0,1], never equal to vertex+frame).
        for (let i = 0; i < mesh.vertices.length; i++) {
          const v = mesh.vertices[i]!;
          const uv = mesh.verticesUV[i]!;
          expect(uv).toEqual({ x: v.x + s.frame.x, y: v.y + s.frame.y });
          expect(Number.isInteger(uv.x)).toBe(true);
          expect(Number.isInteger(uv.y)).toBe(true);
        }
        if (s.frame.x !== 0 || s.frame.y !== 0) sawNonZeroOffset = true;
        // The blit's clip path is exactly this sprite's verticesUV (the compose-safety contract).
        const blit = blitByName.get(s.name)!;
        expect(blit.clip).toEqual(mesh.verticesUV);
      }
    }
    // At least one meshed sprite was placed at a nonzero offset ⇒ the +frame.xy recompute is exercised,
    // not a trivial pass where every sprite sits at the origin.
    expect(sawNonZeroOffset).toBe(true);

    // Determinism: the same polygon repack emits byte-identical manifests on re-run.
    const r2 = repackAtlasesPolygon([atlas], masks, meshById, { allowRotation: false, padding: 0, maxSize: 64, emitMesh: true });
    for (let i = 0; i < r.atlases.length; i++) {
      expect(emitTexturePackerJson(r2.atlases[i]!)).toBe(emitTexturePackerJson(r.atlases[i]!));
    }
  });
});

// ── Frame-redundancy aliasing (round19, BLOCKER B1 + drop-in proofs) ─────────────────────────────────
// The frame-redundant fixture is 100% packed (no occupancy/wasted finding), so the FINDING must emit its
// OWN repack op for aliasing to ever fire — and repackAtlases must pack ONE representative per byte-identical
// cluster while every alias name still resolves at the shared rect, with EXACT before→after VRAM.
describe('frame-redundancy aliasing (round19)', () => {
  it('repackAtlases with alias maps: 5 representatives packed, all 8 names resolve, 4 idle share ONE rect', () => {
    const atlas = loadFrameRedundantAtlas();
    const r = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 }, frAliasMaps(atlas));
    // aliasedFrames === the detector's `dupes`: 4 idle ⇒ 3 beyond the kept representative.
    expect(r.aliasedFrames).toBe(3);
    // ONE Blit per representative — pixels written once (5 reps = 1 idle + 4 walk).
    expect(r.blits.length).toBe(5);
    // EVERY original frame name still resolves in the emitted manifest (drop-in).
    const out = r.atlases.flatMap((a) => a.sprites);
    expect(out.map((s) => s.name).sort()).toEqual(atlas.sprites.map((s) => s.name).sort());
    expect(out.length).toBe(8);
    // The four idle_* sprites share ONE {x,y,w,h} (aliased onto the representative's final rect).
    const idleRects = new Set(out.filter((s) => s.name.startsWith('idle_')).map((s) => `${s.frame.x},${s.frame.y},${s.frame.w},${s.frame.h}`));
    expect(idleRects.size).toBe(1);
    // The shared idle rect equals the representative's (idle_0) rect — only ONE blit lands there.
    const idleRect = [...idleRects][0]!;
    const blitsAtIdle = r.blits.filter((b) => `${b.to.x},${b.to.y},${b.to.w},${b.to.h}` === idleRect);
    expect(blitsAtIdle.length).toBe(1);
  });

  it('honest dual occupancy + EXACT VRAM: source 100% before, smaller sheet after, no estimate', () => {
    const atlas = loadFrameRedundantAtlas();
    const aliased = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 }, frAliasMaps(atlas));
    const plain = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 }); // no aliasing
    // occupancyBefore counts ALL source sprites (duplicates and all) via the DUAL accumulator — the 256×32
    // strip was genuinely 100% packed (truthful "before", not deflated by dropping the aliases).
    expect(aliased.occupancyBefore).toBeCloseTo(1, 5);
    expect(aliased.vramBytesBefore).toBe(256 * 32 * 4); // exact w·h·4 of the source sheet
    // occupancyAfter counts ONLY the 5 packed representatives over the new sheet area — strictly LESS filled
    // than packing all 8 into the same bin (honest dual accumulator, not one shared coveredArea).
    expect(aliased.occupancyAfter).toBeLessThan(plain.occupancyAfter);
    // Aliasing NEVER costs VRAM (≤), the value is EXACT (straight from repackAtlases, no estimate) +
    // deterministic. For this tiny fixture both fit the same POT bin, so the win is fewer Blits (pixels written
    // ONCE) + a smaller covered area, not a POT-tier drop here.
    expect(aliased.vramBytesAfter).toBeLessThanOrEqual(plain.vramBytesAfter);
    expect(aliased.blits.length).toBeLessThan(plain.blits.length); // 5 < 8 — pixels de-duplicated
    expect(repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 }, frAliasMaps(atlas)).vramBytesAfter).toBe(aliased.vramBytesAfter);
  });

  it('each alias keeps its OWN trim / sourceSize / spriteSourceSize / pivot (only the rect is shared)', () => {
    const atlas = loadFrameRedundantAtlas();
    const r = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 }, frAliasMaps(atlas));
    const out = new Map(r.atlases.flatMap((a) => a.sprites).map((s) => [s.name, s]));
    for (const src of atlas.sprites) {
      const o = out.get(src.name)!;
      expect(o.rotated).toBe(src.rotated);
      expect(o.trimmed).toBe(src.trimmed);
      expect(o.sourceSize).toEqual(src.sourceSize);
      expect(o.spriteSourceSize).toEqual(src.spriteSourceSize);
      expect(o.pivot).toEqual(src.pivot);
    }
  });

  it('emitted manifest round-trips through the parser with every aliased name present', () => {
    const atlas = loadFrameRedundantAtlas();
    const repacked = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 }, frAliasMaps(atlas)).atlases[0]!;
    const json = emitTexturePackerJson(repacked);
    const res = parseAtlasManifest(JSON.parse(json), { imageRef: repacked.imageRef, imageSize: repacked.size });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.atlas.sprites.map((s) => s.name).sort()).toEqual(atlas.sprites.map((s) => s.name).sort());
  });

  it('absent alias maps ⇒ output byte-identical to today (additivity regression)', () => {
    const atlas = loadFrameRedundantAtlas();
    const a = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 });
    const b = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 }, new Map());
    expect(emitTexturePackerJson(a.atlases[0]!)).toBe(emitTexturePackerJson(b.atlases[0]!));
    expect(a.aliasedFrames).toBeUndefined(); // no aliasMaps ⇒ no aliasedFrames field
    expect(b.aliasedFrames).toBeUndefined();
    expect(a.blits.length).toBe(8); // all 8 frames packed + blitted (today's behavior)
  });

  it('BLOCKER B1: a fully-packed frame-redundant atlas STILL gets a repack op from the finding', async () => {
    const atlas = loadFrameRedundantAtlas();
    const report = await analyze(
      [{ kind: 'atlas', atlas, image: { name: 'anim.png', imageRef: 'anim.png', size: { w: 256, h: 32 }, mime: 'image/png', byteSize: 4000 } }],
      undefined,
      { frameHashes: [{ atlasRef: 'anim.png', frameHashes: frFrameHashes(atlas) }] },
    );
    // The atlas is 100% packed ⇒ NO occupancy / wasted-regions finding would schedule a repack.
    expect(report.findings.some((f) => f.rule === 'occupancy' || f.rule === 'wasted-regions')).toBe(false);
    // ...but the frame-redundancy finding fired, and (frameRedundancy default ON) it emits its OWN repack op.
    expect(report.findings.some((f) => f.rule === 'frame-redundancy')).toBe(true);
    const base = { targetMime: 'image/webp' as const, quality: 0.9, lossless: true, padding: 2, maxSize: 4096, maxEdge: 2048, aggressive: false };
    const onOps = planFix(report, base).ops.filter((o) => o.kind === 'repack');
    expect(onOps).toHaveLength(1);
    expect(onOps[0]!.kind === 'repack' && onOps[0]!.atlasRefs).toEqual(['anim.png']);
  });

  it('frameRedundancy:false ⇒ NO new repack op (byte-identical to today; finding stays diagnosis-only)', async () => {
    const atlas = loadFrameRedundantAtlas();
    const report = await analyze(
      [{ kind: 'atlas', atlas, image: { name: 'anim.png', imageRef: 'anim.png', size: { w: 256, h: 32 }, mime: 'image/png', byteSize: 4000 } }],
      undefined,
      { frameHashes: [{ atlasRef: 'anim.png', frameHashes: frFrameHashes(atlas) }] },
    );
    const base = { targetMime: 'image/webp' as const, quality: 0.9, lossless: true, padding: 2, maxSize: 4096, maxEdge: 2048, aggressive: false };
    expect(planFix(report, { ...base, frameRedundancy: false }).ops.some((o) => o.kind === 'repack')).toBe(false);
  });

  it('honesty pin: aliasedFrames realized === the finding`s measured dupes on the same inputs', async () => {
    const atlas = loadFrameRedundantAtlas();
    const report = await analyze(
      [{ kind: 'atlas', atlas, image: { name: 'anim.png', imageRef: 'anim.png', size: { w: 256, h: 32 }, mime: 'image/png', byteSize: 4000 } }],
      undefined,
      { frameHashes: [{ atlasRef: 'anim.png', frameHashes: frFrameHashes(atlas) }] },
    );
    const fr = report.findings.find((f) => f.rule === 'frame-redundancy')!;
    const realized = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 }, frAliasMaps(atlas)).aliasedFrames;
    expect(realized).toBe(fr.params!.dupes); // the fix realizes EXACTLY what the diagnosis measured
  });

  it('honesty (finding [0]): a pre-aliased cluster (5 names / 3 distinct rects) reports dupes=2, NOT 4', () => {
    // Five byte-identical names but only THREE distinct packed rects (two PAIRS share a rect: x=0 ×2, x=32 ×2,
    // x=64 ×1) — an explicitly-supported pre-aliased Spine/TP sheet. The detector's distinct-rect guard collapses
    // each shared rect to ONE recoverable unit ⇒ dupes = distinctRects(3) − 1 = 2. The OLD per-non-rep tally
    // would have over-reported 4 (cluster-size 5 − 1). repackAtlases.aliasedFrames must MATCH the alias map (and
    // thus the finding's dupes) by construction. Mirrors the alias.test.ts DISTINCT-RECT GUARD case.
    const sp = (name: string, x: number): Atlas['sprites'][number] => ({ name, frame: { x, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } });
    const sprites = [sp('a', 0), sp('b', 0), sp('c', 32), sp('d', 32), sp('e', 64)];
    const atlas: Atlas = { name: 'pre.png', imageRef: 'pre.png', size: { w: 96, h: 32 }, sprites, source: { kind: 'pixi' } };
    const hashes = ['h', 'h', 'h', 'h', 'h']; // all five hash-identical
    const am = buildAtlasAliasMap(atlas.sprites, hashes, 3);
    expect(am.aliasedFrames).toBe(2); // distinctRects(3) − 1, the honest measured value
    const r = repackAtlases([atlas], { allowRotation: false, padding: 0, maxSize: 4096 }, new Map([[atlas.name, am]]));
    expect(r.aliasedFrames).toBe(am.aliasedFrames); // === 2 by construction (no per-sprite re-tally)
    expect(r.aliasedFrames).toBe(2);
    // Drop-in still holds: every original name resolves, all five aliased onto the ONE representative rect (the
    // whole hash-cluster shares one packed region; only the SURFACED count, not the geometry, was the bug).
    const out = r.atlases.flatMap((a) => a.sprites);
    expect(out.map((s) => s.name).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(new Set(out.map((s) => `${s.frame.x},${s.frame.y},${s.frame.w},${s.frame.h}`)).size).toBe(1);
    expect(r.blits.length).toBe(1); // pixels written ONCE
  });

  it('EXACT VRAM win across a POT tier: dropping duplicates shrinks the sheet to the next-smaller bin', () => {
    // A synthetic strip of eight 256×256 frames (no padding). Three distinct (a,b,c) + a 5-way duplicate
    // cluster (the five `dup_*` share one region). Packing all 8 needs a 1024×512 bin (8·256² = 524288 px);
    // aliasing to FOUR representatives (1 rep + a,b,c) fits a 512×512 bin (4·256² = 262144 px) — a real
    // POT-tier VRAM drop (524288·4 → 262144·4), reported EXACTLY (Σ w·h·4 of the bins, no estimate).
    const frame = (name: string, i: number): Atlas['sprites'][number] => ({ name, frame: { x: i * 256, y: 0, w: 256, h: 256 }, rotated: false, trimmed: false, sourceSize: { w: 256, h: 256 } });
    const sprites = ['dup_0', 'dup_1', 'dup_2', 'dup_3', 'dup_4', 'a', 'b', 'c'].map((n, i) => frame(n, i));
    const atlas: Atlas = { name: 'big.png', imageRef: 'big.png', size: { w: 2048, h: 256 }, sprites, source: { kind: 'pixi' } };
    const hashes = atlas.sprites.map((s) => (s.name.startsWith('dup_') ? 'dup' : s.name));
    const am = new Map([[atlas.name, buildAtlasAliasMap(atlas.sprites, hashes, 3)]]);
    const aliased = repackAtlases([atlas], { allowRotation: false, padding: 0, maxSize: 4096 }, am);
    const plain = repackAtlases([atlas], { allowRotation: false, padding: 0, maxSize: 4096 });
    expect(aliased.aliasedFrames).toBe(4); // distinctRects(5) − 1 kept
    expect(aliased.atlases.flatMap((a) => a.sprites)).toHaveLength(8); // all 8 names still resolve
    expect(aliased.vramBytesAfter).toBeLessThan(plain.vramBytesAfter); // a genuine POT-tier VRAM drop
    expect(aliased.vramBytesAfter).toBe(aliased.atlases.reduce((n, a) => n + a.size.w * a.size.h * 4, 0)); // EXACT Σ w·h·4, no estimate
  });
});
