import { describe, expect, it } from 'vitest';
import type { Asset, Atlas, Finding, ImageAsset } from '@asset-doctor/core';
import type { AnalysisReport } from '@asset-doctor/core';
import type { RuntimeReport } from '@asset-doctor/probe/runtime';
import {
  DEFAULT_THRESHOLDS as cfg,
  occupancyFinding,
  dimensionFindings,
  solidFillFinding,
  upscaledSourceFinding,
  frameRedundancyFinding,
  trimMarginFinding,
  bleedingFinding,
  dimensionMismatchFinding,
  wastedAlphaFinding,
  strippableMetadataFinding,
  strippableMetadataAggregateFinding,
  iccNonSrgbFinding,
  interiorTransparencyFinding,
  binaryAlphaFinding,
  wastedRegions,
  formatFinding,
  duplicateExactFindings,
  duplicateSimilarFindings,
  shouldAtlasFinding,
  atlasMergeFinding,
  crossAtlasRedundancyFinding,
  gpuCompressionAlignmentFinding,
  gutterFinding,
  spineUnreferencedRegionsFindings,
  premultipliedAlphaFinding,
  fontGlyphPageFinding,
  repackOpportunityFinding,
  integrityFindings,
  formatAggregateFinding,
  groupVariants,
  variantsFinding,
} from '@asset-doctor/analysis';
import { correlate, correlateFix } from '@asset-doctor/correlate';
import { detectLocale, renderCorrelated, renderFinding, translate } from '../src/index';

const img = (name: string, w: number, h: number, byteSize = 1000, mime: ImageAsset['mime'] = 'image/png'): Asset => ({
  kind: 'image',
  image: { name, imageRef: name, size: { w, h }, mime, byteSize },
});
const atlas = (name: string, sprites: number, sw: number): Atlas => ({
  name,
  imageRef: `${name}.png`,
  size: { w: 1024, h: 1024 },
  sprites: Array.from({ length: sprites }, (_, i) => ({ name: `${name}_${i}`, frame: { x: 0, y: 0, w: sw, h: sw }, rotated: false, trimmed: false, sourceSize: { w: sw, h: sw } })),
  source: { kind: 'pixi' },
});

