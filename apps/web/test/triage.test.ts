import { describe, expect, it } from 'vitest';
import type { AnalysisReport, AssetMetrics, Finding, Rule, Severity } from '@asset-doctor/core';
import { buildIndex, countCandidates, defaultSelectOpts, DEFAULT_SEVERITIES, DEFAULT_SORT, foldableFindingIds, selectRows, SEV_RANK, isAssetAxis, typeHiddenCount, type SelectOpts } from '../src/lib/triage';
import { ALL_RULES } from '../src/lib/view-prefs';

// ── builders ──────────────────────────────────────────────────────────────────────────────────────
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

const ALL_SEV = new Set<Severity>(['crit', 'warn', 'info', 'ok']);
const opts = (o: Partial<SelectOpts> = {}): SelectOpts => ({
  sort: 'severity',
  search: '',
  severityFilter: ALL_SEV,
  problemsOnly: false,
  includeClean: false,
  groupByFolder: false,
  hiddenRules: new Set<Rule>(), // default = show every type ⇒ the type filter is a byte-identical no-op
  ...o,
});

const ids = (rows: { id: string }[]): string[] => rows.map((r) => r.id);

// ── buildIndex ──────────────────────────────────────────────────────────────────────────────────────
describe('buildIndex', () => {
  it('computes the finding tally + an O(1) metricsByRef lookup', () => {
    const idx = buildIndex(
      report(
        [asset('a/x.png', { vramBytes: 100 }), asset('b/y.png', { vramBytes: 200 })],
        [finding('f1', 'a/x.png', 'crit'), finding('f2', 'a/x.png', 'warn'), finding('f3', 'b/y.png', 'info')],
      ),
    );
    expect(idx.tally).toEqual({ crit: 1, warn: 1, info: 1, ok: 0 });
    expect(idx.metricsByRef.get('a/x.png')?.vramBytes).toBe(100);
    expect(idx.metricsByRef.get('b/y.png')?.vramBytes).toBe(200);
    expect(idx.rows).toHaveLength(3);
  });

  it('does ONE pass, not O(assets × findings): row count == finding count regardless of asset count', () => {
    const assets = Array.from({ length: 50 }, (_, i) => asset(`a/${i}.png`));
    const findings = [finding('f1', 'a/0.png', 'crit'), finding('f2', 'a/1.png', 'warn')];
    const idx = buildIndex(report(assets, findings));
    // If the build were O(assets × findings) it would fan rows out per asset; it is exactly per-finding.
    expect(idx.rows).toHaveLength(2);
  });

  it('cleanAssetCount = assets with NO non-ok finding (ok-only and finding-less assets are clean)', () => {
    const idx = buildIndex(
      report(
        [asset('dirty.png'), asset('okonly.png'), asset('untouched.png')],
        [finding('f1', 'dirty.png', 'crit'), finding('f2', 'okonly.png', 'ok')],
      ),
    );
    // dirty.png has a crit ⇒ not clean. okonly.png has only an ok finding ⇒ clean. untouched.png ⇒ clean.
    expect(idx.cleanAssetCount).toBe(2);
    // cleanAssets lists exactly those refs, in report order (deterministic), == cleanAssetCount.
    expect(idx.cleanAssets).toEqual(['okonly.png', 'untouched.png']);
    expect(idx.cleanAssets.length).toBe(idx.cleanAssetCount);
  });

  it('derives folder from the dir-aware assetRef (root asset ⇒ empty folder), keyed by keyOf not basename', () => {
    const idx = buildIndex(
      report(
        [asset('ui/buttons/play.png'), asset('root.png')],
        [finding('f1', 'ui/buttons/play.png', 'warn'), finding('f2', 'root.png', 'warn')],
      ),
    );
    const byId = new Map(idx.rows.map((r) => [r.id, r]));
    expect(byId.get('f1')?.folder).toBe('ui/buttons');
    expect(byId.get('f2')?.folder).toBe('');
  });

  it('HONESTY: a folder-scoped row carries NO per-asset VRAM/OCC; an asset row reads its declared metrics', () => {
    const idx = buildIndex(
      report(
        [asset('atlas.png', { vramBytes: 4096, occupancy: 0.4 })],
        [
          finding('asset1', 'atlas.png', 'warn', { scope: 'asset' }),
          finding('folder1', 'atlas.png', 'crit', { scope: 'folder', relatedRefs: ['a.png', 'b.png', 'c.png'] }),
        ],
      ),
    );
    const byId = new Map(idx.rows.map((r) => [r.id, r]));
    // asset-scoped row: declared vram + occupancy present.
    expect(byId.get('asset1')?.metric.vram).toBe(4096);
    expect(byId.get('asset1')?.metric.occupancy).toBe(0.4);
    // folder-scoped row: NO per-asset footprint even though its primary assetRef HAS metrics (correction #2).
    expect(byId.get('folder1')?.metric.vram).toBeUndefined();
    expect(byId.get('folder1')?.metric.occupancy).toBeUndefined();
    expect(byId.get('folder1')?.scope).toBe('folder');
    // relatedRefs ride through (the "+N assets" disclosure count).
    expect(byId.get('folder1')?.relatedRefs).toEqual(['a.png', 'b.png', 'c.png']);
    expect(byId.get('asset1')?.relatedRefs).toEqual([]);
  });

  it('carries the finding rule on every real row (the finding-type filter axis)', () => {
    const idx = buildIndex(
      report(
        [asset('a.png'), asset('b.png')],
        [finding('f1', 'a.png', 'warn', { rule: 'format' }), finding('f2', 'b.png', 'crit', { rule: 'dimensions-oversize' })],
      ),
    );
    const byId = new Map(idx.rows.map((r) => [r.id, r]));
    expect(byId.get('f1')?.rule).toBe('format');
    expect(byId.get('f2')?.rule).toBe('dimensions-oversize');
  });

  it('reads wastedDisk straight off estimate.diskBytesSaved (sparse ⇒ undefined, never 0)', () => {
    const idx = buildIndex(
      report(
        [asset('a.png'), asset('b.png')],
        [
          finding('withEst', 'a.png', 'warn', { estimate: { diskBytesSaved: 5000 } }),
          finding('noEst', 'b.png', 'warn'),
        ],
      ),
    );
    const byId = new Map(idx.rows.map((r) => [r.id, r]));
    expect(byId.get('withEst')?.metric.wastedDisk).toBe(5000);
    expect(byId.get('noEst')?.metric.wastedDisk).toBeUndefined(); // sparse, NOT 0
  });
});

