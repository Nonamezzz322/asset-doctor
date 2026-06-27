import { describe, expect, it } from 'vitest';
import { classifyOp, groupOps, OP_KIND_ORDER, REFERENCE_CHANGING, type OpKind } from './op-manifest';

// Real worker strings sampled from each operations.push site in fix.worker.ts (verbatim formats).
const SAMPLES: Record<string, OpKind | null> = {
  'repack hero.png (spine) → 1024×512': 'repack', // line 494
  'repack hero.png (polygon) → 1024×512 webp': 'repack', // line 590
  'merge 3 atlases → 1 sheet': 'merge', // line 607
  'resize atlas big.png → 2048×2048': 'resize', // line 661 (resize atlas …)
  'resize huge.png → 2048×1024 webp': 'resize', // line 682 (resize …)
  'transcode photo.png → webp': 'transcode', // line 709
  'drop duplicate copy.png': 'drop', // line 723 (drop duplicate → first token 'drop')
  'pack 12 loose → ui sheet (1 page)': 'pack', // line 916
  'dedup a.png → b.png (repoint meta.image)': 'dedup', // lines 982 & 1009
  'tier bg.png → 3 resolutions': 'tier', // line 1155
};

describe('classifyOp', () => {
  for (const [op, kind] of Object.entries(SAMPLES)) {
    it(`classifies ${JSON.stringify(op)} → ${kind}`, () => {
      expect(classifyOp(op)).toBe(kind);
    });
  }

  it('returns null for an unknown verb', () => {
    expect(classifyOp('frobnicate x.png')).toBeNull();
  });

  it('returns null for an empty / whitespace string', () => {
    expect(classifyOp('')).toBeNull();
    expect(classifyOp('   ')).toBeNull();
  });
});

describe('groupOps', () => {
  it('emits groups in OP_KIND_ORDER regardless of input order', () => {
    const ops = ['tier a → 2', 'repack b → 1×1', 'merge 2 → 1 sheet', 'resize c → 2×2'];
    const got = groupOps(ops).map((g) => g.kind);
    expect(got).toEqual(['repack', 'resize', 'merge', 'tier']);
    // sanity: matches the canonical order's relative positions
    expect(got).toEqual(OP_KIND_ORDER.filter((k) => got.includes(k)));
  });

  it('buckets unknown verbs into a single trailing null group', () => {
    const groups = groupOps(['frobnicate x', 'repack b → 1×1', 'wibble y']);
    expect(groups.map((g) => g.kind)).toEqual(['repack', null]);
    const other = groups[groups.length - 1]!;
    expect(other.kind).toBeNull();
    expect(other.refChanging).toBe(false);
    expect(other.rows.map((r) => r.text)).toEqual(['frobnicate x', 'wibble y']); // input order
  });

  it('preserves input order within a group', () => {
    const groups = groupOps(['transcode a.png → webp', 'transcode b.png → webp', 'transcode c.png → webp']);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map((r) => r.text)).toEqual(['transcode a.png → webp', 'transcode b.png → webp', 'transcode c.png → webp']);
  });

  it('flags refChanging exactly for merge/dedup/pack/tier', () => {
    const ops = [
      'repack b → 1×1',
      'resize c → 2×2',
      'transcode d.png → webp',
      'drop duplicate e.png',
      'merge 2 → 1 sheet',
      'pack 3 loose → s sheet (1 page)',
      'dedup f.png → g.png (repoint meta.image)',
      'tier h → 2 resolutions',
    ];
    const refByKind = new Map(groupOps(ops).map((g) => [g.kind, g.refChanging]));
    for (const k of OP_KIND_ORDER) {
      expect(refByKind.get(k)).toBe(REFERENCE_CHANGING.has(k));
    }
  });

  it('is pure: same input ⇒ deep-equal output', () => {
    const ops = ['repack b → 1×1', 'frobnicate x', 'merge 2 → 1 sheet'];
    expect(groupOps(ops)).toEqual(groupOps(ops));
  });

  it('returns [] for empty input', () => {
    expect(groupOps([])).toEqual([]);
  });
});