async function realFindings(): Promise<Finding[]> {
  const out: Finding[] = [];
  const a = atlas('sheet', 1, 200);
  out.push(occupancyFinding(a, cfg)!);
  out.push(wastedRegions(a, cfg)!);
  out.push(...dimensionFindings('big.png', { w: 4096, h: 4096 }, cfg)); // oversize (POT → no npot)
  out.push(...dimensionFindings('icon.png', { w: 100, h: 100 }, cfg)); // npot (not oversize)
  out.push(solidFillFinding('plate.png', { w: 1024, h: 1024 }, cfg)!); // solid-fill (warn)
  out.push(upscaledSourceFinding('up.png', { w: 2048, h: 2048 }, cfg, 1)!); // upscaled-source (depth 1, warn)
  // frame-redundancy: 4 frames at DISTINCT rects, 3 sharing one region hash (the gate is minDuplicates 3).
  const frAtlas: Atlas = {
    name: 'anim.png', imageRef: 'anim.png', size: { w: 256, h: 256 }, source: { kind: 'pixi' },
    sprites: [0, 1, 2, 3].map((i) => ({ name: `f${i}`, frame: { x: i * 32, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } })),
  };
  out.push(frameRedundancyFinding(frAtlas, cfg, ['hh', 'hh', 'hh', 'other'], 8000)!);
  // trim-margin: 2 untrimmed 64×64 frames on a 256² sheet, each with a 32×32 opaque core inset 16px →
  // recoverable 2×(64²−32²) = 6144 px (9.4% of 256², clears minRecoverablePct). Plural ('other') form.
  const tmAtlas: Atlas = {
    name: 'pad.png', imageRef: 'pad.png', size: { w: 256, h: 256 }, source: { kind: 'pixi' },
    sprites: [0, 1].map((i) => ({ name: `p${i}`, frame: { x: i * 64, y: 0, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 } })),
  };
  out.push(trimMarginFinding(tmAtlas, cfg, [{ x: 16, y: 16, w: 32, h: 32 }, { x: 16, y: 16, w: 32, h: 32 }])!);
  // bleeding: 2 frames touching with a 0px gutter and vertical overlap ⇒ 1 zero-gutter pair (minPairs:1).
  // A CORRECTNESS finding — plural on {pairs}, NO estimate (invariant 5).
  const blAtlas: Atlas = {
    name: 'tight.png', imageRef: 'tight.png', size: { w: 256, h: 256 }, source: { kind: 'pixi' },
    sprites: [0, 1].map((i) => ({ name: `t${i}`, frame: { x: i * 32, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } })),
  };
  out.push(bleedingFinding(blAtlas, { ...cfg, bleeding: { minPairs: 1, warnPairs: 16 } })!);
  // dimension-mismatch: three direction-distinct messageKeys (one Rule). CORRECTNESS findings — NO estimate.
  // (a) shrunk + off-edge (crit): declared 1024² but the real image is 512², and a frame is placed past 512.
  const dmAtlas: Atlas = {
    name: 'declared.png', imageRef: 'declared.png', size: { w: 1024, h: 1024 }, source: { kind: 'pixi' },
    sprites: [{ name: 'off', frame: { x: 600, y: 0, w: 100, h: 100 }, rotated: false, trimmed: false, sourceSize: { w: 100, h: 100 } }],
  };
  const dmImg512: ImageAsset = { name: 'declared.png', imageRef: 'declared.png', size: { w: 512, h: 512 }, mime: 'image/png', byteSize: 8000 };
  out.push(dimensionMismatchFinding(dmAtlas, dmImg512, cfg)!);
  // (b) shrunk, all frames in bounds (warn): declared 1024², real 512², the only frame fits within 512.
  const dmAtlasIn: Atlas = {
    name: 'declared-in.png', imageRef: 'declared-in.png', size: { w: 1024, h: 1024 }, source: { kind: 'pixi' },
    sprites: [{ name: 'in', frame: { x: 0, y: 0, w: 100, h: 100 }, rotated: false, trimmed: false, sourceSize: { w: 100, h: 100 } }],
  };
  out.push(dimensionMismatchFinding(dmAtlasIn, dmImg512, cfg)!);
  // (c) grown (info): declared 512² but the real image is 1024² (extra border the manifest doesn't map).
  const dmAtlasGrown: Atlas = {
    name: 'declared-small.png', imageRef: 'declared-small.png', size: { w: 512, h: 512 }, source: { kind: 'pixi' },
    sprites: [{ name: 'g', frame: { x: 0, y: 0, w: 100, h: 100 }, rotated: false, trimmed: false, sourceSize: { w: 100, h: 100 } }],
  };
  const dmImg1024: ImageAsset = { name: 'declared-small.png', imageRef: 'declared-small.png', size: { w: 1024, h: 1024 }, mime: 'image/png', byteSize: 8000 };
  out.push(dimensionMismatchFinding(dmAtlasGrown, dmImg1024, cfg)!);
  // wasted-alpha: a fully-opaque PNG re-encoded opaque saves bytes (sizer 7000 < byteSize 10000 = 30%)
  out.push((await wastedAlphaFinding('flat.png', img('flat.png', 256, 256, 10000).image, cfg, async () => 7000))!);
  // strippable-metadata: a PNG carrying 80 KB of ICC/EXIF metadata ⇒ warn (≥ warnBytes 64 KB). DISK-only.
  const metaImg = { ...img('meta.png', 256, 256, 200000).image, strippableBytes: 81920 };
  out.push(strippableMetadataFinding('meta.png', metaImg, cfg)!);
  // strippable-metadata-aggregate: ≥2 per-asset metadata findings rolled up (folder scope).
  const m1 = strippableMetadataFinding('meta1.png', { ...img('meta1.png', 256, 256, 200000).image, strippableBytes: 10000 }, cfg)!;
  const m2 = strippableMetadataFinding('meta2.png', { ...img('meta2.png', 256, 256, 200000).image, strippableBytes: 20000 }, cfg)!;
  out.push(strippableMetadataAggregateFinding([m1, m2])!);
  // icc-non-srgb: a PNG embedding a non-sRGB ICC profile — a DISCLOSURE finding, NO estimate (invariant 5).
  const iccImg = { ...img('p3.png', 256, 256, 200000).image, icc: { bytes: 8227, provableSrgb: false, label: 'Display P3' } };
  out.push(iccNonSrgbFinding('p3.png', iccImg)!);
  // interior-transparency: a ring-like alphaShape (bbox 200×200, 24000 transparent inside = ratio 60%)
  // over the default gate (minBboxPx 16384, minRatio 0.35) — a fill-rate DISCLOSURE, info, NO estimate.
  out.push(interiorTransparencyFinding('ring.png', { w: 256, h: 256 }, cfg,
    { bboxW: 200, bboxH: 200, interiorTransparent: 24000, binaryAlpha: true, opaqueCount: 16000 })!);
  // binary-alpha: a hard cutout (every alpha byte 0/255, not fully opaque) at edge ≥ minEdgePx (128) —
  // a 1-bit-channel DISCLOSURE, info, NO estimate.
  out.push(binaryAlphaFinding('cutout.png', { w: 256, h: 256 }, cfg,
    { bboxW: 256, bboxH: 256, interiorTransparent: 100, binaryAlpha: true, opaqueCount: 60000 })!);
  out.push((await formatFinding('hero.png', img('hero.png', 256, 256, 10000).image, cfg, async () => 4000))!);
  // flat/alpha-art content class ⇒ messageKey 'format-lossless' (rule still 'format') — drift-check the
  // new key family + its baked EN strings exactly like every other finding.
  out.push((await formatFinding('panel.png', img('panel.png', 256, 256, 10000).image, cfg, async () => 4000, 'flat'))!);
  out.push(duplicateExactFindings([img('a.png', 64, 64, 500), img('b.png', 64, 64, 500)], [{ assetRef: 'a.png', contentHash: 'hh' }, { assetRef: 'b.png', contentHash: 'hh' }])[0]!);
  out.push(duplicateSimilarFindings([{ assetRef: 'x.png', contentHash: 'c1', dHash: 'aaaaaaaaaaaaaaaa' }, { assetRef: 'y.png', contentHash: 'c2', dHash: 'aaaaaaaaaaaaaaab' }], cfg)[0]!);
  out.push(shouldAtlasFinding(Array.from({ length: 8 }, (_, i) => img(`s${i}.png`, 64, 64, 100)), cfg)!);
  out.push(atlasMergeFinding([atlas('m1', 1, 200), atlas('m2', 1, 200)], cfg)!);
  // atlas-merge-batching: heterogeneous under-filled set whose largest atlas is a WIDE 2048×512 banner.
  // The merged-square-at-maxDim model (2048²) over-allocates ⇒ currentVram − mergedVram ≤ 0, so the finding
  // drops the VRAM clause and emits messageKey 'atlas-merge-batching' (merged=1 ⇒ exercises the 'one' plural).
  const bMerge = atlasMergeFinding(
    [
      { name: 'b0', imageRef: 'b0.png', size: { w: 2048, h: 512 }, source: { kind: 'pixi' },
        sprites: [{ name: 's', frame: { x: 0, y: 0, w: 200, h: 200 }, rotated: false, trimmed: false, sourceSize: { w: 200, h: 200 } }] },
      { name: 'b1', imageRef: 'b1.png', size: { w: 1024, h: 1024 }, source: { kind: 'pixi' },
        sprites: [{ name: 's', frame: { x: 0, y: 0, w: 200, h: 200 }, rotated: false, trimmed: false, sourceSize: { w: 200, h: 200 } }] },
      { name: 'b2', imageRef: 'b2.png', size: { w: 512, h: 512 }, source: { kind: 'pixi' },
        sprites: [{ name: 's', frame: { x: 0, y: 0, w: 200, h: 200 }, rotated: false, trimmed: false, sourceSize: { w: 200, h: 200 } }] },
    ],
    cfg,
  )!;
  out.push(bMerge);
  // cross-atlas-redundancy: two atlases sharing ONE byte-identical frame region on a DISTINCT rect each →
  // 1 cluster spanning 2 sheets, 1 recoverable copy. Distinct messageKey (not 'frame-redundancy').
  const caA: Atlas = {
    name: 'caA.png', imageRef: 'caA.png', size: { w: 256, h: 256 }, source: { kind: 'pixi' },
    sprites: [{ name: 'a0', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } }],
  };
  const caB: Atlas = {
    name: 'caB.png', imageRef: 'caB.png', size: { w: 256, h: 256 }, source: { kind: 'pixi' },
    sprites: [{ name: 'b0', frame: { x: 64, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } }],
  };
  out.push(crossAtlasRedundancyFinding([caA, caB], new Map([['caA.png', ['sh']], ['caB.png', ['sh']]]), new Map([['caA.png', 8000], ['caB.png', 8000]]), cfg)!);
  // premultiplied-alpha: two loose sprites whose host-measured edge shape clears the default gate
  // (edgePixels ≥ 24, fringeFrac ≥ 0.5, minSprites 2) → the ONE folder disclosure (info, NO estimate).
  out.push(premultipliedAlphaFinding(
    [img('pm_a.png', 64, 64), img('pm_b.png', 64, 64)],
    [
      { assetRef: 'pm_a.png', contentHash: 'p1', premultipliedEdge: { edgePixels: 40, fringeFrac: 0.9 } },
      { assetRef: 'pm_b.png', contentHash: 'p2', premultipliedEdge: { edgePixels: 32, fringeFrac: 1 } },
    ],
    cfg,
  )!);
  // gpu-compression-alignment: two textures with a non-%4 edge (header-only fact) → the ONE folder
  // disclosure (info, NO estimate — alignment fact, never a predicted footprint).
  out.push(gpuCompressionAlignmentFinding([img('odd_a.png', 130, 64), img('odd_b.png', 64, 66)], cfg)!);
  // excessive-gutter: a 5-frame row with uniform 16px gaps → 4 measured gaps (the last frame has no
  // right/below neighbour), median 16 ≥ minMedianPx (8), 4 ≥ minGaps (4).
  const gutAtlas: Atlas = {
    name: 'padded.png', imageRef: 'padded.png', size: { w: 512, h: 128 }, source: { kind: 'pixi' },
    sprites: [0, 1, 2, 3, 4].map((i) => ({ name: `g${i}`, frame: { x: i * 80, y: 0, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 } })),
  };
  out.push(gutterFinding(gutAtlas, cfg)!);
  // spine-unreferenced-regions: a 2-region page where the paired skeleton references only one — the
  // pairing-trust gate passes (matched 1/2 = 0.5 ≥ minMatchedFraction) and fx_unused is disclosed.
  const spineAtlas: Atlas = {
    name: 'spine/hero.png', imageRef: 'spine/hero.png', size: { w: 256, h: 256 }, source: { kind: 'spine' },
    sprites: [
      { name: 'head', frame: { x: 0, y: 0, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 } },
      { name: 'fx_unused', frame: { x: 80, y: 0, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 } },
    ],
  };
  out.push(...spineUnreferencedRegionsFindings([spineAtlas], [{
    atlasRefs: ['spine/hero.png'], refNames: ['head'], refPrefixes: [], skeletonRefs: ['spine/hero.json'],
  }], cfg));
  // font-glyph-page: a sparse bmfont page — 16 glyphs of 32×32 on 256² → occ 0.25 ≤ occupancyWarn (0.5)
  // ⇒ warn; kerning 12 (>1) drives the 'other' plural; face non-empty drives the detail prefix.
  const fontAtlas: Atlas = {
    name: 'font.png', imageRef: 'font.png', size: { w: 256, h: 256 }, source: { kind: 'bmfont' },
    sprites: Array.from({ length: 16 }, (_, i) => ({ name: `glyph_${i}`, frame: { x: (i % 8) * 32, y: Math.floor(i / 8) * 32, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } })),
  };
  out.push(fontGlyphPageFinding(fontAtlas, cfg, { faceName: 'Arial', kerningCount: 12 })!);
  // repack-opportunity: a 1024² sheet whose 3 frames dry-run-pack into 512² (host-injected sim) —
  // before 4 MB, after 1 MB, saved 3 MB ≥ floor; after·2 ≤ before ⇒ warn. image.size === atlas.size.
  const rpAtlas: Atlas = {
    name: 'sheet.png', imageRef: 'sheet.png', size: { w: 1024, h: 1024 }, source: { kind: 'pixi' },
    sprites: [0, 1, 2].map((i) => ({ name: `r${i}`, frame: { x: i * 260, y: 0, w: 250, h: 250 }, rotated: false, trimmed: false, sourceSize: { w: 250, h: 250 } })),
  };
  const rpImage: ImageAsset = { name: 'sheet.png', imageRef: 'sheet.png', size: { w: 1024, h: 1024 }, mime: 'image/png', byteSize: 90000 };
  out.push(repackOpportunityFinding(rpAtlas, rpImage, cfg, { assetRef: 'sheet.png', pages: [{ w: 512, h: 512 }], padding: 2 })!);
  out.push(integrityFindings([{ manifest: 'm.json', image: 'x.png' }])[0]!);
  const ff1 = (await formatFinding('hero.png', img('hero.png', 256, 256, 10000).image, cfg, async () => 4000))!;
  const ff2 = (await formatFinding('logo.png', img('logo.png', 256, 256, 20000).image, cfg, async () => 8000))!;
  out.push(formatAggregateFinding([ff1, ff2])!);
  out.push(variantsFinding(groupVariants([img('hero_540p.png', 540, 540, 1000), img('hero_1080p.png', 1080, 1080, 4000)]))!);
  return out;
}