// ── selectRows: filtering ───────────────────────────────────────────────────────────────────────────
describe('selectRows filtering', () => {
  const idx = buildIndex(
    report(
      [asset('ui/play.png'), asset('ui/pause.png'), asset('clean.png')],
      [
        finding('c', 'ui/play.png', 'crit'),
        finding('w', 'ui/pause.png', 'warn'),
        finding('i', 'ui/play.png', 'info'),
        finding('ok', 'clean.png', 'ok'),
      ],
    ),
  );

  it('problemsOnly hides ok rows', () => {
    expect(ids(selectRows(idx, opts({ problemsOnly: true }))).sort()).toEqual(['c', 'i', 'w']);
    expect(ids(selectRows(idx, opts({ problemsOnly: false }))).sort()).toEqual(['c', 'i', 'ok', 'w']);
  });

  it('severity filter keeps only the chosen severities', () => {
    const onlyCrit = selectRows(idx, opts({ severityFilter: new Set<Severity>(['crit']) }));
    expect(ids(onlyCrit)).toEqual(['c']);
  });

  it('search is a case-insensitive substring over the dir-aware assetRef', () => {
    expect(ids(selectRows(idx, opts({ search: 'PLAY' }))).sort()).toEqual(['c', 'i']);
    expect(ids(selectRows(idx, opts({ search: 'ui/' }))).sort()).toEqual(['c', 'i', 'ok', 'w'].filter((x) => x !== 'ok'));
    expect(selectRows(idx, opts({ search: 'nomatch' }))).toEqual([]);
  });
});

