import { describe, it, expect } from 'vitest';
import type { Finding } from '@asset-doctor/core';
import { CATALOGS } from '@asset-doctor/i18n';
import { cabinetDetailFinding, affectedFiles, affectedRows, perRefValueText, CABINET_VALUE_RULES } from './cabinet-detail';

const folder = (id: string, relatedRefs: string[]): Finding => ({
  id,
  rule: 'premultiplied-alpha' as Finding['rule'],
  severity: 'info',
  scope: 'folder',
  assetRef: relatedRefs[0] ?? 'a.png',
  relatedRefs,
  title: 't',
  detail: 'd',
});

const asset = (id: string): Finding => ({
  id,
  rule: 'occupancy' as Finding['rule'],
  severity: 'warn',
  assetRef: 'a.png',
  title: 't',
  detail: 'd',
});

describe('cabinetDetailFinding — resolve the selected folder-issue detail', () => {
  const findings: Finding[] = [
    folder('folder:premultiplied-alpha', ['ui/a.png', 'ui/b.png', 'ui/c.png']),
    asset('atlas.png:occupancy'),
  ];

  it('a selected FOLDER finding id ⇒ returns that finding', () => {
    expect(cabinetDetailFinding('folder:premultiplied-alpha', findings)?.id).toBe('folder:premultiplied-alpha');
  });

  it('a selected ASSET finding id ⇒ null (asset findings own the per-asset panel, not this surface)', () => {
    expect(cabinetDetailFinding('atlas.png:occupancy', findings)).toBeNull();
  });

  it('undefined selection ⇒ null', () => {
    expect(cabinetDetailFinding(undefined, findings)).toBeNull();
  });

  it('a synthesized clean-row id (ok:<ref>, no backing finding) ⇒ null', () => {
    expect(cabinetDetailFinding('ok:clean.png', findings)).toBeNull();
  });
});

describe('affectedFiles — the measured membership, verbatim', () => {
  it('returns relatedRefs in the order the rule sorted them', () => {
    expect(affectedFiles(folder('f', ['ui/a.png', 'ui/b.png']))).toEqual(['ui/a.png', 'ui/b.png']);
  });

  it('a finding with no relatedRefs ⇒ [] (the card omits the drill-down entirely)', () => {
    const f = asset('x');
    expect(affectedFiles(f)).toEqual([]);
  });
});

describe('affectedRows + perRefValueText — the P2 per-sprite measured breakdown', () => {
  it('a perRef-carrying finding renders WORST-FIRST rows with formatted values (order preserved verbatim)', () => {
    const f: Finding = {
      ...folder('folder:premultiplied-alpha', ['ui/a.png', 'ui/b.png']),
      perRef: [{ ref: 'ui/b.png', value: 0.94 }, { ref: 'ui/a.png', value: 0.79 }],
    };
    expect(affectedRows(f)).toEqual([
      { ref: 'ui/b.png', valueText: '94%' },
      { ref: 'ui/a.png', valueText: '79%' },
    ]);
  });

  it('no perRef ⇒ name-only relatedRefs fallback (pre-P2 behavior, byte-identical rows)', () => {
    expect(affectedRows(folder('f', ['ui/a.png', 'ui/b.png']))).toEqual([{ ref: 'ui/a.png' }, { ref: 'ui/b.png' }]);
  });

  it('a rule with NO registered value semantics ⇒ rows keep the perRef ORDER but carry no value (never a guessed unit)', () => {
    const f: Finding = {
      ...folder('folder:gpu', ['a.png', 'b.png']),
      rule: 'gpu-compression-alignment' as Finding['rule'],
      perRef: [{ ref: 'b.png', value: 3 }, { ref: 'a.png', value: 1 }],
    };
    expect(affectedRows(f)).toEqual([{ ref: 'b.png' }, { ref: 'a.png' }]);
  });

  it('formatters: fraction rules render pct; byte rules render fmtBytes-style units', () => {
    expect(perRefValueText('premultiplied-alpha', 0.879)).toBe('88%');
    expect(perRefValueText('atlas-merge', 0.34)).toBe('34%');
    expect(perRefValueText('format', 1536)).toBe('1.5 KB');
    expect(perRefValueText('strippable-metadata', 3 * 1024 * 1024)).toBe('3.0 MB');
    expect(perRefValueText('occupancy', 5)).toBeNull();
  });

  it('drift guard: every CABINET_VALUE_RULES entry has its cabinet.value.* key in en (the JSX reads it dynamically)', () => {
    for (const r of CABINET_VALUE_RULES) {
      expect(CATALOGS.en[`cabinet.value.${r}`], `cabinet.value.${r} must exist in en.json`).toBeDefined();
    }
  });
});
