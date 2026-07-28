import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AnalysisReport, Atlas, AtlasFrameTrims, Blit, DedupGroup, FixOp, PackGroup, TrimRect } from '@asset-doctor/core';
import { parseAtlas, parseAtlasManifest, parseSpineAtlasText, parseSpinePage } from '@asset-doctor/parsers';
import { analyze, DEFAULT_THRESHOLDS } from '@asset-doctor/analysis';
import { ACC_CELL, alphaBBox, buildAtlasAliasMap, buildMergeAliasMap, emitSpineAtlasText, emitTexturePackerJson, pack, planFix, repackAtlases, repackAtlasesPolygon, scaleAtlas, type AtlasAliasMap, type MaskItem, type Placement, type RawMesh } from '../src/index';

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

// ── Trim-on-repack (round20, BLOCKERS B1/B2 + honesty/drop-in/additivity proofs) ─────────────────────────
// repackAtlases({trim}) must pack the TIGHTER opaque bbox for every UNtrimmed shrinkable sprite, blit the
// inset sub-region, and emit trimmed:true + sourceSize(full) + spriteSourceSize/offset. Already-trimmed
// sprites are verbatim; aliases of a trimmed rep INHERIT the rep's trim (B2). trim absent ⇒ byte-identical.
describe('trim-on-repack (round20)', () => {
  // A hand-built atlas: two UNtrimmed padded sprites (opaque core inset inside a 64² frame) + one already-
  // trimmed sprite the repack must copy verbatim. Frame-relative bboxes mirror the untrimmed-padding fixture.
  const padded = (name: string, fx: number): Atlas['sprites'][number] => ({
    name, frame: { x: fx, y: 0, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 },
  });
  const untrimmedAtlas = (): Atlas => ({
    name: 'sheet.png', imageRef: 'sheet.png', size: { w: 256, h: 256 },
    sprites: [
      padded('padded_0', 0),
      padded('padded_1', 64),
      { name: 'trimmed_0', frame: { x: 128, y: 0, w: 40, h: 48 }, rotated: false, trimmed: true, sourceSize: { w: 48, h: 56 }, spriteSourceSize: { x: 4, y: 4, w: 40, h: 48 } },
    ],
    source: { kind: 'texturepacker-hash' },
  });
  // FRAME-RELATIVE bboxes (the value alphaBBox returns), index-aligned to sprites. trimmed_0 ⇒ null (verbatim).
  const trimArr = (): import('@asset-doctor/core').TrimRect[] | (import('@asset-doctor/core').TrimRect | null)[] => [
    { x: 16, y: 16, w: 32, h: 32 }, // padded_0
    { x: 12, y: 8, w: 40, h: 44 }, // padded_1
    null, // trimmed_0 (already trimmed)
  ];
  const byName = (r: ReturnType<typeof repackAtlases>): Map<string, Atlas['sprites'][number]> =>
    new Map(r.atlases.flatMap((a) => a.sprites).map((s) => [s.name, s]));

  it('TP: packs the TIGHTER bbox + emits trimmed:true / sourceSize(full) / spriteSourceSize(=bbox inset)', () => {
    const atlas = untrimmedAtlas();
    const r = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096, trim: [trimArr()] });
    expect(r.trimmedSprites).toBe(2);
    expect(r.trimmedAreaReclaimed).toBe(64 * 64 - 32 * 32 + (64 * 64 - 40 * 44)); // 3072 + 2336 = 5408
    const out = byName(r);
    // padded_0 — packed at bbox extent, full sourceSize, TP top-left inset spriteSourceSize.
    const p0 = out.get('padded_0')!;
    expect({ w: p0.frame.w, h: p0.frame.h }).toEqual({ w: 32, h: 32 });
    expect(p0.trimmed).toBe(true);
    expect(p0.sourceSize).toEqual({ w: 64, h: 64 });
    expect(p0.spriteSourceSize).toEqual({ x: 16, y: 16, w: 32, h: 32 });
    const p1 = out.get('padded_1')!;
    expect({ w: p1.frame.w, h: p1.frame.h }).toEqual({ w: 40, h: 44 });
    expect(p1.spriteSourceSize).toEqual({ x: 12, y: 8, w: 40, h: 44 });
    // The blit reads the INSET source sub-region (frame.xy + bbox.xy), writes the tight placement.
    const b0 = r.blits.find((b) => b.name === 'padded_0')!;
    expect(b0.from.rect).toEqual({ x: 0 + 16, y: 0 + 16, w: 32, h: 32 });
    expect({ w: b0.to.w, h: b0.to.h }).toEqual({ w: 32, h: 32 });
    // Already-trimmed sprite copied VERBATIM (byte-identical metadata, full frame blit).
    const t0 = out.get('trimmed_0')!;
    expect(t0.trimmed).toBe(true);
    expect(t0.sourceSize).toEqual({ w: 48, h: 56 });
    expect(t0.spriteSourceSize).toEqual({ x: 4, y: 4, w: 40, h: 48 });
    expect({ w: t0.frame.w, h: t0.frame.h }).toEqual({ w: 40, h: 48 });
    expect(r.blits.find((b) => b.name === 'trimmed_0')!.from.rect).toEqual({ x: 128, y: 0, w: 40, h: 48 });
  });

  it('Spine offset: trimAsSpineOffset writes spriteSourceSize.y as the BOTTOM-LEFT Y-flip', () => {
    const atlas = untrimmedAtlas();
    const r = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096, trim: [trimArr()], trimAsSpineOffset: true });
    const p0 = byName(r).get('padded_0')!;
    // padded_0: source 64×64, bbox {16,16,32,32} → offsetY = 64 - (16+32) = 16; offsetX = 16 (no flip on X).
    expect(p0.spriteSourceSize).toEqual({ x: 16, y: 16, w: 32, h: 32 });
    const p1 = byName(r).get('padded_1')!;
    // padded_1: bbox {12,8,40,44} → offsetY = 64 - (8+44) = 12; offsetX = 12.
    expect(p1.spriteSourceSize).toEqual({ x: 12, y: 12, w: 40, h: 44 });
  });

  it('manifest round-trips through the parser (TP) after trimming', () => {
    const atlas = untrimmedAtlas();
    const repacked = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096, trim: [trimArr()] }).atlases[0]!;
    const json = emitTexturePackerJson(repacked);
    const res = parseAtlasManifest(JSON.parse(json), { imageRef: repacked.imageRef, imageSize: repacked.size });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.atlas).toEqual(repacked);
    // Every original name still resolves (drop-in).
    expect(repacked.sprites.map((s) => s.name).sort()).toEqual(atlas.sprites.map((s) => s.name).sort());
  });

  it('B2: an UNtrimmed alias of a trimmed rep INHERITS the rep trim (never left untrimmed at a tight rect)', () => {
    // Two byte-identical UNtrimmed padded sprites → one cluster. The rep is trimmed; the alias MUST inherit
    // trimmed:true + sourceSize(full) + spriteSourceSize(=rep bbox) — a broken manifest otherwise.
    const atlas: Atlas = {
      name: 'sheet.png', imageRef: 'sheet.png', size: { w: 256, h: 256 },
      sprites: [padded('dup_0', 0), padded('dup_1', 64)],
      source: { kind: 'texturepacker-hash' },
    };
    const aliasMaps = new Map([[atlas.name, buildAtlasAliasMap(atlas.sprites, ['dup', 'dup'], 1)]]);
    const bbox = { x: 16, y: 16, w: 32, h: 32 };
    const r = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096, trim: [[bbox, bbox]] }, aliasMaps);
    // ONE representative packed + trimmed; the alias is NOT re-counted.
    expect(r.trimmedSprites).toBe(1);
    expect(r.aliasedFrames).toBe(1);
    expect(r.blits.length).toBe(1); // pixels written ONCE (the inset rep blit)
    const out = byName(r);
    for (const name of ['dup_0', 'dup_1']) {
      const s = out.get(name)!;
      expect(s.trimmed, `${name} must be trimmed`).toBe(true);
      expect(s.sourceSize, `${name} sourceSize`).toEqual({ w: 64, h: 64 });
      expect(s.spriteSourceSize, `${name} spriteSourceSize inherited from rep`).toEqual({ x: 16, y: 16, w: 32, h: 32 });
      expect({ w: s.frame.w, h: s.frame.h }, `${name} tight frame`).toEqual({ w: 32, h: 32 });
    }
    // Both names land at the SAME tight rect (rect shared, pixels once).
    expect(`${out.get('dup_0')!.frame.x},${out.get('dup_0')!.frame.y}`).toBe(`${out.get('dup_1')!.frame.x},${out.get('dup_1')!.frame.y}`);
  });

  it('verbatim: null bbox / full-frame bbox / already-trimmed sprite are NOT trimmed', () => {
    const atlas = untrimmedAtlas();
    // padded_0 null (un-measured), padded_1 full-frame bbox (no padding), trimmed_0 already trimmed.
    const r = repackAtlases([atlas], {
      allowRotation: false, padding: 2, maxSize: 4096,
      trim: [[null, { x: 0, y: 0, w: 64, h: 64 }, null]],
    });
    expect(r.trimmedSprites).toBeUndefined(); // nothing shrinkable ⇒ field omitted
    const out = byName(r);
    expect(out.get('padded_0')!.trimmed).toBe(false);
    expect(out.get('padded_0')!.spriteSourceSize).toBeUndefined();
    expect({ w: out.get('padded_1')!.frame.w, h: out.get('padded_1')!.frame.h }).toEqual({ w: 64, h: 64 });
    expect(out.get('padded_1')!.trimmed).toBe(false);
  });

  it('verbatim: a ROTATED untrimmed sprite is NEVER trimmed (finding [0] — rotated bbox ≠ source coords)', () => {
    // A rotated:true untrimmed sprite stores ROTATED pixels on-page; alphaBBox would be in rotated coords but
    // spriteSourceSizeFrom/spineOffsetFrom treat it as unrotated source coords ⇒ a BROKEN manifest. resolveTrim
    // must bail on s.rotated and pack/emit it VERBATIM (v1 keeps source orientation; rotated packs verbatim).
    const atlas: Atlas = {
      name: 'sheet.png', imageRef: 'sheet.png', size: { w: 256, h: 256 },
      sprites: [{ name: 'rot_0', frame: { x: 0, y: 0, w: 48, h: 64 }, rotated: true, trimmed: false, sourceSize: { w: 48, h: 64 } }],
      source: { kind: 'texturepacker-hash' },
    };
    // A plausible (but coord-mismatched) measured bbox — must be IGNORED because the sprite is rotated.
    const r = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096, trim: [[{ x: 8, y: 8, w: 32, h: 48 }]] });
    expect(r.trimmedSprites).toBeUndefined(); // rotated ⇒ not trimmed ⇒ field omitted
    const s = byName(r).get('rot_0')!;
    expect(s.rotated).toBe(true);
    expect(s.trimmed).toBe(false);
    expect(s.spriteSourceSize).toBeUndefined();
    expect({ w: s.frame.w, h: s.frame.h }).toEqual({ w: 48, h: 64 }); // full frame extent, untouched
    expect(s.sourceSize).toEqual({ w: 48, h: 64 });
    // The blit reads the FULL frame (no inset), preserving the rotated pixels verbatim.
    expect(r.blits.find((b) => b.name === 'rot_0')!.from.rect).toEqual({ x: 0, y: 0, w: 48, h: 64 });
    // Byte-identical to omitting trim entirely (additivity for rotated sprites).
    const plain = emitTexturePackerJson(repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 }).atlases[0]!);
    const withTrim = emitTexturePackerJson(r.atlases[0]!);
    expect(withTrim).toBe(plain);
  });

  it('ADDITIVITY: trim absent ⇒ byte-identical to today (regression pin)', () => {
    const atlas = untrimmedAtlas();
    const plain = emitTexturePackerJson(repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 }).atlases[0]!);
    // An all-null trim array is the same as omitting it (nothing shrinkable).
    const nullTrim = emitTexturePackerJson(repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096, trim: [[null, null, null]] }).atlases[0]!);
    expect(nullTrim).toBe(plain);
  });

  it('golden: the untrimmed-padding fixture trim arithmetic + per-sprite packedSize/spriteSourceSize', () => {
    interface RepackGolden { trimmedSprites: number; trimmedAreaReclaimed: number; perSprite: { name: string; packedSize: { w: number; h: number }; sourceSize: { w: number; h: number }; spriteSourceSize: { x: number; y: number; w: number; h: number } }[] }
    const padDir = fileURLToPath(new URL('../../../fixtures/sample-projects/untrimmed-padding/', import.meta.url));
    const expected = (JSON.parse(readFileSync(`${padDir}expected.json`, 'utf8')) as { repack: RepackGolden }).repack;
    const manifest = JSON.parse(readFileSync(`${padDir}sheet.json`, 'utf8')) as unknown;
    const res = parseAtlas(manifest, { ref: 'sheet.png', bytes: new Uint8Array(readFileSync(`${padDir}sheet.png`)) });
    if (!res.ok || res.asset.kind !== 'atlas') throw new Error('untrimmed-padding fixture parse failed');
    const atlas = res.asset.atlas;
    // Build the trim array from the documented golden bboxes (the E2E test in apps/web decodes the PNG itself).
    const golden = JSON.parse(readFileSync(`${padDir}expected.json`, 'utf8')) as { regions: { name: string; bbox: { x: number; y: number; w: number; h: number } | null; trimmed: boolean }[] };
    const bboxByName = new Map(golden.regions.map((g) => [g.name, g.bbox]));
    const trim = atlas.sprites.map((s) => (s.trimmed ? null : bboxByName.get(s.name) ?? null));
    const r = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096, trim: [trim] });
    expect(r.trimmedSprites).toBe(expected.trimmedSprites);
    expect(r.trimmedAreaReclaimed).toBe(expected.trimmedAreaReclaimed);
    const out = byName(r);
    for (const ps of expected.perSprite) {
      const s = out.get(ps.name)!;
      expect({ w: s.frame.w, h: s.frame.h }, `${ps.name} packedSize`).toEqual(ps.packedSize);
      expect(s.sourceSize, `${ps.name} sourceSize`).toEqual(ps.sourceSize);
      expect(s.spriteSourceSize, `${ps.name} spriteSourceSize`).toEqual(ps.spriteSourceSize);
    }
    // Drop-in: every original name resolves.
    expect(out.size).toBe(atlas.sprites.length);
  });
});

