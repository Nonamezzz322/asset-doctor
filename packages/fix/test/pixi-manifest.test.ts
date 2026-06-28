// PURE PixiJS-v8 AssetsManifest builder tests (round8-pixi-manifest.md §10, T1–T14). No worker /
// OffscreenCanvas harness exists, so the builder DECISION — what the emitted manifest looks like for a set of
// RECORDED variants (the facts the worker has at its out.push sites) — is proven here. The builder consumes
// the worker's recorded post-fallback paths VERBATIM; these tests feed names exactly as scale.ts helpers
// (tieredName / variantManifestName) produce them, then assert the structural + correctness invariants.
//
// Load-bearing claims under test:
//   - Schema is EXACTLY { bundles:[{name,assets:[{alias,src}]}] } — NO version/meta, NO `data` (B1 regression).
//   - Multi-resolution tiers ⇒ ONE alias-suffixed entry PER tier (NOT a single @Nx src array).
//   - Sheets (atlas/spine) list the .json/.atlas SIDECAR; loose lists the image.
//   - Deterministic + insertion-order-independent (build from shuffled input ⇒ identical string).
//   - Bundle-wide alias-collision guard drops the later basename shortcut, keeps the unique full-path alias.
//
// ADDITIVITY (off ⇒ zip byte-identical) is enforced by WORKER code structure (collector unallocated when off;
// emit gated on size>0) and verified MANUALLY — see the footer note. The builder itself is never reached when
// the toggle is off.

import { describe, expect, it } from 'vitest';
import {
  buildPixiManifest,
  countPixiManifestEntries,
  hashedName,
  variantManifestName,
} from '../src/index';
import type { EmittedVariant, ManifestAsset, PixiAssetsManifest } from '../src/index';

/** Parse the builder output back into the typed shape for structural assertions. */
function parse(json: string): PixiAssetsManifest {
  return JSON.parse(json) as PixiAssetsManifest;
}

/** The single bundle's asset entries (the builder emits exactly one 'default' bundle in v1). */
function entriesOf(json: string) {
  const m = parse(json);
  expect(m.bundles).toHaveLength(1);
  return m.bundles[0]!.assets;
}

/** Known loadable target extensions — every `src` candidate must point at a real image/sheet kind.
 *  `.ktx2` is the OPT-IN GPU-compressed loose tier (round12); `.ktx2.json` matches the generic `.json` arm. */
const LOADABLE = /\.(avif|webp|png|jpe?g|json|atlas|ktx2)$/i;

/** Structural shape gate reused by T1–T7: a valid PixiAssetsManifest whose every src candidate is loadable
 *  and where NO asset carries a `data` key (B1) — and the top-level is { bundles } ONLY. */
function assertLoadableShape(json: string): void {
  const m = parse(json) as Record<string, unknown>;
  expect(Object.keys(m)).toEqual(['bundles']); // no version/meta/schemaVersion
  for (const b of (m.bundles as PixiAssetsManifest['bundles'])) {
    expect(typeof b.name).toBe('string');
    for (const a of b.assets) {
      expect(Array.isArray(a.alias) && a.alias.length > 0).toBe(true);
      expect(a.alias.every((x) => typeof x === 'string' && x.length > 0)).toBe(true);
      expect(Array.isArray(a.src) && a.src.length > 0).toBe(true);
      expect(a.src.every((s) => typeof s === 'string' && LOADABLE.test(s))).toBe(true);
      expect('data' in (a as Record<string, unknown>)).toBe(false); // B1 — no `data` field at all
    }
  }
}

/** Helper: a single non-tiered variant. */
function v(src: string, scale = 1, suffix = ''): EmittedVariant {
  return { scale, suffix, src };
}

