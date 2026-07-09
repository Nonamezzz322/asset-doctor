import { describe, expect, it } from 'vitest';
import type { Finding, Severity } from '@asset-doctor/core';
import {
  DIFF_METRIC_KEYS,
  diffAudits,
  diffToJSON,
  diffToSummaryMarkdown,
  findingKey,
  hasRegression,
  renderDiff,
} from '../src/diff';
import type { AuditSnapshot, MetricDelta } from '../src/diff';

/** Minimal finding literal — only id/severity/rule/assetRef/title matter to diff. */
const finding = (id: string, severity: Severity, over: Partial<Finding> = {}): Finding => ({
  id,
  rule: 'occupancy',
  severity,
  assetRef: 'a.png',
  title: `t:${id}`,
  detail: '',
  ...over,
});

/** Hand-built snapshot; only totals.* / findings / assets.length are read by diff. */
const snap = (o: {
  disk?: number;
  vram?: number;
  loadedVram?: number;
  saved?: number;
  assetCount?: number;
  findings?: Finding[];
}): AuditSnapshot => ({
  totals: {
    diskBytes: o.disk ?? 0,
    vramBytes: o.vram ?? 0,
    vramBytesMipmapped: 0,
    loadedVramBytes: o.loadedVram ?? 0,
    loadedVramBytesMipmapped: 0,
    potentialDiskSaved: o.saved ?? 0,
  },
  assets: Array.from({ length: o.assetCount ?? 0 }, (_, i) => ({
    assetRef: `a${i}.png`,
    diskBytes: 0,
    vramBytes: 0,
    vramBytesMipmapped: 0,
  })),
  findings: o.findings ?? [],
});

const metric = (d: ReturnType<typeof diffAudits>, key: string): MetricDelta =>
  d.metrics.find((m) => m.key === key)!;

/** A diff whose ONLY difference is its finding sets — metrics all flat. */
const findingDiff = (before: Finding[], after: Finding[]) =>
  diffAudits(snap({ findings: before }), snap({ findings: after }));