// ── Cross-atlas frame dedup during MERGE (round22 #1) ─────────────────────────────────────────────────────
// repackAtlases(group, opts, undefined, mergeAliasMap) packs ONE region per cross-sheet cluster and emits a
// Sprite for EACH duplicate name (across all merged sheets) at that region; one Blit per representative; EXACT
// vramReclaimedBytes/potTierDropped from the real no-alias baseline pack of the same group.
describe('cross-atlas merge dedup (round22 #1)', () => {
  const sprite = (name: string, x: number, w = 32, h = 32): Atlas['sprites'][number] => ({
    name, frame: { x, y: 0, w, h }, rotated: false, trimmed: false, sourceSize: { w, h },
  });
  const atl = (name: string, sprites: Atlas['sprites'], w = 512, h = 512): Atlas => ({
    name, imageRef: name, size: { w, h }, sprites, source: { kind: 'texturepacker-hash' },
  });
  const byName = (r: ReturnType<typeof repackAtlases>): Map<string, Atlas['sprites'][number]> =>
    new Map(r.atlases.flatMap((a) => a.sprites.map((s) => [s.name, s] as const)));

  it('T2: two merged sheets with byte-identical frames (distinct names) ⇒ ONE region, every name resolves, one Blit per rep', () => {
    // Sheet A: coinA + uniqA ; Sheet B: coinB (byte-identical to coinA) + uniqB. DISTINCT names on each sheet
    // (the realistic cross-sheet dup — same name on two sheets is blocked by the worker's collision guard).
    const a = atl('a.png', [sprite('coinA', 0), sprite('uniqA', 32)]);
    const b = atl('b.png', [sprite('coinB', 0), sprite('uniqB', 32)]);
    const group = [a, b];
    const hashes = new Map<string, (string | null)[]>([
      ['a.png', ['coin', 'A']],
      ['b.png', ['coin', 'B']],
    ]);
    const mam = buildMergeAliasMap(group, hashes, 2);
    expect(mam.aliasedFrames).toBe(1);
    expect(mam.crossSheetFrames).toBe(1);

    const opts = { allowRotation: false, padding: 2, maxSize: 4096 };
    const totalSprites = a.sprites.length + b.sprites.length; // 4
    const r = repackAtlases(group, opts, undefined, mam);
    // One Blit per representative: 4 sprites − 1 aliased = 3 distinct packed regions/blits.
    expect(r.blits.length).toBe(totalSprites - mam.aliasedFrames);
    // EVERY original name from EVERY merged sheet resolves in the emitted manifest (no dangling ref).
    const out = byName(r);
    for (const name of ['coinA', 'coinB', 'uniqA', 'uniqB']) expect(out.has(name), `${name} resolves`).toBe(true);
    expect(out.size).toBe(totalSprites);
    // coinB (the alias) lands at coinA's (the rep's) EXACT rect — the shared region, pixels written once.
    expect(out.get('coinB')!.frame).toEqual(out.get('coinA')!.frame);
    // Pixels written ONCE: a Blit for the rep (coinA), none for the alias (coinB).
    expect(r.blits.some((bl) => bl.name === 'coinA')).toBe(true);
    expect(r.blits.some((bl) => bl.name === 'coinB')).toBe(false);
    expect(r.aliasedFrames).toBe(1);

    // CONTRAST: mergeAliasMap=undefined packs ALL 4 sprites (the literal defect — the coin packed twice).
    const noAlias = repackAtlases(group, opts);
    expect(noAlias.blits.length).toBe(totalSprites);
  });

  it('T3: POT-tier honesty — a tier-drop group reports EXACT vramReclaimedBytes + potTierDropped:true', () => {
    // Five 256×256 dup copies across two sheets (one cluster). With aliasing only ONE 256² region packs ⇒ a
    // 256×256 bin (256·256·4 = 262144). Without aliasing five 256² tiles need a much bigger POT bin ⇒ a real
    // measured tier drop. gate=2.
    const a2 = atl('a.png', [sprite('d0', 0, 256, 256), sprite('d1', 256, 256, 256)], 1024, 1024);
    const b2 = atl('b.png', [sprite('d2', 0, 256, 256), sprite('d3', 256, 256, 256), sprite('d4', 512, 256, 256)], 1024, 1024);
    const group = [a2, b2];
    const hashes = new Map<string, (string | null)[]>([
      ['a.png', ['dup', 'dup']],
      ['b.png', ['dup', 'dup', 'dup']],
    ]);
    const mam = buildMergeAliasMap(group, hashes, 2);
    expect(mam.aliasedFrames).toBe(4); // 5 distinct rects − 1 rep
    const opts = { allowRotation: false, padding: 0, maxSize: 4096 };
    const r = repackAtlases(group, opts, undefined, mam);
    // Aliased ⇒ one 256² region ⇒ 256×256 POT bin.
    expect(r.vramBytesAfter).toBe(256 * 256 * 4);
    // The no-alias baseline packs five 256² tiles ⇒ a strictly larger POT bin ⇒ a real measured tier drop.
    const baseline = repackAtlases(group, opts);
    expect(baseline.vramBytesAfter).toBeGreaterThan(r.vramBytesAfter);
    expect(r.potTierDropped).toBe(true);
    expect(r.vramReclaimedBytes).toBe(baseline.vramBytesAfter - r.vramBytesAfter);
    expect(r.vramReclaimedBytes).toBeGreaterThan(0);
  });

  it('T3: same-tier group reports potTierDropped:false + vramReclaimedBytes:0 (disk-only, still aliased)', () => {
    // Two tiny dup frames across two sheets: aliasing them away leaves the rest of the pack on the SAME POT
    // tier ⇒ no VRAM win, but the dedup IS real (drop-in, disk-only). aliasedFrames>0, potTierDropped:false.
    const a = atl('a.png', [sprite('dotA', 0, 4, 4), sprite('uniqA', 8, 256, 256)], 512, 512);
    const b = atl('b.png', [sprite('dotB', 0, 4, 4), sprite('uniqB', 8, 256, 256)], 512, 512);
    const group = [a, b];
    const hashes = new Map<string, (string | null)[]>([
      ['a.png', ['dot', 'A']],
      ['b.png', ['dot', 'B']],
    ]);
    const mam = buildMergeAliasMap(group, hashes, 2);
    expect(mam.aliasedFrames).toBe(1);
    const opts = { allowRotation: false, padding: 0, maxSize: 4096 };
    const r = repackAtlases(group, opts, undefined, mam);
    const baseline = repackAtlases(group, opts);
    // The two 256² uniques dominate the POT tier; removing one 4×4 dup does not shrink the bin.
    expect(r.vramBytesAfter).toBe(baseline.vramBytesAfter);
    expect(r.potTierDropped).toBe(false);
    expect(r.vramReclaimedBytes).toBe(0);
    expect(r.aliasedFrames).toBe(1); // still deduped (drop-in), just disk-only
  });

  it('T2-roundtrip: the merged manifest round-trips (TexturePacker JSON) with every name resolving', () => {
    const a = atl('a.png', [sprite('coinA', 0), sprite('uniqA', 32)]);
    const b = atl('b.png', [sprite('coinB', 0), sprite('uniqB', 32)]);
    const group = [a, b];
    const hashes = new Map<string, (string | null)[]>([['a.png', ['coin', 'A']], ['b.png', ['coin', 'B']]]);
    const mam = buildMergeAliasMap(group, hashes, 2);
    const r = repackAtlases(group, { allowRotation: false, padding: 2, maxSize: 4096 }, undefined, mam);
    expect(r.atlases.length).toBe(1); // merged into ONE sheet
    const json = emitTexturePackerJson(r.atlases[0]!);
    const res = parseAtlasManifest(JSON.parse(json) as unknown, { imageRef: r.atlases[0]!.imageRef });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const names = res.atlas.sprites.map((s) => s.name).sort();
      expect(names).toEqual(['coinA', 'coinB', 'uniqA', 'uniqB']); // every original name from BOTH sheets resolves
    }
  });

  it('T4 ADDITIVITY: no cross-sheet dupes ⇒ identity map ⇒ deep-equal to repackAtlases(group, opts)', () => {
    const a = atl('a.png', [sprite('a0', 0), sprite('a1', 32)]);
    const b = atl('b.png', [sprite('b0', 0), sprite('b1', 32)]);
    const group = [a, b];
    const hashes = new Map<string, (string | null)[]>([['a.png', ['p', 'q']], ['b.png', ['r', 's']]]);
    const mam = buildMergeAliasMap(group, hashes, 2);
    expect(mam.aliasedFrames).toBe(0); // no cross-sheet cluster ⇒ identity
    const opts = { allowRotation: false, padding: 2, maxSize: 4096 };
    // No-alias fields (vramReclaimedBytes/potTierDropped) are omitted when nothing aliased ⇒ byte-identical.
    expect(repackAtlases(group, opts, undefined, mam)).toEqual(repackAtlases(group, opts));
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

// ── Lossless metadata strip (pass 2c) — the drop-in fix for `strippable-metadata` findings ───────────
// planFix's `opts.stripMetadata` emits a `strip` op for every strippable-metadata-flagged ref that NO other
// op re-encodes (a transcode/repack/resize/pack/tier already strips it — de-overlapped; owners excluded).
// Pure data assertions: OFF ⇒ no strip op (byte-identical); ON ⇒ exactly one strip op per unclaimed ref,
// carrying ONLY {kind,assetRef}; de-overlap with every re-encoding op; folder-scope ignored; owner excluded.
describe('planFix — lossless metadata strip (strippable-metadata fix)', () => {
  const base = { targetMime: 'image/avif' as const, quality: 0.85, lossless: false, padding: 2, maxSize: 4096, maxEdge: 2048 };
  const strips = (plan: { ops: FixOp[] }) => plan.ops.filter((o): o is Extract<FixOp, { kind: 'strip' }> => o.kind === 'strip');
  const meta = (ref: string): AnalysisReport['findings'][number] =>
    ({ id: `${ref}:strippable-metadata`, rule: 'strippable-metadata', severity: 'info', assetRef: ref, title: '', detail: '', messageKey: 'strippable-metadata', params: { label: 'PNG', bytes: 5000 }, estimate: { diskBytesSaved: 5000 } });
  const format = (ref: string): AnalysisReport['findings'][number] =>
    ({ id: `${ref}:format`, rule: 'format', severity: 'warn', assetRef: ref, title: '', detail: '' });
  const occupancy = (ref: string): AnalysisReport['findings'][number] =>
    ({ id: `${ref}:occupancy`, rule: 'occupancy', severity: 'warn', assetRef: ref, title: '', detail: '' });
  const oversize = (ref: string): AnalysisReport['findings'][number] =>
    ({ id: `${ref}:oversize`, rule: 'dimensions-oversize', severity: 'crit', assetRef: ref, title: '', detail: '', messageKey: 'oversize', params: { w: 4096, h: 4096, edge: 4096, budget: 2730, sev: 'crit', vram: 0 } });
  const reportOf = (findings: AnalysisReport['findings']): AnalysisReport => ({
    assets: findings.map((f) => ({ assetRef: f.assetRef, diskBytes: 1000, vramBytes: 0 })),
    findings,
    totals: { diskBytes: 1000, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
    thresholds: DEFAULT_THRESHOLDS,
  });

  it('OFF ⇒ no strip op (byte-identical to today; the finding stays diagnosis-only)', () => {
    const plan = planFix(reportOf([meta('hero.png')]), { ...base, aggressive: false }); // stripMetadata omitted
    expect(strips(plan)).toHaveLength(0);
  });

  it('ON, strippable-only ref ⇒ exactly one strip op carrying ONLY {kind, assetRef}', () => {
    const plan = planFix(reportOf([meta('hero.png')]), { ...base, aggressive: false, stripMetadata: true });
    const ss = strips(plan);
    expect(ss).toHaveLength(1);
    expect(ss[0]).toEqual({ kind: 'strip', assetRef: 'hero.png' }); // no extra fields — the set is fixed
  });

  it('ON, strippable + format on the SAME ref ⇒ NO strip op (the transcode re-encode already strips it)', () => {
    const plan = planFix(reportOf([format('hero.png'), meta('hero.png')]), { ...base, aggressive: false, stripMetadata: true });
    expect(plan.ops.some((o) => o.kind === 'transcode' && o.assetRef === 'hero.png')).toBe(true);
    expect(strips(plan)).toHaveLength(0);
  });

  it('ON, order-independent: strippable BEFORE the format finding still de-overlaps to zero strip ops', () => {
    const plan = planFix(reportOf([meta('hero.png'), format('hero.png')]), { ...base, aggressive: false, stripMetadata: true });
    expect(strips(plan)).toHaveLength(0);
  });

  it('ON, strippable + oversize (resize) ⇒ NO strip op (resize owns the re-encode)', () => {
    const plan = planFix(reportOf([oversize('big.png'), meta('big.png')]), { ...base, aggressive: false, stripMetadata: true });
    expect(plan.ops.some((o) => o.kind === 'resize' && o.assetRef === 'big.png')).toBe(true);
    expect(strips(plan)).toHaveLength(0);
  });

  it('ON, strippable on a REPACKED atlas page ⇒ NO strip op (the repack re-encodes the page)', () => {
    const plan = planFix(reportOf([occupancy('sheet.png'), meta('sheet.png')]), { ...base, aggressive: false, stripMetadata: true });
    expect(plan.ops.some((o) => o.kind === 'repack' && o.atlasRefs.includes('sheet.png'))).toBe(true);
    expect(strips(plan)).toHaveLength(0);
  });

  it('ON, a folder-scope strippable finding is ignored (no single op target)', () => {
    const plan = planFix(reportOf([{ ...meta('hero.png'), scope: 'folder' as const }]), { ...base, aggressive: false, stripMetadata: true });
    expect(strips(plan)).toHaveLength(0);
  });

  it('ON, a strippable dedup OWNER is excluded (stripping would change the repointed owner bytes/name)', () => {
    const groups: DedupGroup[] = [
      { contentHash: 'h1', pool: 'pixi', skinGroup: 'general', owners: ['owner.png'], consumers: [{ ref: 'copy.png', ownerRef: 'owner.png', reason: 'eager-owner' }] },
    ];
    const plan = planFix(reportOf([meta('owner.png')]), { ...base, aggressive: true, stripMetadata: true }, groups);
    expect(strips(plan)).toHaveLength(0);
  });

  it('ON, duplicate strippable findings on ONE ref ⇒ a single strip op (the stripped guard)', () => {
    const plan = planFix(reportOf([meta('hero.png'), { ...meta('hero.png'), id: 'hero.png:strippable-metadata-2' }]), { ...base, aggressive: false, stripMetadata: true });
    expect(strips(plan)).toHaveLength(1);
  });

  it('ON, two independent strippable refs ⇒ one strip op each, in finding order', () => {
    const plan = planFix(reportOf([meta('a.png'), meta('b.png')]), { ...base, aggressive: false, stripMetadata: true });
    expect(strips(plan).map((s) => s.assetRef)).toEqual(['a.png', 'b.png']);
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

  it('packTrim toggle controls the pack op trim (was INERT — hardcoded trim:true — so turning it off did nothing)', () => {
    const groups = [staticGroup('icons', [['icons/a.png', 'a'], ['icons/b.png', 'b']])];
    const refs = ['icons/a.png', 'icons/b.png'];
    const trimOf = (packTrim?: boolean) =>
      packs(planFix(reportOf(refs), { ...base, aggressive: false, ...(packTrim === undefined ? {} : { packTrim }) }, undefined, groups))[0]!.trim;
    expect(trimOf(false)).toBe(false); // off ⇒ pack the full untrimmed footprint (the fix now honors it)
    expect(trimOf(true)).toBe(true);
    expect(trimOf(undefined)).toBe(true); // absent ⇒ default true ⇒ byte-identical to before
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

  it('preserves page filter + repeat (pixel-art Nearest / tiling wrap are NOT silently forced to Linear/none)', () => {
    const atlas: Atlas = { name: 'pa', imageRef: 'pa.png', size: { w: 64, h: 64 }, filter: 'Nearest,Nearest', repeat: 'x', sprites: [{ name: 'r', frame: { x: 0, y: 0, w: 10, h: 10 }, rotated: false, trimmed: false, sourceSize: { w: 10, h: 10 } }], source: { kind: 'spine' } };
    const out = emitSpineAtlasText(atlas);
    expect(out).toContain('filter: Nearest,Nearest');
    expect(out).toContain('repeat: x');
    const re = parseSpineAtlasText(out)[0]!;
    expect(re.filter).toBe('Nearest,Nearest');
    expect(re.repeat).toBe('x');
  });

  it('emits today defaults when filter/repeat absent (byte-identical to the common Linear/none atlas)', () => {
    const atlas: Atlas = { name: 'd', imageRef: 'd.png', size: { w: 32, h: 32 }, sprites: [{ name: 'r', frame: { x: 0, y: 0, w: 8, h: 8 }, rotated: false, trimmed: false, sourceSize: { w: 8, h: 8 } }], source: { kind: 'spine' } };
    const out = emitSpineAtlasText(atlas);
    expect(out).toContain('filter: Linear,Linear');
    expect(out).toContain('repeat: none');
    expect(out).not.toContain('pma'); // absent ⇒ no pma line ⇒ byte-identical for a straight-alpha atlas
  });

  it('re-emits pma: true on a verbatim path (never silently dropped) + round-trips', () => {
    const atlas: Atlas = { name: 'pm', imageRef: 'pm.png', size: { w: 64, h: 64 }, pma: true, sprites: [{ name: 'r', frame: { x: 0, y: 0, w: 10, h: 10 }, rotated: false, trimmed: false, sourceSize: { w: 10, h: 10 } }], source: { kind: 'spine' } };
    const out = emitSpineAtlasText(atlas);
    expect(out).toContain('pma: true');
    expect(parseSpineAtlasText(out)[0]!.pma).toBe(true);
  });

  it('repackAtlases carries filter/repeat from the source through to the re-emit', () => {
    const atlas: Atlas = { name: 's', imageRef: 'sheet.png', size: { w: 256, h: 256 }, filter: 'Nearest,Nearest', repeat: 'xy', sprites: [{ name: 'r', frame: { x: 0, y: 0, w: 40, h: 40 }, rotated: false, trimmed: false, sourceSize: { w: 40, h: 40 } }], source: { kind: 'spine' } };
    const packed = repackAtlases([atlas], { allowRotation: false, padding: 0, maxSize: 2048 }).atlases[0]!;
    expect(packed.filter).toBe('Nearest,Nearest');
    expect(packed.repeat).toBe('xy');
    expect(emitSpineAtlasText(packed)).toContain('filter: Nearest,Nearest');
  });

  it('re-emits page scale (Spine scaled-variant) + round-trips; absent ⇒ no scale line', () => {
    const atlas: Atlas = { name: 'h', imageRef: 'h.png', size: { w: 128, h: 128 }, scale: 0.5, sprites: [{ name: 'r', frame: { x: 0, y: 0, w: 10, h: 10 }, rotated: false, trimmed: false, sourceSize: { w: 10, h: 10 } }], source: { kind: 'spine' } };
    const out = emitSpineAtlasText(atlas);
    expect(out).toContain('scale: 0.5');
    expect(parseSpineAtlasText(out)[0]!.scale).toBe(0.5);
    const noScale: Atlas = { name: 'h', imageRef: 'h.png', size: { w: 128, h: 128 }, sprites: atlas.sprites, source: { kind: 'spine' } };
    expect(emitSpineAtlasText(noScale)).not.toContain('scale:');
  });

  it('repackAtlases carries meta.scale from the source through to the TexturePacker re-emit (0.5x variant not flattened to 1x)', () => {
    const atlas: Atlas = { name: 'a', imageRef: 'a.png', size: { w: 256, h: 256 }, scale: 0.5, sprites: [{ name: 'r', frame: { x: 0, y: 0, w: 40, h: 40 }, rotated: false, trimmed: false, sourceSize: { w: 40, h: 40 } }], source: { kind: 'texturepacker-hash' } };
    const packed = repackAtlases([atlas], { allowRotation: false, padding: 0, maxSize: 2048 }).atlases[0]!;
    expect(packed.scale).toBe(0.5);
    const json = JSON.parse(emitTexturePackerJson(packed)) as { meta: { scale?: string } };
    expect(json.meta.scale).toBe('0.5');
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

// ── round21 #0: standalone trim-margin → repack scheduling, through the REAL fix-worker analyze→plan wiring.
// The fix worker decodes each atlas page, computes each UNtrimmed sprite's opaque bbox via the SAME pure
// alphaBBox these tests call, feeds `frameTrims` into analyze(), then runs planFix. We reproduce that exact
// pipeline (synthetic decoded RGBA → alphaBBox → frameTrims → analyze → planFix) so the test PROVES the
// trim-margin finding fires and the plan emits its OWN repack op on a FULLY-PACKED padded atlas — the case
// where no occupancy/wasted repack would ever schedule it (B0/B1). No OffscreenCanvas: the in-test RGBA
// buffer is the same data createImageBitmap+getImageData would hand the worker, and alphaBBox is the SAME
// pure helper @asset-doctor/fix exports + the worker imports.
describe('trim-margin → repack scheduling (round21 #0) — real analyze→plan wiring', () => {
  // A FULLY-PACKED 128×64 sheet: two 64×64 untrimmed frames fill it edge-to-edge (100% coverage ⇒ NO
  // occupancy/wasted finding would ever schedule a repack). Each carries an opaque 32×32 core inset at
  // (16,16) within its frame ⇒ 16px margin on every side, recoverable = 2×(64²−32²) = 6144 px of 8192.
  const SHEET_W = 128;
  const SHEET_H = 64;
  const CORE = { x: 16, y: 16, w: 32, h: 32 }; // frame-relative opaque bbox of every padded sprite
  // Build the decoded page: transparent everywhere except each frame's inset opaque core (textured RGB so the
  // art is honest; alphaBBox reads ALPHA only). Exactly the buffer the worker reads off the decoded page.
  const decodePage = (frames: { x: number; y: number }[]): Uint8ClampedArray => {
    const buf = new Uint8ClampedArray(SHEET_W * SHEET_H * 4); // all-zero = fully transparent
    for (const f of frames) {
      for (let dy = 0; dy < CORE.h; dy++) {
        for (let dx = 0; dx < CORE.w; dx++) {
          const px = f.x + CORE.x + dx;
          const py = f.y + CORE.y + dy;
          const o = (py * SHEET_W + px) * 4;
          buf[o] = ((dx + dy) & 1) ? 200 : 40; // 2-color checker (textured core)
          buf[o + 1] = 90;
          buf[o + 2] = 160;
          buf[o + 3] = 255; // opaque
        }
      }
    }
    return buf;
  };
  const paddedAtlas = (): Atlas => ({
    name: 'pad.png',
    imageRef: 'pad.png',
    size: { w: SHEET_W, h: SHEET_H },
    sprites: [
      { name: 'a', frame: { x: 0, y: 0, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 } },
      { name: 'b', frame: { x: 64, y: 0, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 } },
    ],
    source: { kind: 'pixi' },
  });
  // The SAME analyze 3rd-arg the worker builds: AtlasFrameTrims with key `bboxes` (NOT `frameTrims`), bboxes
  // computed via the real alphaBBox off the decoded page, null for any already-trimmed sprite (none here).
  const frameTrimsFor = (atlas: Atlas, page: Uint8ClampedArray): AtlasFrameTrims[] => {
    const src = { data: page, width: SHEET_W };
    const bboxes: (TrimRect | null)[] = atlas.sprites.map((s) =>
      s.trimmed ? null : alphaBBox(src, { x: s.frame.x, y: s.frame.y, w: s.frame.w, h: s.frame.h }),
    );
    return [{ atlasRef: atlas.name, bboxes }];
  };
  const imageOf = (atlas: Atlas) => ({ name: atlas.name, imageRef: atlas.imageRef, size: atlas.size, mime: 'image/png' as const, byteSize: 4000 });
  const base = { targetMime: 'image/webp' as const, quality: 0.9, lossless: true, padding: 2, maxSize: 4096, maxEdge: 2048, aggressive: false };

  it('B0/B1: a FULLY-PACKED padded atlas fires trim-margin (no occupancy) ⇒ EXACTLY one repack op', async () => {
    const atlas = paddedAtlas();
    const page = decodePage(atlas.sprites.map((s) => ({ x: s.frame.x, y: s.frame.y })));
    const report = await analyze([{ kind: 'atlas', atlas, image: imageOf(atlas) }], undefined, { frameTrims: frameTrimsFor(atlas, page) });
    // The sheet is 100% packed ⇒ NO occupancy / wasted-regions finding would schedule a repack.
    expect(report.findings.some((f) => f.rule === 'occupancy' || f.rule === 'wasted-regions')).toBe(false);
    // ...but the trim-margin finding fired off the real-decoded bboxes (B0 — the worker's analyze() now sees them).
    expect(report.findings.some((f) => f.rule === 'trim-margin')).toBe(true);
    // ...and (trimMargin default ON) it emits its OWN repack op — the whole point of the feature.
    const repacks = planFix(report, base).ops.filter((o) => o.kind === 'repack');
    expect(repacks).toHaveLength(1);
    expect(repacks[0]!.kind === 'repack' && repacks[0]!.atlasRefs).toEqual(['pad.png']);
  });

  it('the scheduled repack REALIZES the trim: trimmedSprites > 0 (r20 execute path, real bboxes)', async () => {
    const atlas = paddedAtlas();
    const page = decodePage(atlas.sprites.map((s) => ({ x: s.frame.x, y: s.frame.y })));
    const ft = frameTrimsFor(atlas, page);
    // The plan schedules exactly one repack (asserted above). Feeding the SAME real bboxes into the r20
    // trim-on-repack execute path (repackAtlases({trim})) is what the worker does to realize that op.
    const trim = ft[0]!.bboxes;
    const r = repackAtlases([atlas], { allowRotation: false, padding: base.padding, maxSize: base.maxSize, trim: [trim] });
    expect(r.trimmedSprites).toBeGreaterThan(0); // the receipt's trimmedSprites surfaces this (worker line 3718)
    expect(r.trimmedSprites).toBe(2); // both padded sprites tightened to their opaque cores
    expect(r.trimmedAreaReclaimed).toBe(2 * (64 * 64 - CORE.w * CORE.h)); // 6144 px — exact, measured
    // Drop-in: every name still resolves, each tightened to its bbox extent.
    const out = new Map(r.atlases.flatMap((a) => a.sprites).map((s) => [s.name, s]));
    expect(out.size).toBe(2);
    for (const s of out.values()) expect({ w: s.frame.w, h: s.frame.h }).toEqual({ w: CORE.w, h: CORE.h });
  });

  it('NO double-emit: when occupancy ALSO fires on the same atlas ⇒ still EXACTLY one repack op', async () => {
    // The untrimmed-padding fixture is a 256×256 sheet with 4 small frames ⇒ occupancy fires (under-filled)
    // AND trim-margin fires (untrimmed padding) on the SAME atlasRef. The shared `repacked` set must collapse
    // them to ONE repack op (order-free — findings are SORTED at analyze.ts), never two.
    const padDir = fileURLToPath(new URL('../../../fixtures/sample-projects/untrimmed-padding/', import.meta.url));
    const res = parseAtlas(JSON.parse(readFileSync(`${padDir}sheet.json`, 'utf8')) as unknown, { ref: 'sheet.png', bytes: new Uint8Array(readFileSync(`${padDir}sheet.png`)) });
    if (!res.ok || res.asset.kind !== 'atlas') throw new Error('untrimmed-padding fixture parse failed');
    const atlas = res.asset.atlas;
    const golden = JSON.parse(readFileSync(`${padDir}expected.json`, 'utf8')) as { regions: { name: string; bbox: TrimRect | null }[] };
    const bboxByName = new Map(golden.regions.map((g) => [g.name, g.bbox]));
    const bboxes: (TrimRect | null)[] = atlas.sprites.map((s) => (s.trimmed ? null : bboxByName.get(s.name) ?? null));
    const report = await analyze([{ kind: 'atlas', atlas, image: imageOf(atlas) }], undefined, { frameTrims: [{ atlasRef: atlas.name, bboxes }] });
    expect(report.findings.some((f) => f.rule === 'occupancy' || f.rule === 'wasted-regions')).toBe(true); // under-filled ⇒ occupancy
    expect(report.findings.some((f) => f.rule === 'trim-margin')).toBe(true); // untrimmed padding ⇒ trim-margin
    const repacks = planFix(report, base).ops.filter((o) => o.kind === 'repack');
    expect(repacks).toHaveLength(1); // ONE op for the atlas — the occupancy + trim-margin findings collapse
    expect(repacks[0]!.kind === 'repack' && repacks[0]!.atlasRefs).toEqual(['sheet.png']);
  });

  it('additive: trimMargin:false ⇒ NO new repack op, plan byte-identical to omitting the frameTrims feed', async () => {
    const atlas = paddedAtlas();
    const page = decodePage(atlas.sprites.map((s) => ({ x: s.frame.x, y: s.frame.y })));
    // OFF in the WORKER means it never feeds frameTrims (no bbox pass), so analyze() has no trim-margin
    // finding at all — modeled here by omitting the 3rd-arg frameTrims (the worker's `trimMargin:false` path).
    const reportOff = await analyze([{ kind: 'atlas', atlas, image: imageOf(atlas) }]);
    expect(reportOff.findings.some((f) => f.rule === 'trim-margin')).toBe(false);
    expect(planFix(reportOff, base).ops.some((o) => o.kind === 'repack')).toBe(false);
    // And even if a trim-margin finding WERE present, opts.trimMargin:false suppresses its repack op (the
    // plan-level gate) ⇒ byte-identical to the no-finding plan above.
    const reportOn = await analyze([{ kind: 'atlas', atlas, image: imageOf(atlas) }], undefined, { frameTrims: frameTrimsFor(atlas, page) });
    expect(planFix(reportOn, { ...base, trimMargin: false }).ops.some((o) => o.kind === 'repack')).toBe(false);
    expect(planFix(reportOn, { ...base, trimMargin: false })).toEqual(planFix(reportOff, base));
  });
});
