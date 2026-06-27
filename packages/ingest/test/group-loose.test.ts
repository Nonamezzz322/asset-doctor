// Feature 4 — ingest grouping helper (design §4). groupLooseForPacking turns loose image refs into
// deterministic PackGroup[]: spine roots detected FIRST (skel / skeleton-json / animations|spine
// convention), everything else into static sheets (one per leaf folder by default). It RE-APPLIES
// shouldAtlas.maxSpriteEdgePx per image (never reads a should-atlas finding), strips the image ext for
// region names (slash-preserved, nesting kept), and surfaces file→region collisions (two distinct files
// resolving to one name). These tests pin spine-root detection, static grouping, nested region names,
// the per-image size re-application, collision surfacing, output paths per mode, and determinism.

import { describe, it, expect } from 'vitest';
import type { Size } from '@asset-doctor/core';
import { groupLooseForPacking, type LooseImage, type RawFile } from '../src/index';

const DEFAULTS = {
  occupancy: { warn: 0.8, crit: 0.6 },
  oversizePx: { warn: 2048, crit: 2730 },
  formatSaving: { warn: 0.25 },
  npotPadding: { warn: 0.25 },
  duplicates: { similarHammingMax: 6 },
  shouldAtlas: { minLooseImages: 8, maxSpriteEdgePx: 512 },
  atlasMerge: { occupancyBelow: 0.5, minAtlases: 2 },
};

const sz = (w: number, h: number): Size => ({ w, h });
const img = (ref: string, w = 32, h = 32): LooseImage => ({ ref, size: sz(w, h) });

