import { describe, it, expect } from 'vitest';
import type { Asset, Finding, ImageMime } from '@asset-doctor/core';
import { formatSiblingGroups, redundantFormatRefs } from '../src/index';

// ── builders ────────────────────────────────────────────────────────────────────────────────────
const img = (name: string, w: number, h: number, mime: ImageMime): Asset => ({
  kind: 'image',
  image: { name, imageRef: name, size: { w, h }, mime, byteSize: 10000 },
});

/** A minimal `format` finding carrying only what redundantFormatRefs reads (assetRef + params.bestMime). */
const fmt = (ref: string, bestMime: ImageMime): Finding => ({
  id: `${ref}:format`,
  rule: 'format',
  severity: 'warn',
  assetRef: ref,
  title: '',
  detail: '',
  params: { bestMime },
});

const refsOf = (groups: { members: { ref: string }[] }[]): string[][] =>
  groups.map((g) => g.members.map((m) => m.ref));

describe('formatSiblingGroups — clustering (§2.1 matrix)', () => {
  it('suppress: icon.png + icon.avif same dims ⇒ one group of both', () => {
    const groups = formatSiblingGroups([img('icon.png', 64, 64, 'image/png'), img('icon.avif', 64, 64, 'image/avif')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.stem).toBe('icon');
    expect(groups[0]!.members.map((m) => m.ref)).toEqual(['icon.avif', 'icon.png']); // sorted by ref
  });

  it('keep (res tiers): hero_540p.png + hero_1080p.png ⇒ NO group (both carry a resolution token)', () => {
    const groups = formatSiblingGroups([
      img('hero_540p.png', 960, 540, 'image/png'),
      img('hero_1080p.png', 1920, 1080, 'image/png'),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('false-cluster: icon_blue.png + icon_red.png ⇒ NO group (distinct stems; stemOf peels only fmt/res)', () => {
    // Both PNG anyway — but the point is the stems differ (icon_blue ≠ icon_red), so no cluster forms.
    const groups = formatSiblingGroups([
      img('icon_blue.png', 64, 64, 'image/png'),
      img('icon_red.png', 64, 64, 'image/png'),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('different dims: a.png 100×50 + a.webp 50×100 ⇒ NO group (exact-dims sub-bucket splits them)', () => {
    const groups = formatSiblingGroups([img('a.png', 100, 50, 'image/png'), img('a.webp', 50, 100, 'image/webp')]);
    expect(groups).toHaveLength(0);
  });

  it('same stem + same dims but ONE mime ⇒ NO group (needs ≥2 distinct mimes)', () => {
    const groups = formatSiblingGroups([img('dup.png', 64, 64, 'image/png'), img('dup.png', 64, 64, 'image/png')]);
    expect(groups).toHaveLength(0);
  });

  it('≥3 formats: x.png + x.webp + x.avif ⇒ one group of all three (sorted)', () => {
    const groups = formatSiblingGroups([
      img('x.webp', 64, 64, 'image/webp'),
      img('x.avif', 64, 64, 'image/avif'),
      img('x.png', 64, 64, 'image/png'),
    ]);
    expect(refsOf(groups)).toEqual([['x.avif', 'x.png', 'x.webp']]);
  });

  it('dir-aware stems keep same-basename files in different folders distinct', () => {
    const groups = formatSiblingGroups([
      img('ui/icon.png', 64, 64, 'image/png'),
      img('ui/icon.avif', 64, 64, 'image/avif'),
      img('hud/icon.png', 64, 64, 'image/png'),
      img('hud/icon.webp', 64, 64, 'image/webp'),
    ]);
    expect(refsOf(groups)).toEqual([
      ['hud/icon.png', 'hud/icon.webp'],
      ['ui/icon.avif', 'ui/icon.png'],
    ]); // groups deterministically ordered by stem
  });
});

describe('redundantFormatRefs — the demotion decision (§2.1 matrix)', () => {
  it('suppress: cluster {png,avif}; icon.png bestMime=avif ⇒ redundant {icon.png}', () => {
    const assets = [img('icon.png', 64, 64, 'image/png'), img('icon.avif', 64, 64, 'image/avif')];
    const redundant = redundantFormatRefs(assets, [fmt('icon.png', 'image/avif')]);
    expect([...redundant]).toEqual(['icon.png']);
  });

  it('keep (no better sibling): cluster {png,webp}; icon.png bestMime=avif ⇒ ∅ (avif ∉ cluster)', () => {
    const assets = [img('icon.png', 64, 64, 'image/png'), img('icon.webp', 64, 64, 'image/webp')];
    const redundant = redundantFormatRefs(assets, [fmt('icon.png', 'image/avif')]);
    expect(redundant.size).toBe(0);
  });

  it('keep (webp target present): cluster {png,webp}; icon.png bestMime=webp ⇒ redundant {icon.png}', () => {
    const assets = [img('icon.png', 64, 64, 'image/png'), img('icon.webp', 64, 64, 'image/webp')];
    const redundant = redundantFormatRefs(assets, [fmt('icon.png', 'image/webp')]);
    expect([...redundant]).toEqual(['icon.png']);
  });

  it('≥3 formats: png+webp+avif; png bestMime=avif AND webp bestMime=avif ⇒ both redundant', () => {
    const assets = [
      img('x.png', 64, 64, 'image/png'),
      img('x.webp', 64, 64, 'image/webp'),
      img('x.avif', 64, 64, 'image/avif'),
    ];
    const redundant = redundantFormatRefs(assets, [fmt('x.png', 'image/avif'), fmt('x.webp', 'image/avif')]);
    expect([...redundant].sort()).toEqual(['x.png', 'x.webp']);
  });

  it('res-tier pair never marks: hero_1080p.png + hero_1080p.avif (same dims) ⇒ ∅ (token-excluded)', () => {
    const assets = [
      img('hero_1080p.png', 1920, 1080, 'image/png'),
      img('hero_1080p.avif', 1920, 1080, 'image/avif'),
    ];
    const redundant = redundantFormatRefs(assets, [fmt('hero_1080p.png', 'image/avif')]);
    expect(redundant.size).toBe(0);
  });

  it('no bestMime param ⇒ never marked', () => {
    const assets = [img('icon.png', 64, 64, 'image/png'), img('icon.avif', 64, 64, 'image/avif')];
    const noBest: Finding = { id: 'icon.png:format', rule: 'format', severity: 'warn', assetRef: 'icon.png', title: '', detail: '', params: {} };
    expect(redundantFormatRefs(assets, [noBest]).size).toBe(0);
  });
});
