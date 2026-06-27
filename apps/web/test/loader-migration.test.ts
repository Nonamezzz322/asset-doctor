// Pure unit test for the LOADER-MIGRATION guide builders + engine-aware snippet generator
// (apps/web/src/lib/loader-migration.ts; docs/improvements/loader-migration.md design §4 + B4/M5).
//
// This is the ONLY way to test the logic: fix.worker.ts records changes[] via these SAME constructors but
// uses createImageBitmap/OffscreenCanvas, so it CANNOT run in Node (mirrors dedup-worker-phase-c.test.ts).
// We drive the pure helpers DIRECTLY with fixture inputs — single source of truth shared with the worker.
//
// Asserts: set→set fan-in (merge/pack), the tier ladder (atlas→manifest-set vs loose→image-set), the loose
// rename row, the bare drop (to:[]), finalizeChanges ordering+dedup determinism, and the EXACT Pixi/Phaser
// snippet bodies (one load per NEW manifest deduped, old refs as `// was:` comments, key sanitization, Spine
// plugin honesty comment, removals carry no load line) — verbatim CODE, never i18n.

import { describe, it, expect } from 'vitest';
import {
  mergeChanges,
  packChanges,
  tierChanges,
  looseRenameChange,
  dropChange,
  finalizeChanges,
  migrationSnippet,
} from '../src/lib/loader-migration';

describe('loader-migration builders (set→set, honest real paths)', () => {
  it('mergeChanges: every old atlas manifest → the FULL new manifest set (B2, never 1:1)', () => {
    const rows = mergeChanges(['ui/a.json', 'ui/b.json'], ['ui/atlas-merged.json', 'ui/atlas-merged-1.json']);
    expect(rows).toEqual([
      { from: 'ui/a.json', to: ['ui/atlas-merged.json', 'ui/atlas-merged-1.json'], kind: 'merge' },
      { from: 'ui/b.json', to: ['ui/atlas-merged.json', 'ui/atlas-merged-1.json'], kind: 'merge' },
    ]);
  });

  it('mergeChanges: REAL page images thread into a manifest→image map (B-honesty: no fabricated .png)', () => {
    const rows = mergeChanges(
      ['ui/a.json', 'ui/b.json'],
      ['ui/atlas-merged.json', 'ui/atlas-merged-1.json'],
      ['ui/atlas-merged.webp', 'ui/atlas-merged-1.webp'],
    );
    expect(rows).toEqual([
      {
        from: 'ui/a.json',
        to: ['ui/atlas-merged.json', 'ui/atlas-merged-1.json'],
        pageImages: { 'ui/atlas-merged.json': 'ui/atlas-merged.webp', 'ui/atlas-merged-1.json': 'ui/atlas-merged-1.webp' },
        kind: 'merge',
      },
      {
        from: 'ui/b.json',
        to: ['ui/atlas-merged.json', 'ui/atlas-merged-1.json'],
        pageImages: { 'ui/atlas-merged.json': 'ui/atlas-merged.webp', 'ui/atlas-merged-1.json': 'ui/atlas-merged-1.webp' },
        kind: 'merge',
      },
    ]);
  });

  it('packChanges: a Spine .atlas entry carries NO page image (only static .json maps)', () => {
    const rows = packChanges(['hero/idle.png'], ['hero/hero.atlas'], ['']);
    // '.atlas' is not a static TexturePacker .json ⇒ no pageImages map at all.
    expect(rows).toEqual([{ from: 'hero/idle.png', to: ['hero/hero.atlas'], kind: 'pack' }]);
  });

  it('packChanges: every packed loose file → the new sheet manifest set', () => {
    const rows = packChanges(['icons/a.png', 'icons/b.png', 'icons/c.png'], ['icons/icons.json']);
    expect(rows).toEqual([
      { from: 'icons/a.png', to: ['icons/icons.json'], kind: 'pack' },
      { from: 'icons/b.png', to: ['icons/icons.json'], kind: 'pack' },
      { from: 'icons/c.png', to: ['icons/icons.json'], kind: 'pack' },
    ]);
  });

  it('packChanges to a Spine .atlas (pack-spine): loose files → the .atlas manifest', () => {
    const rows = packChanges(['hero/idle.png', 'hero/run.png'], ['hero/hero.atlas']);
    expect(rows).toEqual([
      { from: 'hero/idle.png', to: ['hero/hero.atlas'], kind: 'pack' },
      { from: 'hero/run.png', to: ['hero/hero.atlas'], kind: 'pack' },
    ]);
  });

  it('tierChanges (atlas/spine): source MANIFEST → the manifest tier set (B3)', () => {
    const rows = tierChanges('ui/bar.json', ['ui/bar_1080p.json', 'ui/bar_540p.json']);
    expect(rows).toEqual([
      { from: 'ui/bar.json', to: ['ui/bar_1080p.json', 'ui/bar_540p.json'], kind: 'tier' },
    ]);
  });

  it('tierChanges (loose): source IMAGE → the image tier set (B3)', () => {
    const rows = tierChanges('bg/sky.png', ['bg/sky_1080p.webp', 'bg/sky_540p.webp']);
    expect(rows).toEqual([
      { from: 'bg/sky.png', to: ['bg/sky_1080p.webp', 'bg/sky_540p.webp'], kind: 'tier' },
    ]);
  });

  it('looseRenameChange: a single 1:1 rename row (resize/transcode)', () => {
    expect(looseRenameChange('logo.png', 'logo.webp', 'transcode')).toEqual({
      from: 'logo.png',
      to: ['logo.webp'],
      kind: 'transcode',
    });
    expect(looseRenameChange('hero/big.png', 'hero/big.webp', 'resize')).toEqual({
      from: 'hero/big.png',
      to: ['hero/big.webp'],
      kind: 'resize',
    });
  });

  it('dropChange: a removal row carries to: [] (no new load target)', () => {
    expect(dropChange('old/dup.png')).toEqual({ from: 'old/dup.png', to: [], kind: 'drop' });
  });

  it('empty inputs produce no rows', () => {
    expect(mergeChanges([], ['x.json'])).toEqual([]);
    expect(packChanges([], ['x.json'])).toEqual([]);
  });
});

