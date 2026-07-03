// PURE-decision lock for the cause-aware empty-ledger cards + the "show N clean" wiring fix. apps/web has NO
// React test harness (vitest env=node), so the load-bearing DECISIONS — the empty-ledger CAUSE, the i18n
// key+params per card, the HONEST problem count (crit+warn+info, never ok/clean), and the effectiveSeverityFilter
// that admits `ok` rows — are extracted here and asserted with a fake translator (announce.test.ts discipline).
// The card MARKUP + post-action focus are additive JSX, verified by the manual browser gate noted in the PR.

import { describe, it, expect } from 'vitest';
import { translate, type T } from '@asset-doctor/i18n';
import type { AnalysisReport, AssetMetrics, Finding, Severity } from '@asset-doctor/core';
import { emptyLedgerReason, emptyLedgerCard, effectiveSeverityFilter } from './ledger-empty';
import { buildIndex, countCandidates, selectRows, DEFAULT_SEVERITIES, type SelectOpts, type TriageIndex } from './triage';

// A fake translator that echoes the exact key + params chosen, so we assert the CHOICE not the locale copy.
const fakeT: T = (key, params) => `${key}:${JSON.stringify(params)}`;
// The real EN translator, to prove the chosen key + params render clean, correctly-pluralized copy.
const enT: T = (key, params) => translate('en', key, params);

const tally = (t: Partial<TriageIndex['tally']>): TriageIndex['tally'] => ({ crit: 0, warn: 0, info: 0, ok: 0, ...t });

// ── classification ──────────────────────────────────────────────────────────────────────────────────
describe('emptyLedgerReason — classifies the honest cause of an empty ledger', () => {
  it('rows present ⇒ null (total function, callable every render)', () => {
    expect(emptyLedgerReason(tally({ crit: 3 }), 5, 5, 0, '')).toBeNull();
  });

  it('totalRows===0 & no problems ⇒ clean, carrying cleanAssetCount', () => {
    expect(emptyLedgerReason(tally({}), 0, 0, 128, '')).toEqual({ kind: 'clean', cleanCount: 128 });
  });

  it('HONESTY: totalRows===0 & problems>0 ⇒ filtered, hiddenCount=crit+warn+info EXCLUDING ok (3, not 102)', () => {
    // The announce.ts formula lock: a fake tally with 99 ok must never inflate the hidden problem count.
    expect(emptyLedgerReason(tally({ crit: 2, warn: 1, info: 0, ok: 99 }), 0, 0, 0, '')).toEqual({
      kind: 'filtered',
      hiddenCount: 3,
    });
  });

  it('rowCount===0 & totalRows>0 ⇒ search, with the query trimmed', () => {
    expect(emptyLedgerReason(tally({ warn: 4 }), 0, 4, 0, '  hero_gl  ')).toEqual({ kind: 'search', query: 'hero_gl' });
  });

  it('HONESTY: totalRows===0 & problems>0 & hiddenByType>0 ⇒ type-filtered, carrying the hidden-by-type count', () => {
    // The type filter is the ACTIONABLE cause (clearing it reveals rows) and lives off-screen on #settings,
    // so the card must name it. hiddenCount is the by-type count (5), never the problem tally.
    expect(emptyLedgerReason(tally({ crit: 2, warn: 1, info: 0, ok: 9 }), 0, 0, 0, '', 5)).toEqual({
      kind: 'type-filtered',
      hiddenCount: 5,
    });
  });

  it('type filter is attributed over severity when BOTH hid everything (it is the actionable, off-screen one)', () => {
    expect(emptyLedgerReason(tally({ crit: 3 }), 0, 0, 0, '', 3)).toEqual({ kind: 'type-filtered', hiddenCount: 3 });
  });

  it('BYTE-IDENTITY: the pre-existing 5-arg call (hiddenByType defaults to 0) still ⇒ severity-filtered', () => {
    // No 6th arg ⇒ hiddenByType=0 ⇒ today's behavior, unchanged. Explicit 0 is identical.
    expect(emptyLedgerReason(tally({ crit: 2, warn: 1 }), 0, 0, 0, '')).toEqual({ kind: 'filtered', hiddenCount: 3 });
    expect(emptyLedgerReason(tally({ crit: 2, warn: 1 }), 0, 0, 0, '', 0)).toEqual({ kind: 'filtered', hiddenCount: 3 });
  });

  it('clean wins even if hiddenByType>0 (no problems ⇒ nothing the type filter could reveal)', () => {
    expect(emptyLedgerReason(tally({ ok: 5 }), 0, 0, 5, '', 4)).toEqual({ kind: 'clean', cleanCount: 5 });
  });
});