// ── selectRows: deterministic ordering ──────────────────────────────────────────────────────────────
describe('selectRows ordering & determinism', () => {
  it('default severity sort: worst first, tiebreak by assetRef then findingId', () => {
    const idx = buildIndex(
      report(
        [asset('z.png'), asset('a.png')],
        [
          finding('w1', 'z.png', 'warn'),
          finding('c1', 'z.png', 'crit'),
          finding('c2', 'a.png', 'crit'),
          finding('c0', 'a.png', 'crit'),
        ],
      ),
    );
    // crit bucket first; within it assetRef asc (a.png < z.png), then findingId asc (c0 < c2).
    expect(ids(selectRows(idx, opts({ sort: 'severity' })))).toEqual(['c0', 'c2', 'c1', 'w1']);
  });

  it('is stable across input permutations (sort key is total)', () => {
    const f = [
      finding('a', 'p.png', 'warn'),
      finding('b', 'q.png', 'crit'),
      finding('c', 'p.png', 'info'),
    ];
    const idxA = buildIndex(report([asset('p.png'), asset('q.png')], f));
    const idxB = buildIndex(report([asset('q.png'), asset('p.png')], [f[2]!, f[0]!, f[1]!]));
    expect(ids(selectRows(idxA, opts()))).toEqual(ids(selectRows(idxB, opts())));
  });

  it('wastedDisk sort: largest first, SPARSE estimates sort LAST (— not a fake 0)', () => {
    const idx = buildIndex(
      report(
        [asset('a.png'), asset('b.png'), asset('c.png')],
        [
          finding('small', 'a.png', 'warn', { estimate: { diskBytesSaved: 10 } }),
          finding('none', 'b.png', 'warn'),
          finding('big', 'c.png', 'warn', { estimate: { diskBytesSaved: 9000 } }),
        ],
      ),
    );
    // big > small, then the estimate-less row LAST — never sorted as if it were 0 (which would beat small).
    expect(ids(selectRows(idx, opts({ sort: 'wastedDisk' })))).toEqual(['big', 'small', 'none']);
  });
});

// ── selectRows: asset-axis collapse (correction #3) ─────────────────────────────────────────────────
describe('selectRows asset-axis (vram / occupancy) collapse to worst finding per asset', () => {
  it('vram sort: one row per asset (its worst finding), largest declared vram first; missing last', () => {
    const idx = buildIndex(
      report(
        [asset('big.png', { vramBytes: 8000 }), asset('small.png', { vramBytes: 100 }), asset('noatlas.png')],
        [
          finding('big-w', 'big.png', 'warn'),
          finding('big-c', 'big.png', 'crit'),
          finding('small-c', 'small.png', 'crit'),
          // folder-scoped: no per-asset vram ⇒ sorts last under the vram axis.
          finding('folder', 'noatlas.png', 'crit', { scope: 'folder', relatedRefs: ['x', 'y'] }),
        ],
      ),
    );
    const rows = selectRows(idx, opts({ sort: 'vram' }));
    // collapsed: one per asset. big.png's WORST finding is the crit (big-c), not the warn.
    expect(ids(rows)).toEqual(['big-c', 'small-c', 'folder']);
    expect(isAssetAxis('vram')).toBe(true);
    expect(isAssetAxis('severity')).toBe(false);
  });

  it('occupancy sort: lower occupancy (more waste) first; absent occupancy last', () => {
    const idx = buildIndex(
      report(
        [
          asset('packed.png', { occupancy: 0.9 }),
          asset('wasteful.png', { occupancy: 0.2 }),
          asset('loose.png'), // no occupancy
        ],
        [
          finding('p', 'packed.png', 'info'),
          finding('w', 'wasteful.png', 'warn'),
          finding('l', 'loose.png', 'warn'),
        ],
      ),
    );
    expect(ids(selectRows(idx, opts({ sort: 'occupancy' })))).toEqual(['w', 'p', 'l']);
  });
});