/** Encode a string into a fresh ArrayBuffer (RawFile.bytes). */
function buf(s: string): ArrayBuffer {
  const u8 = new TextEncoder().encode(s);
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

/** A skeleton .json marker (top-level skeleton+bones+slots). */
function skelJson(path: string): RawFile {
  const json = JSON.stringify({ skeleton: { hash: 'x' }, bones: [{ name: 'root' }], slots: [] });
  return { name: path.split('/').pop()!, path, bytes: buf(json) };
}
/** A TexturePacker manifest (frames/meta.image) — must NOT be mistaken for a skeleton. */
function tpJson(path: string): RawFile {
  const json = JSON.stringify({ frames: {}, meta: { image: 'sheet.png' } });
  return { name: path.split('/').pop()!, path, bytes: buf(json) };
}
function skelBinary(path: string): RawFile {
  return { name: path.split('/').pop()!, path, bytes: new ArrayBuffer(3) };
}

describe('spine-root detection', () => {
  it('detects a root from a skeleton .json (skeleton+bones+slots)', () => {
    const images = [img('hero/body.png'), img('hero/items/sword.png'), img('hero/items/shield.png')];
    const { groups } = groupLooseForPacking(images, [skelJson('hero/hero.json')], {
      thresholds: DEFAULTS,
      forced: true,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('spine');
    expect(groups[0]!.root).toBe('hero');
    expect(groups[0]!.outDir).toBe('hero');
    expect(groups[0]!.stem).toBe('hero');
    expect(groups[0]!.skeletonRef).toBe('hero/hero.json');
  });

  it('detects a root from a binary .skel', () => {
    const images = [img('mob/a.png'), img('mob/b.png')];
    const { groups } = groupLooseForPacking(images, [skelBinary('mob/mob.skel')], {
      thresholds: DEFAULTS,
      forced: true,
    });
    expect(groups[0]!.kind).toBe('spine');
    expect(groups[0]!.root).toBe('mob');
    expect(groups[0]!.skeletonRef).toBe('mob/mob.skel');
  });

  it('does NOT treat a TexturePacker manifest as a skeleton', () => {
    const images = Array.from({ length: 8 }, (_, i) => img(`ui/btn${i}.png`));
    const { groups } = groupLooseForPacking(images, [tpJson('ui/ui.json')], { thresholds: DEFAULTS });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('static'); // NOT spine
  });

  it('detects a root from the animations/<name> folder convention (no marker file)', () => {
    const images = [img('raw/animations/coin/0.png'), img('raw/animations/coin/1.png')];
    const { groups } = groupLooseForPacking(images, [], { thresholds: DEFAULTS, forced: true });
    expect(groups[0]!.kind).toBe('spine');
    expect(groups[0]!.root).toBe('raw/animations/coin');
    // Convention-only ⇒ no skeleton marker ⇒ skeletonRef stays undefined. This is the EXACT input that
    // drives the worker's "paths not verified (no skeleton file found)" honesty branch (fix.worker.ts §8b):
    // such a group still ships its `.atlas`, but MUST be counted in packVerification.unverified — never
    // silently. The worker keys that branch off `isSpine && !group.skeletonRef`, so pinning the missing
    // skeletonRef here is the unit guard that the convention-detected spine root never ships verified-clean.
    expect(groups[0]!.skeletonRef).toBeUndefined();
  });

  it('detects a root from the spine/<name> convention', () => {
    const images = [img('spine/boss/0.png'), img('spine/boss/1.png')];
    const { groups } = groupLooseForPacking(images, [], { thresholds: DEFAULTS, forced: true });
    expect(groups[0]!.root).toBe('spine/boss');
  });
});

describe('spine region names (nested, ext-stripped, slash-preserved)', () => {
  it('keeps nested sub-paths relative to the root', () => {
    const images = [img('hero/body.png'), img('hero/items/sword.png'), img('hero/fx/glow.webp')];
    const { groups } = groupLooseForPacking(images, [skelJson('hero/hero.json')], {
      thresholds: DEFAULTS,
      forced: true,
    });
    const names = groups[0]!.regions.map((r) => r.name).sort();
    expect(names).toEqual(['body', 'fx/glow', 'items/sword']);
  });
});

describe('static grouping (one sheet per leaf folder)', () => {
  it('groups loose images by leaf folder and names them relative to outDir', () => {
    const images = [
      ...Array.from({ length: 8 }, (_, i) => img(`ui/hud/i${i}.png`)),
      ...Array.from({ length: 8 }, (_, i) => img(`ui/menu/m${i}.png`)),
    ];
    const { groups } = groupLooseForPacking(images, [], { thresholds: DEFAULTS });
    expect(groups).toHaveLength(2);
    const hud = groups.find((g) => g.outDir === 'ui/hud')!;
    expect(hud.kind).toBe('static');
    expect(hud.stem).toBe('hud');
    expect(hud.regions.map((r) => r.name).sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `i${i}`).sort(),
    );
  });

  it('skips a group below minLooseImages unless forced', () => {
    const images = Array.from({ length: 3 }, (_, i) => img(`ui/x${i}.png`)); // < 8
    expect(groupLooseForPacking(images, [], { thresholds: DEFAULTS }).groups).toHaveLength(0);
    const forced = groupLooseForPacking(images, [], { thresholds: DEFAULTS, forced: true });
    expect(forced.groups).toHaveLength(1);
    expect(forced.groups[0]!.regions).toHaveLength(3);
  });

  it('re-applies maxSpriteEdgePx per image (large images excluded even in a small folder)', () => {
    const images = [
      ...Array.from({ length: 8 }, (_, i) => img(`a/small${i}.png`, 64, 64)),
      img('a/huge.png', 2048, 2048), // > 512 → excluded
    ];
    const { groups } = groupLooseForPacking(images, [], { thresholds: DEFAULTS });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.regions.map((r) => r.name)).not.toContain('huge');
    expect(groups[0]!.regions).toHaveLength(8);
  });

  it('one-sheet-for-all uses the common ancestor as outDir and keeps relative names', () => {
    const images = [
      ...Array.from({ length: 4 }, (_, i) => img(`pkg/a/x${i}.png`)),
      ...Array.from({ length: 4 }, (_, i) => img(`pkg/b/y${i}.png`)),
    ];
    const { groups } = groupLooseForPacking(images, [], {
      thresholds: DEFAULTS,
      granularity: 'one-sheet-for-all',
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.outDir).toBe('pkg');
    const names = groups[0]!.regions.map((r) => r.name).sort();
    expect(names).toContain('a/x0');
    expect(names).toContain('b/y0');
  });

  it('per-top-level-bundle groups by the first path segment', () => {
    const images = [
      ...Array.from({ length: 8 }, (_, i) => img(`bundleA/deep/x${i}.png`)),
      ...Array.from({ length: 8 }, (_, i) => img(`bundleB/y${i}.png`)),
    ];
    const { groups } = groupLooseForPacking(images, [], {
      thresholds: DEFAULTS,
      granularity: 'per-top-level-bundle',
    });
    expect(groups.map((g) => g.outDir).sort()).toEqual(['bundleA', 'bundleB']);
    const a = groups.find((g) => g.outDir === 'bundleA')!;
    expect(a.regions.map((r) => r.name)).toContain('deep/x0'); // relative to the bundle root
  });
});

describe('file→region collision surfacing', () => {
  it('surfaces two distinct files that strip to the same region name', () => {
    const images = [
      img('hero/items/sword.png'),
      img('hero/items/sword.webp'), // same stem → collision
      img('hero/body.png'),
    ];
    const { groups, collisions } = groupLooseForPacking(images, [skelJson('hero/hero.json')], {
      thresholds: DEFAULTS,
      forced: true,
    });
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.name).toBe('items/sword');
    expect(collisions[0]!.refs).toEqual(['hero/items/sword.png', 'hero/items/sword.webp']);
    // The region survives once (the first ref, sorted); never both, never zero.
    const names = groups[0]!.regions.map((r) => r.name);
    expect(names.filter((n) => n === 'items/sword')).toHaveLength(1);
    const kept = groups[0]!.regions.find((r) => r.name === 'items/sword')!;
    expect(kept.ref).toBe('hero/items/sword.png');
  });

  it('does NOT report a collision when refs are genuinely distinct names', () => {
    const images = Array.from({ length: 8 }, (_, i) => img(`ui/u${i}.png`));
    const { collisions } = groupLooseForPacking(images, [], { thresholds: DEFAULTS });
    expect(collisions).toHaveLength(0);
  });
});

describe('mode + determinism', () => {
  it('force-static ignores skeletons and packs as static', () => {
    const images = Array.from({ length: 8 }, (_, i) => img(`hero/p${i}.png`));
    const { groups } = groupLooseForPacking(images, [skelJson('hero/hero.json')], {
      thresholds: DEFAULTS,
      mode: 'force-static',
    });
    expect(groups[0]!.kind).toBe('static');
  });

  it('force-spine with no detected root makes one spine group at the common ancestor', () => {
    const images = [img('loose/a/x.png'), img('loose/b/y.png')];
    const { groups } = groupLooseForPacking(images, [], {
      thresholds: DEFAULTS,
      mode: 'force-spine',
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('spine');
    expect(groups[0]!.root).toBe('loose');
    expect(groups[0]!.regions.map((r) => r.name).sort()).toEqual(['a/x', 'b/y']);
  });

  it('is order-independent: shuffled input → identical groups', () => {
    const base = [
      img('hero/body.png'),
      img('hero/items/sword.png'),
      ...Array.from({ length: 8 }, (_, i) => img(`ui/hud/i${i}.png`)),
    ];
    const a = groupLooseForPacking(base, [skelJson('hero/hero.json')], {
      thresholds: DEFAULTS,
      forced: true,
    });
    const b = groupLooseForPacking(
      base.slice().reverse(),
      [skelJson('hero/hero.json')],
      { thresholds: DEFAULTS, forced: true },
    );
    expect(b.groups).toEqual(a.groups);
    expect(b.collisions).toEqual(a.collisions);
  });
});
