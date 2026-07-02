import { describe, it, expect } from 'vitest';
import type { Asset, ImageMime } from '@asset-doctor/core';
import { analyze } from '../src/index';

// ── builders ────────────────────────────────────────────────────────────────────────────────────
const img = (name: string, w: number, h: number, mime: ImageMime, byteSize = 10000): Asset => ({
  kind: 'image',
  image: { name, imageRef: name, size: { w, h }, mime, byteSize },
});

// Encoder that makes AVIF the smallest → a PNG source's format finding measures bestMime = image/avif.
const encodeAvifSmallest = async (_ref: string, _src: ImageMime, target: ImageMime): Promise<number> =>
  target === 'image/avif' ? 4000 : 5000;

const formatFor = (report: Awaited<ReturnType<typeof analyze>>, ref: string) =>
  report.findings.find((f) => f.rule === 'format' && f.assetRef === ref);

describe('analyze — redundantSibling demotion marker (§2.4)', () => {
  it('fires the marker on icon.png when icon.avif already ships the recommended format', async () => {
    const report = await analyze([img('icon.png', 64, 64, 'image/png'), img('icon.avif', 64, 64, 'image/avif')], undefined, {
      encodeImage: encodeAvifSmallest,
    });
    const png = formatFor(report, 'icon.png')!;
    expect(png).toBeTruthy();
    expect(png.params?.bestMime).toBe('image/avif');
    expect(png.params?.redundantSibling).toBe(1);
  });

  it('the marker changes NOTHING measured — estimate + potentialDiskSaved byte-identical vs a no-sibling run', async () => {
    const withSibling = await analyze([img('icon.png', 64, 64, 'image/png'), img('icon.avif', 64, 64, 'image/avif')], undefined, {
      encodeImage: encodeAvifSmallest,
    });
    const withoutSibling = await analyze([img('icon.png', 64, 64, 'image/png')], undefined, {
      encodeImage: encodeAvifSmallest,
    });

    const a = formatFor(withSibling, 'icon.png')!;
    const b = formatFor(withoutSibling, 'icon.png')!;

    // The saving the finding claims is untouched by the marker.
    expect(a.estimate?.diskBytesSaved).toBe(b.estimate?.diskBytesSaved);
    expect(a.estimate?.diskBytesSaved).toBe(10000 - 4000);
    // The aggregate headline saving is untouched (icon.avif contributes no saving of its own).
    expect(withSibling.totals.potentialDiskSaved).toBe(withoutSibling.totals.potentialDiskSaved);
    // Only the demotion metadata differs.
    expect(a.params?.redundantSibling).toBe(1);
    expect(b.params?.redundantSibling).toBeUndefined();
  });

  it('res-tier pair (hero_1080p.png + hero_1080p.avif) ⇒ NO marker (token-excluded)', async () => {
    const report = await analyze(
      [img('hero_1080p.png', 1920, 1080, 'image/png'), img('hero_1080p.avif', 1920, 1080, 'image/avif')],
      undefined,
      { encodeImage: encodeAvifSmallest },
    );
    const png = formatFor(report, 'hero_1080p.png')!;
    expect(png).toBeTruthy();
    expect(png.params?.redundantSibling).toBeUndefined();
  });

  it('CLI-shaped run (no encodeImage) ⇒ no format findings ⇒ no marker anywhere (byte-identical guard)', async () => {
    const report = await analyze([img('icon.png', 64, 64, 'image/png'), img('icon.avif', 64, 64, 'image/avif')]);
    expect(report.findings.some((f) => f.rule === 'format')).toBe(false);
    expect(report.findings.every((f) => f.params?.redundantSibling === undefined)).toBe(true);
  });
});