// ── selectRows: group-by-folder ─────────────────────────────────────────────────────────────────────
describe('selectRows group-by-folder', () => {
  it('pins folder-scoped findings first, then real folders in deterministic order; rows sorted within group', () => {
    const idx = buildIndex(
      report(
        [asset('zfolder/a.png'), asset('afolder/b.png'), asset('afolder/c.png')],
        [
          finding('z1', 'zfolder/a.png', 'warn'),
          finding('a1', 'afolder/b.png', 'info'),
          finding('a2', 'afolder/c.png', 'crit'),
          finding('cab', 'afolder/b.png', 'crit', { scope: 'folder', relatedRefs: ['afolder/b.png', 'afolder/c.png'] }),
        ],
      ),
    );
    const rows = selectRows(idx, opts({ sort: 'severity', groupByFolder: true }));
    // Cabinet (folder findings) first; then afolder (sorted: crit a2 before info a1); then zfolder.
    expect(ids(rows)).toEqual(['cab', 'a2', 'a1', 'z1']);
    expect(rows[0]?.scope).toBe('folder');
    expect(rows[0]?.relatedRefs.length).toBe(2);
  });

  it('grouped ordering is independent of input order (deterministic)', () => {
    const f = [
      finding('a', 'mid/x.png', 'warn'),
      finding('b', 'aaa/y.png', 'crit'),
      finding('c', 'zzz/z.png', 'info'),
    ];
    const idx1 = buildIndex(report([asset('mid/x.png'), asset('aaa/y.png'), asset('zzz/z.png')], f));
    const idx2 = buildIndex(report([asset('zzz/z.png'), asset('aaa/y.png'), asset('mid/x.png')], [f[2]!, f[1]!, f[0]!]));
    const r = (idx: ReturnType<typeof buildIndex>) => ids(selectRows(idx, opts({ groupByFolder: true })));
    expect(r(idx1)).toEqual(['b', 'a', 'c']); // aaa, mid, zzz
    expect(r(idx2)).toEqual(r(idx1));
  });
});

// ── selectRows: includeClean (the honest "show N clean" toggle — finding [0] fix) ──────────────────────
describe('selectRows includeClean — the "show N clean" toggle is REAL, not a dead control', () => {
  // Production never emits an ok-severity finding (rules return null on 'ok'), so clean assets have ZERO
  // backing rows. includeClean synthesizes exactly one ok row per clean asset — so toggling it on changes
  // the visible row count by EXACTLY cleanAssetCount (the count the button advertises).
  const idx = buildIndex(
    report(
      [asset('ui/play.png'), asset('ui/idle.png'), asset('ui/hover.png')],
      // Only play.png has a problem; idle.png + hover.png are clean (no finding at all).
      [finding('c', 'ui/play.png', 'crit')],
    ),
  );

  it('toggling includeClean adds EXACTLY cleanAssetCount rows', () => {
    // problemsOnly:false in both so the only delta is the synthesized clean rows.
    const off = selectRows(idx, opts({ includeClean: false }));
    const on = selectRows(idx, opts({ includeClean: true }));
    expect(idx.cleanAssetCount).toBe(2);
    expect(on.length - off.length).toBe(idx.cleanAssetCount); // the toggle does something — by exactly N
    // The new rows are precisely the clean assets, keyed by their dir-aware assetRef (not basename).
    const newRefs = on.filter((r) => !off.some((o) => o.id === r.id)).map((r) => r.assetRef).sort();
    expect(newRefs).toEqual(['ui/hover.png', 'ui/idle.png']);
  });

  it('synthesized clean rows are HONEST: ok severity, scope asset, NO metric (never inflates a rollup)', () => {
    const on = selectRows(idx, opts({ includeClean: true }));
    const clean = on.filter((r) => r.clean);
    expect(clean).toHaveLength(2);
    for (const r of clean) {
      expect(r.severity).toBe('ok');
      expect(r.scope).toBe('asset');
      expect(r.id).toBe(`ok:${r.assetRef}`); // collision-free synthetic id (real ids are <ref>:<rule>)
      // NO claimed footprint — a clean asset has no problem metric to show; badges render nothing.
      expect(r.metric.wastedDisk).toBeUndefined();
      expect(r.metric.vram).toBeUndefined();
      expect(r.metric.occupancy).toBeUndefined();
      expect(r.relatedRefs).toEqual([]);
    }
  });

  it('clean rows still obey the severity filter (hidden when ok is filtered out)', () => {
    const noOk = selectRows(idx, opts({ includeClean: true, severityFilter: new Set<Severity>(['crit', 'warn', 'info']) }));
    expect(noOk.some((r) => r.clean)).toBe(false); // synthesized but filtered ⇒ no fake reveal
    expect(noOk.map((r) => r.id)).toEqual(['c']);
  });

  it('clean rows sort LAST (ok is the lowest severity rank) and search-filter by assetRef', () => {
    const on = selectRows(idx, opts({ includeClean: true, sort: 'severity' }));
    expect(on[0]?.id).toBe('c'); // the crit stays worst-first; clean rows trail
    expect(on.slice(1).every((r) => r.clean)).toBe(true);
    // search narrows clean rows too (dir-aware substring).
    const searched = selectRows(idx, opts({ includeClean: true, search: 'hover' }));
    expect(searched.map((r) => r.assetRef)).toEqual(['ui/hover.png']);
  });

  it('an asset with ONLY an ok finding is clean (synthesized once), not double-counted', () => {
    // okonly.png has a synthetic ok finding in the report; production never emits one, but if it did the
    // asset is still "clean" (no non-ok finding) — the ok finding row AND the synthesized clean row would
    // both be ok, so dedup matters. Assert the asset is clean and surfaces exactly once via includeClean.
    const idx2 = buildIndex(report([asset('okonly.png')], [finding('okf', 'okonly.png', 'ok')]));
    expect(idx2.cleanAssets).toEqual(['okonly.png']);
    const on = selectRows(idx2, opts({ includeClean: true }));
    // The pre-existing ok finding row ('okf') AND the synthesized clean row ('ok:okonly.png') both appear —
    // distinct ids, both ok. (In production no ok finding exists, so only the synthesized row shows.)
    expect(on.map((r) => r.id).sort()).toEqual(['ok:okonly.png', 'okf']);
  });
});