describe('diff — metric deltas (measured, never fabricated)', () => {
  it('computes after−before with pct and direction', () => {
    const d = diffAudits(
      snap({ disk: 100, vram: 200, assetCount: 3 }),
      snap({ disk: 150, vram: 100, assetCount: 5 }),
    );
    const disk = metric(d, 'totals.diskBytes');
    expect(disk).toMatchObject({ before: 100, after: 150, delta: 50, pct: 50, direction: 'up' });

    const vram = metric(d, 'totals.vramBytes');
    expect(vram).toMatchObject({ before: 200, after: 100, delta: -100, pct: -50, direction: 'down' });

    // drawCallsLowerBound is derived from assets.length — works on a snapshot verbatim.
    const draws = metric(d, 'drawCallsLowerBound');
    expect(draws).toMatchObject({ before: 3, after: 5, delta: 2, direction: 'up' });

    // untouched metric is flat
    expect(metric(d, 'totals.potentialDiskSaved')).toMatchObject({ delta: 0, direction: 'flat' });
  });

  it('omits pct when before === 0 (no ∞, no fabricated base)', () => {
    const grew = diffAudits(snap({ disk: 0 }), snap({ disk: 5 }));
    const g = metric(grew, 'totals.diskBytes');
    expect(g.delta).toBe(5);
    expect(g.pct).toBeUndefined();
    expect(g.direction).toBe('up');

    const zero = diffAudits(snap({ disk: 0 }), snap({ disk: 0 }));
    const z = metric(zero, 'totals.diskBytes');
    expect(z).toMatchObject({ delta: 0, direction: 'flat' });
    expect(z.pct).toBeUndefined();
  });

  it('keeps disk and every VRAM metric as SEPARATE rows with their own unit (invariant 5)', () => {
    const d = diffAudits(snap({ disk: 10, vram: 20, loadedVram: 30 }), snap({ disk: 11, vram: 22, loadedVram: 33 }));
    expect(metric(d, 'totals.diskBytes').unit).toBe('bytes');
    expect(metric(d, 'totals.vramBytes').unit).toBe('bytes');
    expect(metric(d, 'totals.loadedVramBytes').unit).toBe('bytes');
    expect(metric(d, 'findings.crit').unit).toBe('count');
    // three DISTINCT rows — disk is never folded into VRAM
    const keys = d.metrics.map((m) => m.key);
    expect(keys).toEqual([...DIFF_METRIC_KEYS]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('diffToJSON has no combined disk+VRAM footprint key', () => {
    const d = diffAudits(snap({ disk: 10, vram: 20 }), snap({ disk: 20, vram: 40 }));
    const json = diffToJSON(d) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(['counts', 'findings', 'metrics', 'version']);
    const flat = JSON.stringify(json).toLowerCase();
    expect(flat).not.toContain('footprint');
    expect(flat).not.toContain('totalbytes');
    expect(flat).not.toContain('combined');
  });
});

describe('diff — findings partition by stable id', () => {
  it('findingKey is the finding id', () => {
    expect(findingKey(finding('x:oversize', 'crit'))).toBe('x:oversize');
  });

  it('added = id only in after', () => {
    const d = findingDiff([finding('a:occupancy', 'warn')], [finding('a:occupancy', 'warn'), finding('b:format', 'crit')]);
    expect(d.added.map((f) => f.key)).toEqual(['b:format']);
    expect(d.resolved).toEqual([]);
    expect(d.changed).toEqual([]);
    expect(d.counts.addedCrit).toBe(1);
  });

  it('resolved = id only in before', () => {
    const d = findingDiff([finding('a:occupancy', 'warn'), finding('b:format', 'crit')], [finding('a:occupancy', 'warn')]);
    expect(d.resolved.map((f) => f.key)).toEqual(['b:format']);
    expect(d.added).toEqual([]);
    expect(d.counts.resolved).toBe(1);
  });

  it('severity warn→crit is CHANGED-worsened, absent from added AND resolved', () => {
    const d = findingDiff([finding('a:occupancy', 'warn')], [finding('a:occupancy', 'crit')]);
    expect(d.added).toEqual([]);
    expect(d.resolved).toEqual([]);
    expect(d.changed).toEqual([
      { key: 'a:occupancy', rule: 'occupancy', assetRef: 'a.png', from: 'warn', to: 'crit', worsened: true, title: 't:a:occupancy' },
    ]);
    expect(d.counts.worsenedToCrit).toBe(1);
    expect(d.counts.worsenedToWarnOrCrit).toBe(1);
  });

  it('severity crit→warn is CHANGED-not-worsened (an improvement)', () => {
    const d = findingDiff([finding('a:occupancy', 'crit')], [finding('a:occupancy', 'warn')]);
    expect(d.changed[0]).toMatchObject({ from: 'crit', to: 'warn', worsened: false });
    expect(d.counts.worsenedToCrit).toBe(0);
    expect(hasRegression(d, 'any')).toBe(false);
  });

  it('same id, same severity → appears in no partition', () => {
    const d = findingDiff([finding('a:occupancy', 'warn')], [finding('a:occupancy', 'warn', { title: 'reworded' })]);
    expect(d.added).toEqual([]);
    expect(d.resolved).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  it('a finding is in AT MOST one partition (no added+resolved double-count on severity change)', () => {
    const d = findingDiff([finding('a:occupancy', 'info')], [finding('a:occupancy', 'crit')]);
    const total = d.added.length + d.resolved.length + d.changed.length;
    expect(total).toBe(1);
    expect(d.changed.length).toBe(1);
  });
});

describe('diff — hasRegression truth table (findings-only, threshold-free)', () => {
  const noneDiff = findingDiff([], []);
  const addedCrit = findingDiff([], [finding('n:format', 'crit')]);
  const addedWarn = findingDiff([], [finding('n:occupancy', 'warn')]);
  const addedInfo = findingDiff([], [finding('n:npot', 'info')]);
  const worsenToCrit = findingDiff([finding('a:occupancy', 'warn')], [finding('a:occupancy', 'crit')]);
  const worsenToWarn = findingDiff([finding('a:occupancy', 'info')], [finding('a:occupancy', 'warn')]);
  const worsenToInfo = findingDiff([finding('a:occupancy', 'ok')], [finding('a:occupancy', 'info')]);
  const resolvedOnly = findingDiff([finding('a:format', 'crit')], []);
  const improved = findingDiff([finding('a:occupancy', 'crit')], [finding('a:occupancy', 'warn')]);

  const row = (label: string, d: ReturnType<typeof diffAudits>, crit: boolean, warn: boolean, any: boolean): void => {
    it(label, () => {
      expect(hasRegression(d, 'crit')).toBe(crit);
      expect(hasRegression(d, 'warn')).toBe(warn);
      expect(hasRegression(d, 'any')).toBe(any);
    });
  };

  row('no change → no regression', noneDiff, false, false, false);
  row('added crit', addedCrit, true, true, true);
  row('added warn', addedWarn, false, true, true);
  row('added info', addedInfo, false, false, true);
  row('worsened to crit', worsenToCrit, true, true, true);
  row('worsened to warn', worsenToWarn, false, true, true);
  row('worsened to info', worsenToInfo, false, false, true);
  row('resolved only → never a regression', resolvedOnly, false, false, false);
  row('severity lowered → never a regression', improved, false, false, false);
});

describe('diff — determinism', () => {
  it('sorts added/resolved/changed and is stable across runs', () => {
    const before = [finding('z:occupancy', 'warn'), finding('a:occupancy', 'crit'), finding('m:occupancy', 'crit')];
    const after = [
      finding('q:format', 'crit'),
      finding('c:occupancy', 'warn'),
      finding('b:format', 'crit'),
      finding('a:occupancy', 'info'), // worsen-reverse (crit→info): changed, not added/resolved
    ];
    const d1 = diffAudits(snap({ findings: before }), snap({ findings: after }));
    const d2 = diffAudits(snap({ findings: before }), snap({ findings: after }));
    // added sorted by severity desc, then id asc
    expect(d1.added.map((f) => f.key)).toEqual(['b:format', 'q:format', 'c:occupancy']);
    // resolved sorted the same way (z warn last)
    expect(d1.resolved.map((f) => f.key)).toEqual(['m:occupancy', 'z:occupancy']);
    // 'a' present both sides with a severity change → changed only
    expect(d1.changed.map((c) => c.key)).toEqual(['a:occupancy']);
    // fully deterministic JSON
    expect(JSON.stringify(diffToJSON(d1))).toBe(JSON.stringify(diffToJSON(d2)));
  });
});

describe('diff — serializers', () => {
  const d = diffAudits(
    snap({ disk: 1_000_000, loadedVram: 2_000_000, findings: [finding('a:occupancy', 'warn')] }),
    snap({ disk: 1_500_000, loadedVram: 1_000_000, findings: [finding('b:format', 'crit')] }),
  );

  it('renderDiff shows before→after, separate disk/VRAM rows, and finding sections; no combined number', () => {
    const txt = renderDiff(d, { color: false });
    expect(txt).toContain('→'); // before → after arrow
    expect(txt).toContain('disk size'); // disk row present
    expect(txt).toContain('VRAM (loaded)'); // separate VRAM row present
    expect(txt).toMatch(/\+1 added/);
    expect(txt).toMatch(/-1 resolved/);
    expect(txt).not.toContain('\x1b['); // plain when color off
    expect(renderDiff(d, { color: true })).toContain('\x1b['); // ANSI when on
  });

  it('diffToSummaryMarkdown emits a metric table with distinct disk/VRAM rows', () => {
    const md = diffToSummaryMarkdown(d, { title: 'base → head' });
    expect(md).toContain('| Metric |');
    expect(md).toContain('`totals.diskBytes`');
    expect(md).toContain('`totals.loadedVramBytes`');
    expect(md).toContain('added');
    expect(md).toContain('resolved');
  });
});

describe('diff — identical snapshots', () => {
  it('yields all-flat metrics and empty finding sets', () => {
    const s = snap({ disk: 100, vram: 200, loadedVram: 50, findings: [finding('a:occupancy', 'warn')] });
    const d = diffAudits(s, s);
    expect(d.metrics.every((m) => m.direction === 'flat' && m.delta === 0)).toBe(true);
    expect(d.added).toEqual([]);
    expect(d.resolved).toEqual([]);
    expect(d.changed).toEqual([]);
    expect(hasRegression(d, 'any')).toBe(false);
  });
});