describe('finalizeChanges (deterministic ordering + dedup)', () => {
  it('sorts by OP_KIND_ORDER, then from, then to.join; collapses exact duplicates', () => {
    const a = looseRenameChange('z.png', 'z.webp', 'transcode'); // transcode (earlier in order)
    const b = mergeChanges(['m/b.json', 'm/a.json'], ['m/out.json']); // merge, two froms
    const c = dropChange('d.png'); // drop
    const dup = mergeChanges(['m/a.json'], ['m/out.json']); // exact dup of one b row
    const out = finalizeChanges([...b, c, a, ...dup]);
    expect(out).toEqual([
      { from: 'z.png', to: ['z.webp'], kind: 'transcode' },
      { from: 'd.png', to: [], kind: 'drop' },
      { from: 'm/a.json', to: ['m/out.json'], kind: 'merge' },
      { from: 'm/b.json', to: ['m/out.json'], kind: 'merge' },
    ]);
  });

  it('same input ⇒ deep-equal output (pure / order-independent)', () => {
    const rows = [...packChanges(['b.png', 'a.png'], ['s.json']), dropChange('x.png')];
    const shuffled = [rows[2]!, rows[0]!, rows[1]!];
    expect(finalizeChanges(rows)).toEqual(finalizeChanges(shuffled));
  });
});

describe('migrationSnippet — Pixi v8 (verbatim CODE, never i18n)', () => {
  it('multi-page merge: one Assets.load per NEW manifest, deduped, old refs as // was:', () => {
    const changes = mergeChanges(['ui/a.json', 'ui/b.json'], ['ui/atlas-merged.json', 'ui/atlas-merged-1.json']);
    // Targets are ordered by url: 'ui/atlas-merged-1.json' sorts BEFORE 'ui/atlas-merged.json' ('-' < '.').
    expect(migrationSnippet(changes, 'pixi')).toBe(
      [
        'import { Assets } from "pixi.js";',
        '',
        '// was: ui/a.json',
        '// was: ui/b.json',
        'const atlas_merged_1 = await Assets.load("ui/atlas-merged-1.json");',
        '',
        '// was: ui/a.json',
        '// was: ui/b.json',
        'const atlas_merged = await Assets.load("ui/atlas-merged.json");',
      ].join('\n'),
    );
  });

  it('loose rename: a single image load line with the old ref commented', () => {
    expect(migrationSnippet([looseRenameChange('logo.png', 'logo.webp', 'transcode')], 'pixi')).toBe(
      ['import { Assets } from "pixi.js";', '', '// was: logo.png', 'const logo = await Assets.load("logo.webp");'].join('\n'),
    );
  });

  it('pack into a Spine .atlas: plugin honesty comment + atlas load', () => {
    const changes = packChanges(['hero/idle.png', 'hero/run.png'], ['hero/hero.atlas']);
    expect(migrationSnippet(changes, 'pixi')).toBe(
      [
        'import { Assets } from "pixi.js";',
        '',
        '// was: hero/idle.png',
        '// was: hero/run.png',
        '// requires @esotericsoftware/spine-pixi-v8 (registers the .atlas loader)',
        'const hero = await Assets.load("hero/hero.atlas");',
      ].join('\n'),
    );
  });

  it('removal-only changes ⇒ empty snippet (UI hides the code block)', () => {
    expect(migrationSnippet([dropChange('old/dup.png')], 'pixi')).toBe('');
  });

  it('empty changes ⇒ empty snippet', () => {
    expect(migrationSnippet([], 'pixi')).toBe('');
  });
});