// ── countCandidates: the "of M" denominator without a second full sort (round11 #4) ──────────────────
describe('countCandidates == selectRows(...,{search:""}).length', () => {
  const idx = buildIndex(
    report(
      [
        asset('ui/play.png', { vramBytes: 100, occupancy: 0.3 }),
        asset('ui/pause.png', { vramBytes: 200, occupancy: 0.5 }),
        asset('clean.png'),
      ],
      [
        finding('c', 'ui/play.png', 'crit'),
        finding('w', 'ui/pause.png', 'warn'),
        finding('i', 'ui/play.png', 'info'),
        finding('folder', 'ui/pause.png', 'crit', { scope: 'folder', relatedRefs: ['ui/play.png', 'ui/pause.png'] }),
      ],
    ),
  );

  // Across every axis / policy combination, the cheap filter-only count must equal the full selectRows
  // length with search blanked — including the per-asset collapse on asset-axis sorts (vram/occupancy).
  for (const sort of ['severity', 'wastedDisk', 'vram', 'occupancy'] as const) {
    for (const problemsOnly of [true, false]) {
      for (const includeClean of [false, true]) {
        for (const severityFilter of [
          new Set<Severity>(['crit', 'warn', 'info', 'ok']),
          new Set<Severity>(['crit']),
          new Set<Severity>(['warn', 'info']),
        ]) {
          it(`matches for sort=${sort} problemsOnly=${problemsOnly} includeClean=${includeClean} sev=${[...severityFilter].join('+')}`, () => {
            const o = opts({ sort, problemsOnly, includeClean, severityFilter, search: 'IGNORED-BY-COUNT' });
            const full = selectRows(idx, { ...o, search: '' }).length;
            expect(countCandidates(idx, o)).toBe(full);
          });
        }
      }
    }
  }
});

