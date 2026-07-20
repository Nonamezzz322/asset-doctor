import { describe, it, expect } from 'vitest';
import type { AnalysisReport, Finding } from '@asset-doctor/core';
import { biggestWins, hasWins } from '../src/biggest-wins';

// Minimal finding factory — only the fields biggest-wins reads.
const f = (id: string, opts: Partial<Finding> & { disk?: number; vram?: number } = {}): Finding => {
  const { disk, vram, ...rest } = opts;
  const estimate =
    disk === undefined && vram === undefined
      ? rest.estimate
      : {
          ...(disk !== undefined ? { diskBytesSaved: disk } : {}),
          ...(vram !== undefined ? { vramBytesSaved: vram } : {}),
        };
  return {
    id,
    rule: 'occupancy' as Finding['rule'],
    severity: 'warn',
    assetRef: id.split(':')[0] ?? 'a.png',
    title: 't',
    detail: 'd',
    ...rest,
    ...(estimate ? { estimate } : {}),
  };
};

const report = (findings: Finding[]): AnalysisReport =>
  ({ assets: [], findings }) as unknown as AnalysisReport;

describe('biggestWins — impact-first ranking of measured reclaims', () => {
  it('ranks disk wins DESC by diskBytesSaved, VRAM wins DESC by vramBytesSaved (two independent lists)', () => {
    const w = biggestWins(
      report([
        f('a.png:x', { disk: 100, vram: 10 }),
        f('b.png:x', { disk: 300, vram: 5 }),
        f('c.png:x', { disk: 200, vram: 50 }),
      ]),
    );
    expect(w.disk.map((r) => r.id)).toEqual(['b.png:x', 'c.png:x', 'a.png:x']); // 300 > 200 > 100
    expect(w.vram.map((r) => r.id)).toEqual(['c.png:x', 'a.png:x', 'b.png:x']); // 50 > 10 > 5
    expect(w.disk[0]!.bytes).toBe(300);
    expect(w.vram[0]!.bytes).toBe(50);
  });

  it('a finding with only ONE axis appears only in that list (sparse ≠ 0, never fabricated)', () => {
    const w = biggestWins(
      report([
        f('vramonly.png:upscaled-source', { vram: 999 }), // no disk key at all
        f('diskonly.png:strippable', { disk: 999 }), // no vram key
      ]),
    );
    expect(w.disk.map((r) => r.id)).toEqual(['diskonly.png:strippable']);
    expect(w.vram.map((r) => r.id)).toEqual(['vramonly.png:upscaled-source']);
  });

  it('excludes findings with no estimate and with a zero/negative saving (never a fabricated 0)', () => {
    const w = biggestWins(
      report([
        f('disclosure.png:binary-alpha', { estimate: undefined }), // pure disclosure
        f('zero.png:x', { disk: 0, vram: 0 }),
        f('real.png:x', { disk: 5 }),
      ]),
    );
    expect(w.disk.map((r) => r.id)).toEqual(['real.png:x']);
    expect(w.vram).toEqual([]);
  });

  it('caps each list at the limit (default 3)', () => {
    const many = Array.from({ length: 6 }, (_, i) => f(`s${i}.png:x`, { disk: (i + 1) * 10 }));
    expect(biggestWins(report(many)).disk).toHaveLength(3);
    expect(biggestWins(report(many), 2).disk).toHaveLength(2);
    // the 3 largest, in order
    expect(biggestWins(report(many)).disk.map((r) => r.bytes)).toEqual([60, 50, 40]);
  });

  it('ties break by severity then assetRef then id (deterministic, mirrors triage)', () => {
    const w = biggestWins(
      report([
        f('z.png:x', { disk: 100, severity: 'info' }),
        f('a.png:x', { disk: 100, severity: 'info' }),
        f('m.png:x', { disk: 100, severity: 'crit' }), // crit outranks info at equal bytes
      ]),
    );
    expect(w.disk.map((r) => r.id)).toEqual(['m.png:x', 'a.png:x', 'z.png:x']);
  });

  it('folder finding carries relatedCount (the "+N assets" span) and scope', () => {
    const w = biggestWins(
      report([
        f('folder:should-atlas', {
          scope: 'folder',
          assetRef: 'ui/a.png',
          relatedRefs: ['ui/a.png', 'ui/b.png', 'ui/c.png'],
          vram: 4_000_000,
        }),
      ]),
    );
    expect(w.vram[0]!.scope).toBe('folder');
    expect(w.vram[0]!.relatedCount).toBe(3);
    expect(w.vram[0]!.assetRef).toBe('ui/a.png');
  });

  it('asset finding has relatedCount 0', () => {
    const w = biggestWins(report([f('a.png:occupancy', { vram: 10 })]));
    expect(w.vram[0]!.scope).toBe('asset');
    expect(w.vram[0]!.relatedCount).toBe(0);
  });

  it('hasWins is false only when BOTH lists are empty (⇒ panel absent, DOM-identical to today)', () => {
    expect(hasWins(biggestWins(report([])))).toBe(false);
    expect(hasWins(biggestWins(report([f('d.png:binary-alpha', { estimate: undefined })])))).toBe(
      false,
    );
    expect(hasWins(biggestWins(report([f('d.png:x', { disk: 1 })])))).toBe(true);
    expect(hasWins(biggestWins(report([f('v.png:x', { vram: 1 })])))).toBe(true);
  });

  it('does not sum — a list of overlapping wins keeps each item independent (no total invented)', () => {
    const w = biggestWins(
      report([
        f('atlas.png:repack-opportunity', { vram: 3_000_000 }),
        f('folder:should-atlas', { scope: 'folder', vram: 3_000_000, relatedRefs: ['atlas.png'] }),
      ]),
    );
    // both surface at their own measured value; nothing anywhere equals 6_000_000
    expect(w.vram.map((r) => r.bytes)).toEqual([3_000_000, 3_000_000]);
  });
});
