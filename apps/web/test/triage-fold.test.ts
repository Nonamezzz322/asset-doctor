import { describe, expect, it } from 'vitest';
import type { AnalysisReport, AssetMetrics, Finding, Rule, Severity, ThresholdConfig } from '@asset-doctor/core';
import { FOLDABLE_RULES, foldableFindingIds, looseDominated, looseRecommendation } from '../src/lib/triage';

// ── builders ────────────────────────────────────────────────────────────────────────────────────
const asset = (assetRef: string): AssetMetrics => ({ assetRef, diskBytes: 0, vramBytes: 0, vramBytesMipmapped: 0 });

const finding = (id: string, assetRef: string, rule: Rule, severity: Severity, extra: Partial<Finding> = {}): Finding => ({
  id,
  rule,
  severity,
  assetRef,
  title: id,
  detail: '',
  ...extra,
});

/** The single should-atlas folder finding (its relatedRefs ARE the loose fold set). */
const shouldAtlas = (refs: string[], n = refs.length): Finding => ({
  id: 'folder:should-atlas',
  rule: 'should-atlas',
  severity: 'warn',
  scope: 'folder',
  assetRef: refs[0] ?? 'x',
  relatedRefs: refs,
  title: 'should-atlas',
  detail: '',
  params: { n },
});

const thresholds = (over: Partial<ThresholdConfig['shouldAtlas']> = {}): ThresholdConfig =>
  ({ shouldAtlas: { minLooseImages: 8, maxSpriteEdgePx: 512, dominatedFraction: 0.5, ...over } }) as unknown as ThresholdConfig;

const report = (
  assets: AssetMetrics[],
  findings: Finding[],
  thr: ThresholdConfig = thresholds(),
): AnalysisReport => ({
  assets,
  findings,
  totals: {
    diskBytes: 0,
    vramBytes: 0,
    vramBytesMipmapped: 0,
    loadedVramBytes: 0,
    loadedVramBytesMipmapped: 0,
    potentialDiskSaved: 0,
  },
  thresholds: thr,
});

const looseRefs = (n: number, prefix = 'loose'): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const assetsFor = (refs: string[]): AssetMetrics[] => refs.map(asset);

describe('looseRecommendation (§2.3)', () => {
  it('0 loose (no should-atlas finding) ⇒ null', () => {
    expect(looseRecommendation(report(assetsFor(looseRefs(3)), []))).toBeNull();
  });

  it('below the minLooseImages floor ⇒ null (belt-and-braces, even if a should-atlas finding is present)', () => {
    const refs = looseRefs(5);
    const rep = report(assetsFor(refs), [shouldAtlas(refs)]);
    expect(looseRecommendation(rep)).toBeNull(); // 5 < minLooseImages(8)
  });

  it('8 loose (exactly the floor) beside a few atlases ⇒ present, n verbatim', () => {
    const loose = looseRefs(8);
    const all = [...loose, ...looseRefs(4, 'atlas')];
    const rep = report(assetsFor(all), [shouldAtlas(loose)]);
    const rec = looseRecommendation(rep);
    expect(rec).not.toBeNull();
    expect(rec!.n).toBe(8); // 8/12 = 0.667 ≥ 0.5
    expect(rec!.refs).toEqual(loose);
  });

  it('mixed 8 loose + 500 atlases ⇒ null (NOT dominated — the core fix)', () => {
    const loose = looseRefs(8);
    const all = [...loose, ...looseRefs(500, 'atlas')];
    const rep = report(assetsFor(all), [shouldAtlas(loose)]);
    expect(looseRecommendation(rep)).toBeNull(); // 8/508 ≈ 0.016 < 0.5
  });

  it('1000 loose ⇒ present with n = 1000 verbatim (from should-atlas.params.n)', () => {
    const loose = looseRefs(1000);
    const rep = report(assetsFor(loose), [shouldAtlas(loose, 1000)]);
    const rec = looseRecommendation(rep);
    expect(rec!.n).toBe(1000);
  });

  it('200 big backgrounds only (no should-atlas) ⇒ null', () => {
    expect(looseRecommendation(report(assetsFor(looseRefs(200, 'bg')), []))).toBeNull();
  });

  it('already spritesheets (all atlases, no should-atlas) ⇒ null', () => {
    expect(looseRecommendation(report(assetsFor(looseRefs(20, 'sheet')), []))).toBeNull();
  });

  it('missing dominatedFraction ⇒ null (fail-closed)', () => {
    const loose = looseRefs(20);
    const thr = thresholds({ dominatedFraction: undefined });
    expect(looseRecommendation(report(assetsFor(loose), [shouldAtlas(loose)], thr))).toBeNull();
  });

  it('total === 0 assets ⇒ null (guards divide-by-zero)', () => {
    const loose = looseRefs(20);
    // a should-atlas finding but an empty assets array (degenerate) ⇒ null before the division
    expect(looseRecommendation(report([], [shouldAtlas(loose)]))).toBeNull();
  });

  it('looseDominated mirrors looseRecommendation !== null', () => {
    const loose = looseRefs(8);
    const dominated = report(assetsFor(loose), [shouldAtlas(loose)]);
    const notDominated = report(assetsFor([...loose, ...looseRefs(500, 'atlas')]), [shouldAtlas(loose)]);
    expect(looseDominated(dominated)).toBe(true);
    expect(looseDominated(notDominated)).toBe(false);
  });
});

