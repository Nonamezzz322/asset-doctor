import { describe, it, expect } from 'vitest';
import type { AnalysisReport, Finding } from '@asset-doctor/core';
import { diffAudits } from '@asset-doctor/budget';
import { CATALOGS } from '@asset-doctor/i18n';
import {
  buildStored,
  loadHistory,
  saveHistory,
  toSnapshot,
  historyRows,
  HISTORY_KEY_PREFIX,
  HISTORY_MAX_BYTES,
  HISTORY_METRIC_LABEL,
} from './audit-history';

const finding = (id: string, severity: Finding['severity'] = 'warn'): Finding => ({
  id,
  rule: 'occupancy' as Finding['rule'],
  severity,
  assetRef: 'a.png',
  title: `t-${id}`,
  detail: 'long detail that must be stripped from storage',
  fix: 'f',
  params: { x: 1 },
  perRef: [{ ref: 'a.png', value: 1 }],
});

const report = (over: Partial<AnalysisReport> = {}): AnalysisReport => ({
  assets: [{ assetRef: 'a.png', diskBytes: 1000, vramBytes: 4096, vramBytesMipmapped: 5462, occupancy: 0.5 }],
  findings: [finding('a.png:occupancy')],
  totals: { diskBytes: 1000, vramBytes: 4096, vramBytesMipmapped: 5462, potentialDiskSaved: 0, loadedVramBytes: 4096, loadedVramBytesMipmapped: 5462, loadedTextures: 1 },
  thresholds: {} as AnalysisReport['thresholds'],
  ...over,
});

function fakeStore(): { store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    store: {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    },
  };
}

describe('audit-history — store/load the per-folder-name snapshot (fail-closed, size-capped)', () => {
  it('round-trips via buildStored → save → load; presentation payloads are STRIPPED from storage', () => {
    const { store, map } = fakeStore();
    const stored = buildStored('game', 1700000000000, report());
    expect(saveHistory(stored, store)).toBe(true);
    const raw = map.get(HISTORY_KEY_PREFIX + 'game')!;
    expect(raw).not.toContain('long detail'); // detail stripped
    expect(raw).not.toContain('perRef'); // presentation breakdown stripped
    const back = loadHistory('game', store)!;
    expect(back.at).toBe(1700000000000);
    expect(back.findings).toEqual([{ id: 'a.png:occupancy', rule: 'occupancy', assetRef: 'a.png', severity: 'warn', title: 't-a.png:occupancy' }]);
  });

  it('fail-closed load: garbage / wrong version / mistyped finding ⇒ null', () => {
    const { store, map } = fakeStore();
    map.set(HISTORY_KEY_PREFIX + 'x', 'not json');
    expect(loadHistory('x', store)).toBeNull();
    map.set(HISTORY_KEY_PREFIX + 'x', JSON.stringify({ v: 2 }));
    expect(loadHistory('x', store)).toBeNull();
    const bad = buildStored('x', 1, report()) as unknown as { findings: unknown[] };
    bad.findings = [{ id: 1 }];
    map.set(HISTORY_KEY_PREFIX + 'x', JSON.stringify(bad));
    expect(loadHistory('x', store)).toBeNull();
    expect(loadHistory('missing', store)).toBeNull();
  });

  it('size cap: an over-budget snapshot is NOT stored (never truncated), previous stays intact', () => {
    const { store, map } = fakeStore();
    saveHistory(buildStored('g', 1, report()), store);
    const before = map.get(HISTORY_KEY_PREFIX + 'g');
    const huge = buildStored('g', 2, report({ findings: Array.from({ length: 20000 }, (_, i) => finding(`f${i}-${'x'.repeat(100)}`)) }));
    expect(JSON.stringify(huge).length).toBeGreaterThan(HISTORY_MAX_BYTES);
    expect(saveHistory(huge, store)).toBe(false);
    expect(map.get(HISTORY_KEY_PREFIX + 'g')).toBe(before); // untouched
  });

  it('toSnapshot feeds diffAudits: a resolved finding + a disk delta come out measured', () => {
    const prev = buildStored('g', 1, report({ findings: [finding('a.png:occupancy'), finding('b.png:format')] }));
    const now = report({
      findings: [finding('a.png:occupancy')],
      totals: { ...report().totals, diskBytes: 500 },
    });
    const diff = diffAudits(toSnapshot(prev), now);
    expect(diff.counts.resolved).toBe(1);
    expect(diff.counts.added).toBe(0);
    const disk = diff.metrics.find((m) => m.key === 'totals.diskBytes')!;
    expect(disk.delta).toBe(-500);
  });
});

describe('historyRows — headline metrics, non-flat only; dynamic labels drift-guarded', () => {
  it('flat metrics are dropped; findings.* deltas are NEVER rows (the counts line owns them)', () => {
    const prev = buildStored('g', 1, report({ findings: [finding('a.png:occupancy'), finding('b.png:format')] }));
    const now = report({ totals: { ...report().totals, diskBytes: 500 } });
    const rows = historyRows(diffAudits(toSnapshot(prev), now));
    expect(rows.map((r) => r.key)).toEqual(['totals.diskBytes']); // vram flat ⇒ dropped; findings.* excluded
    expect(rows[0]).toMatchObject({ labelKey: 'history.metric.disk', bytes: true, before: 1000, after: 500, delta: -500 });
  });

  it('every HISTORY_METRIC_LABEL key exists in en (the JSX reads t(r.labelKey) — a bare variable)', () => {
    for (const key of Object.values(HISTORY_METRIC_LABEL)) {
      expect(CATALOGS.en[key], `${key} must exist in en.json`).toBeDefined();
    }
  });
});
