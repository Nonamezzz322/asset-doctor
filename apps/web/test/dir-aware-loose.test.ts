import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Asset, ImageFeatures } from '@asset-doctor/core';
import { parseImage } from '@asset-doctor/parsers';
import { analyze } from '@asset-doctor/analysis';
import { groupFiles, keyOf, type RawFile } from '../src/lib/group';

// PRE-DEDUP regression for the dir-aware loose-ref refactor (Task 1): two DIFFERENT loose images that
// share a basename ("sprite.png") in two different folders must survive as TWO distinct, correctly-byted,
// individually-selectable assets. Before dir-aware keying both keyed on the bare basename, so the second
// silently overwrote the first in the bytes map / fileMap / features — one asset, wrong bytes for the other.
// This mirrors the worker pipeline headlessly: group → parse (dir-aware keyOf) → SHA features → analyze,
// plus the App's fileMap (keyed by keyOf) + selection-by-asset-ref path.

const SINGLE = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/sample-projects/single-images');
const bytesOf = (name: string): ArrayBuffer => new Uint8Array(readFileSync(join(SINGLE, name))).buffer;
const sha = (b: ArrayBuffer): string => createHash('sha256').update(Buffer.from(b)).digest('hex');

describe('dir-aware loose refs (Task 1 regression)', () => {
  it('two same-basename loose images in different folders → two distinct, byte-correct, selectable assets', async () => {
    // Two genuinely different images, both presented as "sprite.png" but under different folders.
    const aBytes = bytesOf('hero.png');
    const bBytes = bytesOf('icon.png');
    expect(sha(aBytes)).not.toBe(sha(bBytes)); // sanity: genuinely different source content

    const files: RawFile[] = [
      { name: 'sprite.png', path: 'a/sprite.png', bytes: aBytes },
      { name: 'sprite.png', path: 'b/sprite.png', bytes: bBytes },
    ];

    // ── ingest grouping keys loose images dir-aware (keyOf) — two distinct entries, not one ──
    const grouped = groupFiles(files);
    expect(grouped.images).toHaveLength(2);
    expect(grouped.images.map(keyOf).sort()).toEqual(['a/sprite.png', 'b/sprite.png']);

    // ── worker pipeline: parse with the dir-aware ref + build the App fileMap (keyed by keyOf) ──
    const assets: Asset[] = [];
    const features: ImageFeatures[] = [];
    const fileMap = new Map<string, ArrayBuffer>(); // == App.tsx fileMap (keyOf → bytes)
    for (const im of grouped.images) {
      const ref = keyOf(im);
      fileMap.set(ref, im.bytes);
      const r = parseImage(ref, new Uint8Array(im.bytes));
      if (!r.ok || r.asset.kind !== 'image') throw new Error(`parse failed: ${ref}`);
      assets.push(r.asset);
      features.push({ assetRef: ref, contentHash: sha(im.bytes) });
    }

    const report = await analyze(assets, undefined, { features });

    // Two distinct assets with dir-aware refs (no collision into one).
    expect(report.assets.map((a) => a.assetRef).sort()).toEqual(['a/sprite.png', 'b/sprite.png']);
    // Different content ⇒ NOT collapsed as exact duplicates (they genuinely coexist).
    expect(report.findings.some((f) => f.rule === 'duplicate-exact')).toBe(false);

    // Each asset is independently selectable AND resolves to its OWN bytes via the fileMap (the App's
    // select-by-ref → fileMap.get(ref) → FilmViewer path). The pre-fix bug returned the same bytes for both.
    for (const [ref, want] of [
      ['a/sprite.png', aBytes],
      ['b/sprite.png', bBytes],
    ] as const) {
      expect(report.assets.find((a) => a.assetRef === ref)).toBeDefined();
      const got = fileMap.get(ref);
      expect(got).toBeDefined();
      expect(sha(got!)).toBe(sha(want)); // correct, non-overwritten bytes for this exact asset
    }
    // And the two selections resolve to DIFFERENT bytes (proves no silent overwrite).
    expect(sha(fileMap.get('a/sprite.png')!)).not.toBe(sha(fileMap.get('b/sprite.png')!));
  });
});