describe('renderFinding — English catalog reproduces the baked strings (drift guard)', () => {
  it('every rule renders identically via the catalog', async () => {
    const findings = await realFindings();
    const keys = new Set(findings.map((f) => f.messageKey));
    // sanity: we exercised every messageKey family the rules emit
    expect(keys).toEqual(new Set(['occupancy', 'wasted-regions', 'oversize', 'npot', 'solid-fill', 'upscaled-source', 'frame-redundancy', 'trim-margin', 'bleeding', 'dimension-mismatch-shrunk-offedge', 'dimension-mismatch-shrunk', 'dimension-mismatch-grown', 'cross-atlas-redundancy', 'premultiplied-alpha', 'gpu-compression-alignment', 'excessive-gutter', 'spine-unreferenced-regions', 'interior-transparency', 'binary-alpha', 'font-glyph-page', 'repack-opportunity', 'wasted-alpha', 'strippable-metadata', 'strippable-metadata-aggregate', 'icc-non-srgb', 'format', 'format-lossless', 'duplicate-exact', 'duplicate-similar', 'should-atlas', 'atlas-merge', 'atlas-merge-batching', 'integrity', 'format-aggregate', 'variants']));
    for (const f of findings) {
      expect(f.messageKey, `${f.id} must carry a messageKey`).toBeTruthy();
      const r = renderFinding(f, 'en');
      expect(r.title, `${f.messageKey}.title`).toBe(f.title);
      expect(r.detail, `${f.messageKey}.detail`).toBe(f.detail);
      expect(r.fix, `${f.messageKey}.fix`).toBe(f.fix);
      // a translated locale renders non-empty text with all placeholders resolved (no leftover braces)
      const ru = renderFinding(f, 'ru');
      expect(ru.title.length, `${f.messageKey} ru.title`).toBeGreaterThan(0);
      expect(ru.title, `${f.messageKey} ru.title braces`).not.toContain('{');
      expect(ru.detail, `${f.messageKey} ru.detail braces`).not.toContain('{');
    }
  });

  it('falls back to baked strings when no messageKey', () => {
    const f: Finding = { id: 'x', rule: 'occupancy', severity: 'warn', assetRef: 'a', title: 'T', detail: 'D', fix: 'F' };
    expect(renderFinding(f, 'ru')).toEqual({ title: 'T', detail: 'D', fix: 'F' });
  });
});