describe('migrationSnippet — Phaser 3 (verbatim CODE, never i18n)', () => {
  it('multi-page merge: this.load.atlas(key, REAL page image, atlasURL) per NEW manifest in preload()', () => {
    // The worker writes lossless WebP pages, so the textureURL MUST be the real `.webp` on disk (the manifest's
    // meta.image), NEVER an ext-swapped `.png` guess (invariant 3: from/to are real paths the loader will call).
    const changes = mergeChanges(
      ['ui/a.json', 'ui/b.json'],
      ['ui/atlas-merged.json', 'ui/atlas-merged-1.json'],
      ['ui/atlas-merged.webp', 'ui/atlas-merged-1.webp'],
    );
    // Targets ordered by url: 'ui/atlas-merged-1.json' before 'ui/atlas-merged.json' ('-' < '.').
    expect(migrationSnippet(changes, 'phaser')).toBe(
      [
        'function preload() {',
        '  // was: ui/a.json',
        '  // was: ui/b.json',
        '  this.load.atlas("atlas_merged_1", "ui/atlas-merged-1.webp", "ui/atlas-merged-1.json");',
        '  // was: ui/a.json',
        '  // was: ui/b.json',
        '  this.load.atlas("atlas_merged", "ui/atlas-merged.webp", "ui/atlas-merged.json");',
        '}',
      ].join('\n'),
    );
  });

  it('static pack: this.load.atlas uses the REAL emitted page image (e.g. AVIF target → .avif)', () => {
    const changes = packChanges(['icons/a.png', 'icons/b.png'], ['icons/icons.json'], ['icons/icons.avif']);
    expect(migrationSnippet(changes, 'phaser')).toBe(
      [
        'function preload() {',
        '  // was: icons/a.png',
        '  // was: icons/b.png',
        '  this.load.atlas("icons", "icons/icons.avif", "icons/icons.json");',
        '}',
      ].join('\n'),
    );
  });

  it('loose rename: this.load.image(key, url)', () => {
    expect(migrationSnippet([looseRenameChange('logo.png', 'logo.webp', 'transcode')], 'phaser')).toBe(
      ['function preload() {', '  // was: logo.png', '  this.load.image("logo", "logo.webp");', '}'].join('\n'),
    );
  });

  it('loose tier ladder: one image load per tier, source ref commented on each', () => {
    const changes = tierChanges('bg/sky.png', ['bg/sky_1080p.webp', 'bg/sky_540p.webp']);
    expect(migrationSnippet(changes, 'phaser')).toBe(
      [
        'function preload() {',
        '  // was: bg/sky.png',
        '  this.load.image("sky_1080p", "bg/sky_1080p.webp");',
        '  // was: bg/sky.png',
        '  this.load.image("sky_540p", "bg/sky_540p.webp");',
        '}',
      ].join('\n'),
    );
  });

  it('pack into a Spine .atlas: plugin honesty comment', () => {
    const changes = packChanges(['hero/idle.png'], ['hero/hero.atlas']);
    expect(migrationSnippet(changes, 'phaser')).toBe(
      [
        'function preload() {',
        '  // was: hero/idle.png',
        '  // requires the spine-phaser plugin: this.load.spineAtlas / spineJson',
        '  this.load.atlas("hero", "hero/hero.png", "hero/hero.atlas");',
        '}',
      ].join('\n'),
    );
  });
});

describe('migrationSnippet — key sanitization + determinism', () => {
  it('sanitizes a hyphenated/awkward basename into a loader key (ui-bar.json ⇒ ui_bar)', () => {
    expect(migrationSnippet([looseRenameChange('a.png', 'ui-bar.json', 'transcode')], 'pixi')).toContain(
      'const ui_bar = await Assets.load("ui-bar.json");',
    );
  });

  it('leading-digit basename gets an underscore prefix (2x.webp ⇒ _2x)', () => {
    expect(migrationSnippet([looseRenameChange('a.png', '2x.webp', 'resize')], 'pixi')).toContain('const _2x = ');
  });

  it('snippet bodies carry NO i18n brace tokens (generated as code, not via t())', () => {
    const all = [
      ...mergeChanges(['a.json'], ['out.json', 'out-1.json']),
      looseRenameChange('logo.png', 'logo.webp', 'transcode'),
      ...packChanges(['x.png'], ['s.atlas']),
    ];
    for (const engine of ['pixi', 'phaser'] as const) {
      const snip = migrationSnippet(all, engine);
      expect(snip).not.toMatch(/\{[a-zA-Z]/); // no `{key}`-style i18n placeholder
    }
  });

  it('deterministic: same changes ⇒ byte-identical snippet (both engines)', () => {
    const changes = mergeChanges(['b.json', 'a.json'], ['m.json', 'm-1.json']);
    expect(migrationSnippet(changes, 'pixi')).toBe(migrationSnippet(changes, 'pixi'));
    expect(migrationSnippet(changes, 'phaser')).toBe(migrationSnippet(changes, 'phaser'));
  });
});