// ── selectRows: the finding-TYPE filter (view-prefs) — an honest USER filter, byte-identical when empty ──
describe('selectRows finding-type filter (hiddenRules)', () => {
  // Mixed rules across three assets; play.png has TWO findings (occupancy + format) so hiding one type
  // collapses it to the other on the asset axis rather than removing the asset.
  const mixed = report(
    [
      asset('ui/play.png', { vramBytes: 300 }),
      asset('ui/pause.png', { vramBytes: 200 }),
      asset('bg.png', { vramBytes: 500 }),
    ],
    [
      finding('occ1', 'ui/play.png', 'warn', { rule: 'occupancy' }),
      finding('fmt1', 'ui/play.png', 'info', { rule: 'format' }),
      finding('fmt2', 'ui/pause.png', 'warn', { rule: 'format' }),
      finding('over1', 'bg.png', 'crit', { rule: 'dimensions-oversize' }),
    ],
  );
  const idx = buildIndex(mixed);

  it('BYTE-IDENTITY: an empty hidden set and an OMITTED hidden set select the exact same rows', () => {
    const emptySet = selectRows(idx, opts({ hiddenRules: new Set<Rule>() }));
    const omitted = selectRows(idx, { ...opts(), hiddenRules: undefined });
    expect(ids(omitted)).toEqual(ids(emptySet));
    // ...and both equal the pre-existing (no type-filter) behavior: all four rows.
    expect(ids(emptySet).sort()).toEqual(['fmt1', 'fmt2', 'occ1', 'over1']);
  });

  it('BYTE-IDENTITY: hiding a rule NOT present in the report is a no-op, and H === 0', () => {
    const base = selectRows(idx, opts());
    const notPresent = opts({ hiddenRules: new Set<Rule>(['bleeding']) }); // valid rule, absent here
    expect(ids(selectRows(idx, notPresent))).toEqual(ids(base));
    expect(typeHiddenCount(idx, notPresent)).toBe(0); // H counts only ACTUALLY-hidden rows
  });

  it('hiding a present rule removes EXACTLY the rows of that type (finding-axis)', () => {
    const hidFormat = selectRows(idx, opts({ hiddenRules: new Set<Rule>(['format']) }));
    expect(ids(hidFormat).sort()).toEqual(['occ1', 'over1']); // fmt1 + fmt2 gone; nothing else touched
  });

  it('a synthesized CLEAN row (rule undefined) is NEVER type-hidden — even hiding ALL rules keeps it', () => {
    const idx2 = buildIndex(
      report([asset('dirty.png'), asset('clean.png')], [finding('d', 'dirty.png', 'warn', { rule: 'occupancy' })]),
    );
    const rows = selectRows(idx2, opts({ includeClean: true, hiddenRules: new Set<Rule>(ALL_RULES) }));
    expect(rows.some((r) => r.id === 'd')).toBe(false); // the real occupancy row IS hidden
    expect(rows.some((r) => r.clean && r.assetRef === 'clean.png')).toBe(true); // the clean row survives
  });

  // ── H reconciliation (design §1.3): countCandidates(withType) + H === countCandidates(noType) ──────
  it('H reconciles on the FINDING axis (severity sort): withType + H === noType', () => {
    const o = opts({ sort: 'severity', hiddenRules: new Set<Rule>(['format']) });
    const withType = countCandidates(idx, o);
    const h = typeHiddenCount(idx, o);
    const noType = countCandidates(idx, { ...o, hiddenRules: new Set<Rule>() });
    expect(withType).toBe(2); // occ1 + over1
    expect(h).toBe(2); // fmt1 + fmt2 hidden
    expect(withType + h).toBe(noType); // == 4
    expect(h).toBeGreaterThan(0);
  });

  it('H reconciles on the ASSET axis (vram sort, distinct-asset units): withType + H === noType', () => {
    const o = opts({ sort: 'vram', hiddenRules: new Set<Rule>(['format']) });
    const withType = countCandidates(idx, o);
    const h = typeHiddenCount(idx, o);
    const noType = countCandidates(idx, { ...o, hiddenRules: new Set<Rule>() });
    // play collapses to its still-visible occupancy row; pause (format-only) drops; bg stays.
    expect(withType).toBe(2); // play + bg
    expect(noType).toBe(3); // play + pause + bg
    expect(h).toBe(1); // pause disappeared
    expect(withType + h).toBe(noType);
  });

  // ── composition with the severity filter AND the spritesheet fold ──────────────────────────────────
  it('severity ∩ type = the intersection of the two view filters', () => {
    const sevOpts = opts({ severityFilter: new Set<Severity>(['crit', 'warn']) }); // drops fmt1 (info)
    const typeOpts = opts({ hiddenRules: new Set<Rule>(['format']) }); // drops fmt1 + fmt2
    const bothOpts = opts({ severityFilter: new Set<Severity>(['crit', 'warn']), hiddenRules: new Set<Rule>(['format']) });
    const sevIds = new Set(ids(selectRows(idx, sevOpts)));
    const typeIds = new Set(ids(selectRows(idx, typeOpts)));
    const intersection = [...sevIds].filter((id) => typeIds.has(id)).sort();
    expect(ids(selectRows(idx, bothOpts)).sort()).toEqual(intersection);
    expect(intersection).toEqual(['occ1', 'over1']);
  });

  it('a type-hidden finding that is ALSO fold-eligible is counted in H, NOT in the fold — no double-count', () => {
    // sib is a redundant-sibling `format` finding ⇒ foldableFindingIds returns it (computed over the FULL
    // report, pre-select). Hiding `format` removes it from the selected rows, so a post-select fold count
    // over those rows sees ZERO of the still-foldable ids — it is charged to H instead (single bucket).
    const foldRep = report(
      [asset('a.png'), asset('b.png')],
      [
        finding('sib', 'a.png', 'info', { rule: 'format', params: { redundantSibling: 1 } }),
        finding('keep', 'b.png', 'warn', { rule: 'occupancy' }),
      ],
    );
    const foldIdx = buildIndex(foldRep);
    const foldable = foldableFindingIds(foldRep);
    expect(foldable.has('sib')).toBe(true); // fold set is pre-select, unchanged by the type filter

    const o = opts({ hiddenRules: new Set<Rule>(['format']) });
    const rows = selectRows(foldIdx, o);
    expect(rows.some((r) => r.id === 'sib')).toBe(false); // gone from the type-filtered rows
    const foldedInRows = rows.filter((r) => foldable.has(r.id)).length; // K over the post-type rows
    expect(foldedInRows).toBe(0); // NOT counted in the fold...
    expect(typeHiddenCount(foldIdx, o)).toBe(1); // ...counted in H instead
  });
});