describe('foldableFindingIds (§2.3)', () => {
  it('the allowlist is exactly {dimensions-npot, format}', () => {
    expect([...FOLDABLE_RULES].sort()).toEqual(['dimensions-npot', 'format']);
  });

  it('dominated: format + dimensions-npot on loose refs fold; oversize/solid/wasted/crit/folder do NOT', () => {
    const loose = looseRefs(8);
    const findings: Finding[] = [
      shouldAtlas(loose), // folder — never folds (also the driver)
      finding('loose0:format', 'loose0', 'format', 'warn'), // FOLD (loose branch)
      finding('loose1:dimensions-npot', 'loose1', 'dimensions-npot', 'info'), // FOLD (loose branch)
      finding('loose2:dimensions-oversize', 'loose2', 'dimensions-oversize', 'warn'), // not in allowlist
      finding('loose3:solid-fill', 'loose3', 'solid-fill', 'warn'), // not in allowlist
      finding('loose4:wasted-alpha', 'loose4', 'wasted-alpha', 'warn'), // not in allowlist
      finding('loose5:dimensions-npot', 'loose5', 'dimensions-npot', 'crit'), // hard crit guard
    ];
    const ids = foldableFindingIds(report(assetsFor(loose), findings));
    expect([...ids].sort()).toEqual(['loose0:format', 'loose1:dimensions-npot']);
    expect(ids.has('folder:should-atlas')).toBe(false);
    expect(ids.has('loose5:dimensions-npot')).toBe(false); // crit never folds even for a foldable rule
  });

  it('NOT dominated: loose branch is inert, but a redundantSibling format finding still demotes', () => {
    const loose = looseRefs(8);
    const all = [...loose, ...looseRefs(500, 'atlas')]; // 8/508 < 0.5 ⇒ not dominated
    const findings: Finding[] = [
      shouldAtlas(loose),
      finding('loose0:format', 'loose0', 'format', 'warn'), // NOT folded (rec === null, no marker)
      finding('loose1:dimensions-npot', 'loose1', 'dimensions-npot', 'info'), // NOT folded (loose branch inert)
      finding('loose2:format', 'loose2', 'format', 'warn', { params: { redundantSibling: 1 } }), // FOLD (sibling branch)
    ];
    const ids = foldableFindingIds(report(assetsFor(all), findings));
    expect([...ids]).toEqual(['loose2:format']);
  });

  it('a redundantSibling format finding folds even with no should-atlas at all (pure format-variant folder)', () => {
    const findings: Finding[] = [
      finding('a.png:format', 'a.png', 'format', 'warn', { params: { redundantSibling: 1 } }),
      finding('b.png:format', 'b.png', 'format', 'warn'), // no marker ⇒ stays first-class
    ];
    const ids = foldableFindingIds(report(assetsFor(['a.png', 'b.png']), findings));
    expect([...ids]).toEqual(['a.png:format']);
  });

  it('a crit redundantSibling format finding still does NOT fold (hard crit guard beats the sibling branch)', () => {
    const findings: Finding[] = [finding('c.png:format', 'c.png', 'format', 'crit', { params: { redundantSibling: 1 } })];
    const ids = foldableFindingIds(report(assetsFor(['c.png']), findings));
    expect(ids.size).toBe(0);
  });

  it('deterministic: stable Set membership over a fixed report', () => {
    const loose = looseRefs(8);
    const findings: Finding[] = [
      shouldAtlas(loose),
      finding('loose0:format', 'loose0', 'format', 'warn'),
      finding('loose1:dimensions-npot', 'loose1', 'dimensions-npot', 'info'),
    ];
    const rep = report(assetsFor(loose), findings);
    const a = [...foldableFindingIds(rep)].sort();
    const b = [...foldableFindingIds(rep)].sort();
    expect(a).toEqual(b);
    expect(a).toEqual(['loose0:format', 'loose1:dimensions-npot']);
  });
});
