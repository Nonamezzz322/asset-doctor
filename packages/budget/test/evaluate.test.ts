import { describe, expect, it } from 'vitest';
import { evaluateGate, parseBudgetConfig } from '../src/index';
import { REPORT } from './fixture';

const cfg = (raw: object) => parseBudgetConfig({ version: 1, ...raw });
const status = (g: ReturnType<typeof evaluateGate>, key: string, check = 'max') =>
  g.entries.find((e) => e.key === key && e.check === check)?.status;

describe('evaluateGate — global', () => {
  it('flags an error when value exceeds an error.max', () => {
    const g = evaluateGate(REPORT, cfg({ budgets: { 'totals.diskBytes': { error: { max: '100B' } } } }));
    expect(status(g, 'totals.diskBytes')).toBe('error');
    expect(g.worst).toBe('error');
    expect(g.errorCount).toBe(1);
  });

  it('passes under budget and separates warn from error', () => {
    const g = evaluateGate(REPORT, cfg({ budgets: { 'findings.crit': { warn: { max: 0 }, error: { max: 5 } } } }));
    // value 1: breaches warn(max 0) but is under error(max 5) → two entries, distinct statuses
    expect(g.entries.find((e) => e.key === 'findings.crit' && e.level === 'warn')?.status).toBe('warn');
    expect(g.entries.find((e) => e.key === 'findings.crit' && e.level === 'error')?.status).toBe('pass');
    expect(g.worst).toBe('warn');
    expect(g.errorCount).toBe(0);
    expect(g.warnCount).toBe(1);
  });

  it('honors min direction and "off"', () => {
    const g = evaluateGate(REPORT, cfg({ budgets: { 'totals.loadedVramBytes': 'off', 'findings.total': { error: { min: 10 } } } }));
    expect(status(g, 'findings.total', 'min')).toBe('error'); // 3 < 10
    expect(g.entries.some((e) => e.key === 'totals.loadedVramBytes')).toBe(false); // off → skipped
  });

  it('maxDeltaPct fires only with a baseline that grew past the cap', () => {
    const base = { ...REPORT, totals: { ...REPORT.totals, diskBytes: 100 } };
    const c = cfg({ budgets: { 'totals.diskBytes': { error: { maxDeltaPct: 50 } } } });
    expect(status(evaluateGate(REPORT, c, { baseline: base }), 'totals.diskBytes', 'maxDeltaPct')).toBe('error'); // 100→350 = +250%
    expect(status(evaluateGate(REPORT, c), 'totals.diskBytes', 'maxDeltaPct')).toBe('pass'); // no baseline → pass (disabled)
  });
});

describe('evaluateGate — per-asset', () => {
  it('first matching override wins; ignore removes assets', () => {
    const g = evaluateGate(
      REPORT,
      cfg({
        budgets: {},
        assets: [
          { match: 'a.png', budgets: { vramBytes: { error: { max: '1MB' } } } }, // 2MB > 1MB → error
          { match: '*.png', budgets: { vramBytes: { error: { max: '10MB' } } } }, // would pass; but a.png matched first
        ],
        ignore: ['b.png'],
      }),
    );
    const aEntry = g.entries.find((e) => e.assetRef === 'a.png');
    expect(aEntry?.status).toBe('error');
    expect(g.entries.some((e) => e.assetRef === 'b.png')).toBe(false); // ignored
  });

  it('oversizePx uses provided sizes; occupancy is skipped on loose images', () => {
    const g = evaluateGate(
      REPORT,
      cfg({ budgets: {}, assets: [{ match: '*.png', budgets: { oversizePx: { error: { max: 2048 } }, occupancy: { warn: { min: 0.5 } } } }] }),
      { assetSizes: { 'a.png': { w: 4096, h: 4096 }, 'b.png': { w: 100, h: 100 } } },
    );
    expect(g.entries.find((e) => e.assetRef === 'a.png' && e.key === 'oversizePx')?.status).toBe('error');
    // a.png/b.png are loose → occupancy N/A → no occupancy entry emitted for them
    expect(g.entries.some((e) => e.key === 'occupancy')).toBe(false);
  });
});