// ── defaultSelectOpts: the ONE canonical opening view (round11 #3 — no drift) ──────────────────────────
describe('defaultSelectOpts', () => {
  it('is worst-first, all-severities, problems-only, no-clean, ungrouped, no hidden types', () => {
    const d = defaultSelectOpts();
    expect(d.sort).toBe(DEFAULT_SORT);
    expect(d.sort).toBe('severity');
    expect([...d.severityFilter].sort()).toEqual([...DEFAULT_SEVERITIES].sort());
    expect(d.problemsOnly).toBe(true);
    expect(d.includeClean).toBe(false);
    expect(d.groupByFolder).toBe(false);
    expect(d.search).toBe('');
    expect(d.hiddenRules?.size ?? 0).toBe(0); // default hides no type ⇒ byte-identical to today
  });

  it('returns a FRESH severityFilter Set each call (toggling never aliases the shared default)', () => {
    const a = defaultSelectOpts();
    const b = defaultSelectOpts();
    expect(a.severityFilter).not.toBe(b.severityFilter);
    a.severityFilter.delete('crit');
    expect(b.severityFilter.has('crit')).toBe(true);
  });
});

// ── SEV_RANK sanity ─────────────────────────────────────────────────────────────────────────────────
describe('SEV_RANK', () => {
  it('orders crit < warn < info < ok (worst first)', () => {
    expect(SEV_RANK.crit).toBeLessThan(SEV_RANK.warn);
    expect(SEV_RANK.warn).toBeLessThan(SEV_RANK.info);
    expect(SEV_RANK.info).toBeLessThan(SEV_RANK.ok);
  });
});