const rt = (over: Partial<RuntimeReport>): RuntimeReport => ({
  frames: 100,
  drawCalls: { avg: 1, max: 1 },
  textureBinds: { avg: 0, max: 0 },
  redundantBinds: 0,
  uploadsDuringGameplay: 0,
  shaderCompilesDuringGameplay: 0,
  liveTextures: 0,
  vramBytes: 0,
  hitches: [],
  timing: { fps: 60, frameTimeMsAvg: 16, frameTimeMsP95: 16, deviceDependent: true },
  ...over,
});
const stat = (findings: Finding[], totals: Partial<AnalysisReport['totals']> = {}): AnalysisReport => ({
  assets: [],
  findings,
  totals: { diskBytes: 0, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0, ...totals },
  thresholds: cfg,
});

describe('renderCorrelated — English catalog reproduces the baked correlate strings', () => {
  it('every correlation rule renders identically', () => {
    const sa = shouldAtlasFinding(Array.from({ length: 8 }, (_, i) => img(`s${i}.png`, 64, 64, 100)), cfg)!;
    const reports = [
      correlate(stat([sa]), rt({ drawCalls: { avg: 4, max: 60 }, textureBinds: { avg: 128, max: 128 } })),
      correlate(stat([], { loadedVramBytes: 10 * 1048576 }), rt({ vramBytes: 100 * 1048576 })),
      correlate(stat([]), rt({ uploadsDuringGameplay: 3, hitches: [{ frame: 1, ms: 5, cause: 'texture upload' }] })),
      correlate(stat([]), rt({ shaderCompilesDuringGameplay: 2, hitches: [{ frame: 1, ms: 7, cause: 'shader compile' }] })),
      correlate(stat([]), rt({ redundantBinds: 600, frames: 100 })),
    ];
    const all = reports.flatMap((r) => r.findings);
    expect(new Set(all.map((f) => f.rule))).toEqual(new Set(['batching', 'vram', 'upload-hitch', 'shader-hitch', 'redundant-state']));
    for (const f of all) {
      const r = renderCorrelated(f, 'en');
      expect(r.title, `${f.rule}.title`).toBe(f.title);
      expect(r.staticEvidence, `${f.rule}.static`).toBe(f.staticEvidence);
      expect(r.runtimeEvidence, `${f.rule}.runtime`).toBe(f.runtimeEvidence);
      expect(r.diagnosis, `${f.rule}.diag`).toBe(f.diagnosis);
      expect(r.fix, `${f.rule}.fix`).toBe(f.fix);
    }
  });

  // BLOCKER 1 regression: the new `variant:'measured'` pickV branch must NOT disturb the live path.
  // The live correlate findings carry no `variant`, so renderCorrelated must stay byte-identical to the
  // baked English fields with the branch in place.
  it('live findings are byte-identical via the catalog despite the new measured branch', () => {
    const sa = shouldAtlasFinding(Array.from({ length: 8 }, (_, i) => img(`s${i}.png`, 64, 64, 100)), cfg)!;
    const reports = [
      correlate(stat([sa]), rt({ drawCalls: { avg: 4, max: 60 }, textureBinds: { avg: 128, max: 128 } })),
      correlate(stat([], { loadedVramBytes: 10 * 1048576 }), rt({ vramBytes: 100 * 1048576 })),
      correlate(stat([]), rt({ uploadsDuringGameplay: 3, hitches: [{ frame: 1, ms: 5, cause: 'texture upload' }] })),
      correlate(stat([]), rt({ shaderCompilesDuringGameplay: 2, hitches: [{ frame: 1, ms: 7, cause: 'shader compile' }] })),
      correlate(stat([]), rt({ redundantBinds: 600, frames: 100 })),
    ];
    for (const f of reports.flatMap((r) => r.findings)) {
      const r = renderCorrelated(f, 'en');
      expect(r).toEqual({ title: f.title, staticEvidence: f.staticEvidence, runtimeEvidence: f.runtimeEvidence, diagnosis: f.diagnosis, fix: f.fix });
    }
  });

  it('correlateFix measured verdicts render via the *_measured templates (en + ru, brace-free)', () => {
    const fixes = correlateFix({ sheetDiffs: [{ name: 's', drawCallsBefore: 120, drawCallsAfter: 30, decodedVramBefore: 40 * 1048576, decodedVramAfter: 25 * 1048576 }] });
    expect(fixes.map((f) => f.rule)).toEqual(['batching', 'vram']);
    const en0 = renderCorrelated(fixes[0]!, 'en');
    expect(en0.title).toBe('120 → 30 draw calls — measured on this device');
    expect(en0.title).toContain('measured');
    expect(en0.runtimeEvidence).toContain('120');
    expect(en0.runtimeEvidence).toContain('30');
    const en1 = renderCorrelated(fixes[1]!, 'en');
    expect(en1.title).toContain('measured');
    expect(en1.title).toContain('40.0 MB');
    expect(en1.title).toContain('25.0 MB');
    expect(en1.diagnosis).toContain('w·h·4'); // invariant 5 disclosure kept in the copy
    for (const f of fixes) {
      const ru = renderCorrelated(f, 'ru');
      for (const v of [ru.title, ru.staticEvidence, ru.runtimeEvidence, ru.diagnosis, ru.fix]) {
        expect(v.length).toBeGreaterThan(0);
        expect(v).not.toContain('{');
      }
    }
  });
});

describe('translate runtime', () => {
  it('interpolates format hints', () => {
    expect(translate('en', 'find.occupancy.title', { occ: 0.4, wasted: 0.6 })).toBe('Atlas 40% packed — 60% wasted');
    expect(translate('en', 'find.format-aggregate.title', { n: 2, saved: 18000 })).toBe('2 images could shrink — 17.6 KB total');
    expect(translate('en', 'find.oversize.detail', { edge: 4096, budget: 2730, sev: 'crit', w: 4096, h: 4096, vram: 67108864 })).toContain('2730px crit budget');
  });
  it('selects plural categories', () => {
    expect(translate('en', 'folder.issues', { n: 1 })).toBe('1 whole-folder issue');
    expect(translate('en', 'folder.issues', { n: 5 })).toBe('5 whole-folder issues');
  });
  it('detects locale from language tags', () => {
    expect(detectLocale(['pt-BR', 'en'])).toBe('pt');
    expect(detectLocale(['zh-Hans-CN'])).toBe('zh');
    expect(detectLocale(['xx-YY'])).toBe('en');
  });
  it('returns the key when missing everywhere', () => {
    expect(translate('en', 'nope.missing')).toBe('nope.missing');
  });
});
