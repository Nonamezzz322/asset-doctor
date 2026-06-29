import { describe, expect, it } from 'vitest';
import type { Asset, Atlas, Finding, ImageAsset } from '@asset-doctor/core';
import type { AnalysisReport } from '@asset-doctor/core';
import type { RuntimeReport } from '@asset-doctor/probe/runtime';
import {
  DEFAULT_THRESHOLDS as cfg,
  occupancyFinding,
  dimensionFindings,
  solidFillFinding,
  frameRedundancyFinding,
  trimMarginFinding,
  wastedAlphaFinding,
  wastedRegions,
  formatFinding,
  duplicateExactFindings,
  duplicateSimilarFindings,
  shouldAtlasFinding,
  atlasMergeFinding,
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
  out.push(trimMarginFinding(tmAtlas, cfg, [{ x: 16, y: 16, w: 32, h: 32 }, { x: 16, y: 16, w: 32, h: 32 }], 8000)!);
  // wasted-alpha: a fully-opaque PNG re-encoded opaque saves bytes (sizer 7000 < byteSize 10000 = 30%)
  out.push((await wastedAlphaFinding('flat.png', img('flat.png', 256, 256, 10000).image, cfg, async () => 7000))!);
  out.push((await formatFinding('hero.png', img('hero.png', 256, 256, 10000).image, cfg, async () => 4000))!);
  // flat/alpha-art content class ⇒ messageKey 'format-lossless' (rule still 'format') — drift-check the
  // new key family + its baked EN strings exactly like every other finding.
  out.push((await formatFinding('panel.png', img('panel.png', 256, 256, 10000).image, cfg, async () => 4000, 'flat'))!);
  out.push(duplicateExactFindings([img('a.png', 64, 64, 500), img('b.png', 64, 64, 500)], [{ assetRef: 'a.png', contentHash: 'hh' }, { assetRef: 'b.png', contentHash: 'hh' }])[0]!);
  out.push(duplicateSimilarFindings([{ assetRef: 'x.png', contentHash: 'c1', dHash: 'aaaaaaaaaaaaaaaa' }, { assetRef: 'y.png', contentHash: 'c2', dHash: 'aaaaaaaaaaaaaaab' }], cfg)[0]!);
  out.push(shouldAtlasFinding(Array.from({ length: 8 }, (_, i) => img(`s${i}.png`, 64, 64, 100)), cfg)!);
  out.push(atlasMergeFinding([atlas('m1', 1, 200), atlas('m2', 1, 200)], cfg)!);
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
    expect(keys).toEqual(new Set(['occupancy', 'wasted-regions', 'oversize', 'npot', 'solid-fill', 'frame-redundancy', 'trim-margin', 'wasted-alpha', 'format', 'format-lossless', 'duplicate-exact', 'duplicate-similar', 'should-atlas', 'atlas-merge', 'integrity', 'format-aggregate', 'variants']));
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