// ── card model (fakeT: assert the key+params CHOICE) ────────────────────────────────────────────────
describe('emptyLedgerCard — key+params per kind, chosen purely', () => {
  it('clean: title + count body + reuses triage.showClean, hideCounts', () => {
    const c = emptyLedgerCard({ kind: 'clean', cleanCount: 128 }, fakeT);
    expect(c.title).toBe('triage.empty.clean.title:undefined');
    expect(c.body).toBe('triage.empty.clean.body:{"n":128}');
    expect(c.action).toBe('triage.showClean:{"n":128}'); // SAME key as the toolbar toggle
    expect(c.hideCounts).toBe(true);
  });

  it('clean with 0 clean assets ⇒ NO action button (defensive)', () => {
    const c = emptyLedgerCard({ kind: 'clean', cleanCount: 0 }, fakeT);
    expect(c.action).toBeUndefined();
    expect(c.hideCounts).toBe(true);
  });

  it('filtered: title + hidden-count body + reset action, hideCounts', () => {
    const c = emptyLedgerCard({ kind: 'filtered', hiddenCount: 37 }, fakeT);
    expect(c.title).toBe('triage.empty.filtered.title:undefined');
    expect(c.body).toBe('triage.empty.filtered.body:{"n":37}');
    expect(c.action).toBe('triage.empty.filtered.action:undefined');
    expect(c.hideCounts).toBe(true);
  });

  it('search: title carries the query, clear action, and KEEPS the counts line', () => {
    const c = emptyLedgerCard({ kind: 'search', query: 'hero.png' }, fakeT);
    expect(c.title).toBe('triage.empty.search.title:{"q":"hero.png"}');
    expect(c.body).toBeUndefined();
    expect(c.action).toBe('triage.empty.search.action:undefined');
    expect(c.hideCounts).toBe(false); // "showing 0 of M" is informative on a search miss
  });

  it('type-filtered: title + hidden-count body + reuses triage.typeHidden.clear, hideCounts', () => {
    const c = emptyLedgerCard({ kind: 'type-filtered', hiddenCount: 12 }, fakeT);
    expect(c.title).toBe('triage.empty.typeFiltered.title:undefined');
    expect(c.body).toBe('triage.empty.typeFiltered.body:{"n":12}');
    expect(c.action).toBe('triage.typeHidden.clear:undefined'); // SAME key the ledger H-line clear uses
    expect(c.hideCounts).toBe(true);
  });
});

// ── EN render (enT: prove the copy pluralizes + fills placeholders) ─────────────────────────────────
describe('emptyLedgerCard — EN renders clean, correctly-pluralized copy', () => {
  it('clean singular n=1 vs plural n=5', () => {
    const one = emptyLedgerCard({ kind: 'clean', cleanCount: 1 }, enT);
    expect(one.body).toMatch(/The 1 analyzed asset passed/);
    expect(one.body).not.toContain('{');
    expect(one.action).toMatch(/show 1 clean asset/);
    const many = emptyLedgerCard({ kind: 'clean', cleanCount: 5 }, enT);
    expect(many.body).toMatch(/All 5 analyzed assets passed/);
    expect(many.body).not.toContain('{');
  });

  it('filtered singular n=1 vs plural n=5', () => {
    expect(emptyLedgerCard({ kind: 'filtered', hiddenCount: 1 }, enT).body).toMatch(/1 problem is hidden/);
    const many = emptyLedgerCard({ kind: 'filtered', hiddenCount: 5 }, enT);
    expect(many.body).toMatch(/5 problems are hidden/);
    expect(many.body).not.toContain('{');
  });

  it('search title contains the query verbatim, no leftover braces', () => {
    const c = emptyLedgerCard({ kind: 'search', query: 'hero_glow' }, enT);
    expect(c.title).toContain('hero_glow');
    expect(c.title).not.toContain('{');
  });

  it('type-filtered singular n=1 vs plural n=5, and the clear action fills no braces', () => {
    const one = emptyLedgerCard({ kind: 'type-filtered', hiddenCount: 1 }, enT);
    expect(one.body).toMatch(/1 problem is hidden by your finding-type filter/);
    expect(one.body).not.toContain('{');
    const many = emptyLedgerCard({ kind: 'type-filtered', hiddenCount: 5 }, enT);
    expect(many.body).toMatch(/5 problems are hidden by your finding-type filter/);
    expect(many.body).not.toContain('{');
    expect(one.action).toBe('Show all finding types');
  });
});

