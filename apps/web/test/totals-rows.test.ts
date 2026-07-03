import { describe, expect, it } from 'vitest';
import type { AnalysisReport } from '@asset-doctor/core';
import { buildTotalsRows, type TotalRow } from '../src/lib/totals-rows';

// ── stubs ───────────────────────────────────────────────────────────────────────────────────────────
// Stub `t` echoes the key — this pins the EXACT i18n keys requested (the i18n-contract guard). Stub
// fmtBytes is a deterministic marker formatter so values are assertable without coupling to the real
// formatter's KB/MB rounding.
const echoT = (k: string): string => k;
const tag = (n: number): string => `<${n}>`;

type Totals = NonNullable<AnalysisReport['totals']>;
const totals = (extra: Partial<Totals> = {}): Totals => ({
  diskBytes: 1000,
  vramBytes: 0,
  vramBytesMipmapped: 0,
  loadedVramBytes: 4000,
  loadedVramBytesMipmapped: 0,
  potentialDiskSaved: 250,
  ...extra,
});

const byKey = (rows: TotalRow[], key: string): TotalRow | undefined => rows.find((r) => r.key === key);

describe('buildTotalsRows', () => {
  it('returns [] for undefined totals', () => {
    expect(buildTotalsRows(undefined, echoT, tag)).toEqual([]);
  });

  it('no probe → 3 rows in order disk/declared/saveable', () => {
    const rows = buildTotalsRows(totals(), echoT, tag);
    expect(rows.map((r) => r.key)).toEqual(['disk', 'declared', 'saveable']);
  });

  it('declared row uses readout.declared (NOT metric.vram) — the honesty correction', () => {
    const rows = buildTotalsRows(totals(), echoT, tag);
    const declared = byKey(rows, 'declared')!;
    expect(declared.label).toBe('readout.declared');
    expect(declared.label).not.toBe('metric.vram');
    // declared value is loadedVramBytes, formatted — not a delta, not the disk number.
    expect(declared.value).toBe('<4000>');
  });

  it('measured cell is absent without a probe', () => {
    const rows = buildTotalsRows(totals(), echoT, tag);
    expect(byKey(rows, 'measured')).toBeUndefined();
  });

  it('with probe → 4 rows; measured inserted at index 2', () => {
    const rows = buildTotalsRows(totals({ probe: { drawCalls: 5, vramBytes: 9000, atlasesProbed: 2, declaredVramBytes: 7000 } }), echoT, tag);
    expect(rows.map((r) => r.key)).toEqual(['disk', 'declared', 'measured', 'saveable']);
    expect(rows[2].key).toBe('measured');
  });

  it('measured value is probe.vramBytes (never a delta) + the aggregate-scope tooltip title + N-atlases sub', () => {
    const rows = buildTotalsRows(totals({ probe: { drawCalls: 5, vramBytes: 9000, atlasesProbed: 2, declaredVramBytes: 7000 } }), echoT, tag);
    const measured = byKey(rows, 'measured')!;
    expect(measured.label).toBe('metric.vramMeasured');
    expect(measured.value).toBe('<9000>'); // straight fmtBytes(probe.vramBytes)
    // R3: the aggregate chip discloses its scope — the tooltip is the aggregate-scoped key (NOT the
    // per-atlas readout.measuredTooltip), and the sub carries the scope-denominator key.
    expect(measured.title).toBe('readout.measuredAggregateTooltip');
    expect(measured.sub).toBe('readout.measuredScope');
    // measured must NOT be any savings delta — distinct from saveable and from the declared/measured gap.
    const saveable = byKey(rows, 'saveable')!;
    expect(measured.value).not.toBe(saveable.value);
    expect(measured.value).not.toBe(tag(9000 - 4000)); // not declared→measured delta
  });

  it('R3: measured sub + tooltip carry n=atlasesProbed and declared=declaredVramBytes (like-for-like basis)', () => {
    // A param-capturing translator (the echo stub drops params) pins that the scope denominator and the
    // like-for-like declared basis are threaded through — not fabricated, not the whole-folder headline.
    const capT = (k: string, p?: Record<string, string | number>): string => (p ? `${k}|${JSON.stringify(p)}` : k);
    const rows = buildTotalsRows(totals({ probe: { drawCalls: 5, vramBytes: 9000, atlasesProbed: 3, declaredVramBytes: 4500 } }), capT, tag);
    const measured = byKey(rows, 'measured')!;
    expect(measured.sub).toBe(`readout.measuredScope|${JSON.stringify({ n: 3 })}`);
    expect(measured.title).toBe(`readout.measuredAggregateTooltip|${JSON.stringify({ n: 3, declared: 4500 })}`);
  });

  it('saveable row: accent === true, label metric.saveable, value carries · N%', () => {
    const rows = buildTotalsRows(totals({ diskBytes: 1000, potentialDiskSaved: 250 }), echoT, tag);
    const saveable = byKey(rows, 'saveable')!;
    expect(saveable.accent).toBe(true);
    expect(saveable.label).toBe('metric.saveable');
    expect(saveable.value).toBe('<250> · 25%');
  });

  it('savedPct: diskBytes=0 → 0% (guarded, no NaN), shows "<0> · 0%"', () => {
    const rows = buildTotalsRows(totals({ diskBytes: 0, potentialDiskSaved: 0 }), echoT, tag);
    expect(byKey(rows, 'saveable')!.value).toBe('<0> · 0%');
  });

  it('savedPct rounds: saved=333, disk=1000 → 33%', () => {
    const rows = buildTotalsRows(totals({ diskBytes: 1000, potentialDiskSaved: 333 }), echoT, tag);
    expect(byKey(rows, 'saveable')!.value).toBe('<333> · 33%');
  });

  it('disk row uses metric.disk with fmtBytes(diskBytes)', () => {
    const rows = buildTotalsRows(totals({ diskBytes: 1000 }), echoT, tag);
    const disk = byKey(rows, 'disk')!;
    expect(disk.label).toBe('metric.disk');
    expect(disk.value).toBe('<1000>');
  });

  it('pins the EXACT i18n keys (stub-t echo) — disk/readout.declared/metric.vramMeasured/metric.saveable', () => {
    const rows = buildTotalsRows(totals({ probe: { drawCalls: 1, vramBytes: 9000, atlasesProbed: 1, declaredVramBytes: 7000 } }), echoT, tag);
    expect(rows.map((r) => r.label)).toEqual(['metric.disk', 'readout.declared', 'metric.vramMeasured', 'metric.saveable']);
  });
});
