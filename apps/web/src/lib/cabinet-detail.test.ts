import { describe, it, expect } from 'vitest';
import type { Finding } from '@asset-doctor/core';
import { cabinetDetailFinding, affectedFiles } from './cabinet-detail';

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
