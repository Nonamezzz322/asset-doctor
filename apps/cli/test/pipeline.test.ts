import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { toJSON } from '@asset-doctor/budget';
import { auditDir } from '../src/pipeline';

const fix = (name: string): string => fileURLToPath(new URL(`../../../fixtures/sample-projects/${name}`, import.meta.url));

describe('auditDir (Node pipeline)', () => {
  it('finds exact-dupes via node:crypto SHA-256, should-atlas, and integrity (no-drift pin)', async () => {
    const { report } = await auditDir(fix('folder-waste'));
    expect(report.assets.length).toBe(11);
    const rules = new Set(report.findings.map((f) => f.rule));
    expect(rules.has('duplicate-exact')).toBe(true); // SHA-256 path works headlessly
    expect(rules.has('should-atlas')).toBe(true);
    expect(rules.has('integrity-missing-image')).toBe(true);
    // browser-only rules never fire in the CLI
    expect(rules.has('format')).toBe(false);
    expect(rules.has('duplicate-similar')).toBe(false);
  });

  it('VRAM totals are pure Σ w×h×4 (internally consistent)', async () => {
    const { report } = await auditDir(fix('single-images'));
    const summed = report.assets.reduce((s, a) => s + a.vramBytes, 0);
    expect(report.totals.vramBytes).toBe(summed);
    // hero.png is 2050×2050 → 2050*2050*4
    expect(report.assets.find((a) => a.assetRef === 'hero.png')!.vramBytes).toBe(2050 * 2050 * 4);
  });

  it('is deterministic: two runs serialize byte-identically', async () => {
    const a = await auditDir(fix('spine-basic'));
    const b = await auditDir(fix('spine-basic'));
    expect(JSON.stringify(toJSON(a.report))).toBe(JSON.stringify(toJSON(b.report)));
  });

  it('exposes per-asset sizes for oversize budgets', async () => {
    const { assetSizes } = await auditDir(fix('single-images'));
    expect(assetSizes['hero.png']).toEqual({ w: 2050, h: 2050 });
  });

  it('surfaces dimension-mismatch on the CLI with NO config (DEFAULT_THRESHOLDS opt-in)', async () => {
    // The fixture's meta.size declares 1024² but the real PNG is 512²; one frame samples past the real
    // edge ⇒ crit. resolveThresholds(undefined) returns DEFAULT_THRESHOLDS whole, so the rule fires headlessly.
    const { report } = await auditDir(fix('dimension-mismatch'));
    const dm = report.findings.find((f) => f.rule === 'dimension-mismatch');
    expect(dm).toBeDefined();
    expect(dm?.severity).toBe('crit');
    expect(dm?.estimate).toBeUndefined(); // correctness finding — never a saving (invariant 5)
    expect(report.totals.potentialDiskSaved).toBe(0); // nothing flows into the disk headline
  });

  it('a budget config that supplies thresholds (omitting dimensionMismatch) suppresses it', async () => {
    // resolveThresholds keeps only the seven enumerated groups when a config's thresholds object is present,
    // so dimensionMismatch (NOT enumerated) drops out and the finding is suppressed — mirrors bleeding.
    const { report } = await auditDir(fix('dimension-mismatch'), {
      version: 1,
      budgets: {},
      thresholds: { occupancy: { warn: 0.8, crit: 0.6 } },
    });
    expect(report.findings.some((f) => f.rule === 'dimension-mismatch')).toBe(false);
  });
});