// ── effectiveSeverityFilter (the §1.3 wiring fix, at the unit level) ────────────────────────────────
describe('effectiveSeverityFilter — admits `ok` only while showClean is on', () => {
  it('showClean off ⇒ input severities unchanged (no ok)', () => {
    const src = new Set<Severity>(['crit', 'warn', 'info']);
    const out = effectiveSeverityFilter(src, false);
    expect([...out].sort()).toEqual(['crit', 'info', 'warn']);
  });

  it('showClean on ⇒ adds ok', () => {
    const out = effectiveSeverityFilter(new Set<Severity>(['crit', 'warn', 'info']), true);
    expect(out.has('ok')).toBe(true);
  });

  it('never mutates the input and returns a FRESH set', () => {
    const src = new Set<Severity>(['crit']);
    const out = effectiveSeverityFilter(src, true);
    expect(src.has('ok')).toBe(false); // input untouched
    expect(out).not.toBe(src); // fresh identity
  });

  it('idempotent when ok is already present', () => {
    const out = effectiveSeverityFilter(new Set<Severity>(['crit', 'ok']), true);
    expect([...out].sort()).toEqual(['crit', 'ok']);
  });
});

// ── §1.3 REGRESSION LOCK: "show N clean" was a dead control at HEAD's wiring ─────────────────────────
// Uses the REAL buildIndex/selectRows/countCandidates with App's EXACT wiring, so it fails on the pre-fix
// wiring (severityFilter WITHOUT `ok`) and passes only once effectiveSeverityFilter feeds selectOpts.
const asset = (assetRef: string, extra: Partial<AssetMetrics> = {}): AssetMetrics => ({
  assetRef,
  diskBytes: 0,
  vramBytes: 0,
  vramBytesMipmapped: 0,
  ...extra,
});
const finding = (id: string, assetRef: string, severity: Severity, extra: Partial<Finding> = {}): Finding => ({
  id,
  rule: 'occupancy' as Finding['rule'],
  severity,
  assetRef,
  title: id,
  detail: '',
  ...extra,
});
const report = (assets: AssetMetrics[], findings: Finding[]): AnalysisReport => ({
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
  thresholds: {} as AnalysisReport['thresholds'],
});

describe('showClean is a REAL control once effectiveSeverityFilter feeds selectOpts (§1.3 regression lock)', () => {
  // Two clean assets (finding-less) + one dirty; App's canonical severity default = {crit,warn,info}.
  const idx = buildIndex(report([asset('dirty.png'), asset('a.png'), asset('b.png')], [finding('f1', 'dirty.png', 'crit')]));
  expect(idx.cleanAssetCount).toBe(2);
  const base = (showClean: boolean): SelectOpts => ({
    sort: 'severity',
    search: '',
    severityFilter: effectiveSeverityFilter(new Set<Severity>(DEFAULT_SEVERITIES), showClean), // App's exact wiring
    problemsOnly: !showClean, // App forces problemsOnly off when showClean is on
    includeClean: showClean,
    groupByFolder: false,
  });

  it('toggling showClean surfaces EXACTLY cleanAssetCount extra rows (not 0, the dead-control bug)', () => {
    const off = selectRows(idx, base(false)).length;
    const on = selectRows(idx, base(true)).length;
    expect(on - off).toBe(idx.cleanAssetCount); // == 2; was 0 under the pre-fix wiring (no `ok` in the set)
  });

  it('totalRows (countCandidates) grows by the same N under the same opts', () => {
    const off = countCandidates(idx, base(false));
    const on = countCandidates(idx, base(true));
    expect(on - off).toBe(idx.cleanAssetCount);
  });

  it('the revealed rows are the synthesized clean `ok` rows for exactly the clean assets', () => {
    const revealed = selectRows(idx, base(true)).filter((r) => r.clean);
    expect(revealed.map((r) => r.assetRef).sort()).toEqual(['a.png', 'b.png']);
  });
});