describe('buildPixiManifest — pure PixiJS-v8 manifest builder', () => {
  it('T1: loose single-format → one entry, full+basename alias, no data', () => {
    const assets: ManifestAsset[] = [
      { ref: 'ui/btn.png', kind: 'loose', source: 'ui/btn.png', variants: [v('ui/btn.webp')] },
    ];
    const json = buildPixiManifest(assets);
    assertLoadableShape(json);
    const e = entriesOf(json);
    expect(e).toHaveLength(1);
    expect(e[0]!.alias).toEqual(['ui/btn', 'btn']);
    expect(e[0]!.src).toEqual(['ui/btn.webp']);
    expect('data' in (e[0]! as Record<string, unknown>)).toBe(false);
  });

  it('T2: loose multi-format single tier → one entry, src ordered avif,webp,png (png last), no alias suffix', () => {
    // Feed in a deliberately wrong order — the builder must re-sort by format rank.
    const assets: ManifestAsset[] = [
      {
        ref: 'ui/btn.png',
        kind: 'loose',
        source: 'ui/btn.png',
        variants: [v('ui/btn.png'), v('ui/btn.avif'), v('ui/btn.webp')],
      },
    ];
    const json = buildPixiManifest(assets);
    assertLoadableShape(json);
    const e = entriesOf(json);
    expect(e).toHaveLength(1);
    expect(e[0]!.alias).toEqual(['ui/btn', 'btn']); // single tier ⇒ no suffix
    expect(e[0]!.src).toEqual(['ui/btn.avif', 'ui/btn.webp', 'ui/btn.png']);
  });

  it('T3: loose multi-tier → one entry per tier, alias suffixed, each src = that tier formats, sorted by alias', () => {
    const assets: ManifestAsset[] = [
      {
        ref: 'ui/btn.png',
        kind: 'loose',
        source: 'ui/btn.png',
        variants: [
          { scale: 0.5, suffix: '_540p', src: 'ui/btn_540p.webp' },
          { scale: 0.5, suffix: '_540p', src: 'ui/btn_540p.avif' },
          { scale: 1, suffix: '_1080p', src: 'ui/btn_1080p.webp' },
          { scale: 1, suffix: '_1080p', src: 'ui/btn_1080p.avif' },
        ],
      },
    ];
    const json = buildPixiManifest(assets);
    assertLoadableShape(json);
    const e = entriesOf(json);
    expect(e).toHaveLength(2);
    // Entries sorted by alias[0]: '_1080p' < '_540p' codepoint-wise.
    expect(e[0]!.alias).toEqual(['ui/btn_1080p', 'btn_1080p']);
    expect(e[0]!.src).toEqual(['ui/btn_1080p.avif', 'ui/btn_1080p.webp']);
    expect(e[1]!.alias).toEqual(['ui/btn_540p', 'btn_540p']);
    expect(e[1]!.src).toEqual(['ui/btn_540p.avif', 'ui/btn_540p.webp']);
  });

  it('T4: atlas repack (drop-in) → src = the .json sidecar, image NOT in src, no data', () => {
    // The worker records the MANIFEST path as src for a sheet (Pixi reads meta.image itself).
    const assets: ManifestAsset[] = [
      { ref: 'ui/hud.json', kind: 'atlas', source: 'ui/hud.json', variants: [v('ui/hud.json')] },
    ];
    const json = buildPixiManifest(assets);
    assertLoadableShape(json);
    const e = entriesOf(json);
    expect(e).toHaveLength(1);
    expect(e[0]!.alias).toEqual(['ui/hud', 'hud']);
    expect(e[0]!.src).toEqual(['ui/hud.json']); // the sidecar, NOT the .webp image
    expect(e[0]!.src.some((s) => s.endsWith('.webp') || s.endsWith('.png'))).toBe(false);
  });

  it('T5: multi-resolution atlas → one entry per tier, alias suffixed, src = the tier .json — NO data.resolution (B1)', () => {
    // Names exactly as variantManifestName emits them (multi=true ⇒ format-tokened sidecar).
    const top = variantManifestName('ui/hud.json', '_1080p', 'image/webp', true); // ui/hud_1080p.webp.json
    const half = variantManifestName('ui/hud.json', '_540p', 'image/webp', true); // ui/hud_540p.webp.json
    const assets: ManifestAsset[] = [
      {
        ref: 'ui/hud.json',
        kind: 'atlas',
        source: 'ui/hud.json',
        variants: [
          { scale: 1, suffix: '_1080p', src: top },
          { scale: 0.5, suffix: '_540p', src: half },
        ],
      },
    ];
    const json = buildPixiManifest(assets);
    assertLoadableShape(json);
    const e = entriesOf(json);
    expect(e).toHaveLength(2);
    expect(e[0]!.alias).toEqual(['ui/hud_1080p', 'hud_1080p']);
    expect(e[0]!.src).toEqual([top]);
    expect(e[1]!.alias).toEqual(['ui/hud_540p', 'hud_540p']);
    expect(e[1]!.src).toEqual([half]);
    // B1 REGRESSION: nowhere in the emitted JSON is there a `data` key or a `resolution` field.
    expect(json.includes('"data"')).toBe(false);
    expect(json.includes('"resolution"')).toBe(false);
  });

  it('T6: Spine → src = [.atlas], PNG-only even when a multi-format profile is set, no data', () => {
    // The worker forces PNG for Spine; the builder just records the single .atlas sidecar.
    const assets: ManifestAsset[] = [
      { ref: 'hero/skeleton.atlas', kind: 'spine', source: 'hero/skeleton.atlas', variants: [v('hero/skeleton.atlas')] },
    ];
    const json = buildPixiManifest(assets);
    assertLoadableShape(json);
    const e = entriesOf(json);
    expect(e).toHaveLength(1);
    expect(e[0]!.alias).toEqual(['hero/skeleton', 'skeleton']);
    expect(e[0]!.src).toEqual(['hero/skeleton.atlas']);
    expect(e[0]!.src.every((s) => s.endsWith('.atlas'))).toBe(true);
  });

  it('T7: merged atlas multi-page → one entry per page .json', () => {
    const assets: ManifestAsset[] = [
      { ref: 'atlas-merged.json', kind: 'atlas', source: 'atlas-merged.json', variants: [v('atlas-merged.json')] },
      { ref: 'atlas-merged-1.json', kind: 'atlas', source: 'atlas-merged-1.json', variants: [v('atlas-merged-1.json')] },
    ];
    const json = buildPixiManifest(assets);
    assertLoadableShape(json);
    const e = entriesOf(json);
    expect(e).toHaveLength(2);
    // Root-level refs (no directory) ⇒ full stem == basename stem ⇒ the alias array dedupes to one entry
    // (never a duplicate shortcut). Sorted by alias[0]: 'atlas-merged' < 'atlas-merged-1'.
    expect(e[0]!.alias).toEqual(['atlas-merged']);
    expect(e[0]!.src).toEqual(['atlas-merged.json']);
    expect(e[1]!.alias).toEqual(['atlas-merged-1']);
    expect(e[1]!.src).toEqual(['atlas-merged-1.json']);
  });

  it('T8: alias collision — two btn.png in different dirs ⇒ second drops its basename, all alias[0] unique', () => {
    const assets: ManifestAsset[] = [
      { ref: 'ui/btn.png', kind: 'loose', source: 'ui/btn.png', variants: [v('ui/btn.webp')] },
      { ref: 'hud/btn.png', kind: 'loose', source: 'hud/btn.png', variants: [v('hud/btn.webp')] },
    ];
    const json = buildPixiManifest(assets);
    assertLoadableShape(json);
    const e = entriesOf(json);
    expect(e).toHaveLength(2);
    // Sorted by alias[0]: 'hud/btn' < 'ui/btn'. The FIRST entry keeps the 'btn' shortcut; the later one drops it.
    expect(e[0]!.alias).toEqual(['hud/btn', 'btn']);
    expect(e[1]!.alias).toEqual(['ui/btn']); // basename 'btn' already taken ⇒ unique full-path only
    // Every primary alias is unique; the shortcut 'btn' appears exactly once across the bundle.
    const primaries = e.map((x) => x.alias[0]!);
    expect(new Set(primaries).size).toBe(primaries.length);
    const allAliases = e.flatMap((x) => x.alias);
    expect(allAliases.filter((a) => a === 'btn')).toHaveLength(1);
  });

  it('T9: determinism — build twice ⇒ identical; build from a SHUFFLED input ⇒ identical (total re-sort)', () => {
    const make = (): ManifestAsset[] => [
      { ref: 'b/two.png', kind: 'loose', source: 'b/two.png', variants: [v('b/two.png'), v('b/two.avif'), v('b/two.webp')] },
      { ref: 'a/one.json', kind: 'atlas', source: 'a/one.json', variants: [v('a/one.json')] },
      {
        ref: 'c/tiered.png',
        kind: 'loose',
        source: 'c/tiered.png',
        variants: [
          { scale: 0.5, suffix: '_540p', src: 'c/tiered_540p.webp' },
          { scale: 1, suffix: '_1080p', src: 'c/tiered_1080p.webp' },
        ],
      },
    ];
    const a = buildPixiManifest(make());
    const b = buildPixiManifest(make());
    expect(a).toBe(b);

    // Shuffle the asset order AND each asset's variant order — output must be byte-identical (total sort).
    const shuffled = make().reverse().map((m) => ({ ...m, variants: [...m.variants].reverse() }));
    expect(buildPixiManifest(shuffled)).toBe(a);
  });

  it('T10: single-vs-multi sidecar names — builder consumes variantManifestName output VERBATIM (no re-derivation)', () => {
    const single = variantManifestName('ui/sheet.json', '_540p', 'image/webp', false); // ui/sheet_540p.json
    const multi = variantManifestName('ui/sheet.json', '_540p', 'image/webp', true); // ui/sheet_540p.webp.json
    expect(single).toBe('ui/sheet_540p.json');
    expect(multi).toBe('ui/sheet_540p.webp.json');

    // Single-format sidecar — one tier, builder lists it verbatim.
    const jSingle = buildPixiManifest([
      { ref: 'ui/sheet.json', kind: 'atlas', source: 'ui/sheet.json', variants: [v(single)] },
    ]);
    expect(entriesOf(jSingle)[0]!.src).toEqual([single]);

    // Multi-format sidecar — builder lists the tokened name verbatim too.
    const jMulti = buildPixiManifest([
      { ref: 'ui/sheet.json', kind: 'atlas', source: 'ui/sheet.json', variants: [v(multi)] },
    ]);
    expect(entriesOf(jMulti)[0]!.src).toEqual([multi]);
  });

  it('T11: schema invariant — top-level is EXACTLY { bundles }; each asset is { alias:string[], src:string[] }, no data', () => {
    const json = buildPixiManifest([
      { ref: 'ui/a.png', kind: 'loose', source: 'ui/a.png', variants: [v('ui/a.webp'), v('ui/a.avif')] },
      { ref: 'b.json', kind: 'atlas', source: 'b.json', variants: [v('b.json')] },
    ]);
    const m = parse(json) as Record<string, unknown>;
    expect(Object.keys(m)).toEqual(['bundles']);
    const bundle = (m.bundles as PixiAssetsManifest['bundles'])[0]!;
    expect(Object.keys(bundle)).toEqual(['name', 'assets']); // fixed key order
    for (const a of bundle.assets) {
      expect(Object.keys(a)).toEqual(['alias', 'src']); // exactly alias+src, in that order — no data
    }
    // Pretty-printed (2-space) like emitTexturePackerJson.
    expect(json).toContain('\n  "bundles"');
  });

  it('T12: empty input → { bundles:[{ name:"default", assets:[] }] } (worker skips emit on size===0)', () => {
    const json = buildPixiManifest([]);
    expect(parse(json)).toEqual({ bundles: [{ name: 'default', assets: [] }] });
    // The worker gates the actual zip-entry push on manifestAssets.size > 0, so an empty fix adds nothing
    // (byte-identical) — this asserts the builder itself is well-defined for the empty case.
    expect(countPixiManifestEntries([])).toBe(0);
  });

  it('T13: hashedName purity — shipped + tested though unused in v1', () => {
    expect(hashedName('a/b_540p.webp', 'a1b2c3d4')).toBe('a/b_540p.a1b2c3d4.webp');
    expect(hashedName('btn.png', 'deadbeef')).toBe('btn.deadbeef.png');
    // No extension ⇒ append the hash as the final token.
    expect(hashedName('noext', 'cafe')).toBe('noext.cafe');
    // A dot in a directory but not in the basename ⇒ treated as no-ext (append).
    expect(hashedName('a.b/file', 'feed')).toBe('a.b/file.feed');
  });

  it('T14: B4 src de-dup — duplicate src strings within an asset collapse to one candidate', () => {
    const assets: ManifestAsset[] = [
      {
        ref: 'ui/btn.png',
        kind: 'loose',
        source: 'ui/btn.png',
        // Same-mime fallback could record the identical path twice; the builder de-dups defensively.
        variants: [v('ui/btn.webp'), v('ui/btn.webp'), v('ui/btn.avif')],
      },
    ];
    const e = entriesOf(buildPixiManifest(assets));
    expect(e[0]!.src).toEqual(['ui/btn.avif', 'ui/btn.webp']);
  });

  it('T15 (round12): LOOSE ktx2+raster pair → src is [x.ktx2, x.webp] (ktx2-FIRST), regardless of input order', () => {
    // The worker records a raster `.webp` (drop-in) and an additive `.ktx2` sibling for the SAME ref. The
    // load-bearing claim (fix.worker.ts:2350) is "ktx2-first" so a capable GPU loads the compressed tier.
    const assets: ManifestAsset[] = [
      {
        ref: 'bg/sky.png',
        kind: 'loose',
        source: 'bg/sky.png',
        // Feed raster-first to prove the builder re-sorts ktx2 ahead.
        variants: [v('bg/sky.webp'), v('bg/sky.ktx2')],
      },
    ];
    const json = buildPixiManifest(assets);
    assertLoadableShape(json);
    const e = entriesOf(json);
    expect(e).toHaveLength(1);
    expect(e[0]!.alias).toEqual(['bg/sky', 'sky']);
    expect(e[0]!.src).toEqual(['bg/sky.ktx2', 'bg/sky.webp']); // ktx2 FIRST, raster fallback last
    // Reversed input ⇒ identical (deterministic total re-sort).
    const rev = buildPixiManifest([{ ...assets[0]!, variants: [...assets[0]!.variants].reverse() }]);
    expect(rev).toBe(json);
  });

  it('T16 (round12): ATLAS ktx2 two-sidecar pair → src is [hud.ktx2.json, hud.json] (ktx2-FIRST), regardless of input order', () => {
    // round8 two-sidecar rule: a multi-format atlas needs TWO .json sidecars (NOT a multi-format src array).
    // The worker records the drop-in raster sidecar `ui/hud.json` AND the additive `ui/hud.ktx2.json` (whose
    // meta.image → the .ktx2 page) for the same ref. compareSrc must put the .ktx2.json sidecar first even
    // though BOTH end in `.json` (the plain FORMAT_RANK tie would otherwise lexically sort hud.json first).
    const assets: ManifestAsset[] = [
      {
        ref: 'ui/hud.json',
        kind: 'atlas',
        source: 'ui/hud.json',
        // Feed raster-first to prove the builder re-sorts the ktx2 sidecar ahead.
        variants: [v('ui/hud.json'), v('ui/hud.ktx2.json')],
      },
    ];
    const json = buildPixiManifest(assets);
    assertLoadableShape(json);
    const e = entriesOf(json);
    expect(e).toHaveLength(1);
    expect(e[0]!.alias).toEqual(['ui/hud', 'hud']);
    expect(e[0]!.src).toEqual(['ui/hud.ktx2.json', 'ui/hud.json']); // ktx2 sidecar FIRST, raster sidecar last
    // The image files are NEVER in src (Pixi reads each sidecar's meta.image).
    expect(e[0]!.src.some((s) => s.endsWith('.webp') || s.endsWith('.ktx2'))).toBe(false);
    // Reversed input ⇒ identical (deterministic total re-sort).
    const rev = buildPixiManifest([{ ...assets[0]!, variants: [...assets[0]!.variants].reverse() }]);
    expect(rev).toBe(json);
  });

  it('extra: bundleName option overrides "default"; countPixiManifestEntries matches the emitted entry count', () => {
    const assets: ManifestAsset[] = [
      {
        ref: 'ui/btn.png',
        kind: 'loose',
        source: 'ui/btn.png',
        variants: [
          { scale: 1, suffix: '_1080p', src: 'ui/btn_1080p.webp' },
          { scale: 0.5, suffix: '_540p', src: 'ui/btn_540p.webp' },
        ],
      },
      { ref: 'b.json', kind: 'atlas', source: 'b.json', variants: [v('b.json')] },
    ];
    const json = buildPixiManifest(assets, { bundleName: 'game' });
    expect(parse(json).bundles[0]!.name).toBe('game');
    // 2 tiers for btn + 1 for b = 3; countPixiManifestEntries must equal the real entry count.
    expect(countPixiManifestEntries(assets)).toBe(entriesOf(json).length);
    expect(countPixiManifestEntries(assets)).toBe(3);
  });

  it('extra: mixed loose+atlas+spine — each ref classified independently, all loadable, sorted by alias', () => {
    const assets: ManifestAsset[] = [
      { ref: 'fx/spark.png', kind: 'loose', source: 'fx/spark.png', variants: [v('fx/spark.avif'), v('fx/spark.webp')] },
      { ref: 'ui/hud.json', kind: 'atlas', source: 'ui/hud.json', variants: [v('ui/hud.json')] },
      { ref: 'hero/skel.atlas', kind: 'spine', source: 'hero/skel.atlas', variants: [v('hero/skel.atlas')] },
    ];
    const json = buildPixiManifest(assets);
    assertLoadableShape(json);
    const e = entriesOf(json);
    const primaries = e.map((x) => x.alias[0]!);
    expect(primaries).toEqual([...primaries].sort((a, b) => a.localeCompare(b)));
    expect(primaries).toEqual(['fx/spark', 'hero/skel', 'ui/hud']);
  });
});

// ── ADDITIVITY (off ⇒ zip byte-identical) — MANUAL verification (no worker / OffscreenCanvas harness) ───────
// The builder is NEVER reached when emitPixiManifest is off: the worker's `manifestAssets` map is left
// undefined (recordVariant is a no-op) and the zip-entry push is gated on `manifestAssets.size > 0`. So with
// the toggle OFF, `dedupedOut` is unchanged ⇒ makeZip input is byte-identical ⇒ the zip is byte-identical.
// This is a STRUCTURAL guarantee (additivity by construction); there is no headless worker harness, so the
// byte-identity is confirmed MANUALLY:
//   1. `pnpm dev`, drop fixtures/sample-projects/<folder with loose images + a TexturePacker atlas + Spine>.
//   2. Run the fix with the "Emit PixiJS manifest.json" toggle OFF → download zip A.
//   3. Run again with the toggle ON → download zip B.
//   4. B == A except for the single added manifest.json (every other entry name + bytes identical).
