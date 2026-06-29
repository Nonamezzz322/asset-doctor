// Prebuilt-atlas PASSTHROUGH transcode — PURE repoint round-trip (round20 #1). A prebuilt sheet that is NOT
// being repacked can earn a `format` finding on its PAGE IMAGE → a standalone transcode op. Re-encoding the
// page renames it by extension (sheet.png → sheet.webp), so the sidecar's meta.image (TP) / Spine texture line
// MUST be repointed at the new page or it DANGLES. repointAtlasImage computes the repointed Atlas; the worker
// re-serializes via emitTexturePackerJson / emitSpineAtlasText. These tests pin the load-bearing contract: the
// repointed ref round-trips back to the NEW page through @asset-doctor/parsers (the real loader resolution),
// across same-dir / cross-dir / cache-busted names, for BOTH TexturePacker and Spine. Node-pure (no canvas).

import { describe, it, expect } from 'vitest';
import type { Atlas } from '@asset-doctor/core';
import { parseAtlasManifest, parseSpineAtlasText } from '@asset-doctor/parsers';
import {
  dirOf,
  normalize,
  relativeImageRef,
  resolveImageRef,
  repointAtlasImage,
  emitTexturePackerJson,
  emitSpineAtlasText,
} from '../src/index';

/** A minimal well-formed atlas (one frame); only imageRef is repointed on a passthrough transcode. */
const atlasWith = (imageRef: string, source: Atlas['source']): Atlas => ({
  name: 'sheet',
  imageRef,
  size: { w: 128, h: 128 },
  source,
  sprites: [
    { name: 'icon', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } },
    { name: 'star', frame: { x: 32, y: 0, w: 16, h: 16 }, rotated: false, trimmed: false, sourceSize: { w: 16, h: 16 } },
  ],
});

describe('repointAtlasImage — TexturePacker meta.image repoint round-trip', () => {
  // Each case: sidecar (.json) path + the NEW page path the transcode emitted. The repointed meta.image,
  // resolved relative to the sidecar's dir (== the parser's resolution), must recover the NEW page exactly.
  const cases = [
    { name: 'same-dir, ext-only change', sidecar: 'main/sheet.json', newPage: 'main/sheet.webp', expectRel: 'sheet.webp' },
    { name: 'root-level', sidecar: 'sheet.json', newPage: 'sheet.avif', expectRel: 'sheet.avif' },
    { name: 'cross-dir (sidecar + page in same nested dir)', sidecar: 'a/b/sheet.json', newPage: 'a/b/sheet.webp', expectRel: 'sheet.webp' },
    { name: 'cache-busted page name', sidecar: 'main/sheet.json', newPage: 'main/sheet.1a2b3c4d.webp', expectRel: 'sheet.1a2b3c4d.webp' },
  ];

  for (const c of cases) {
    it(`${c.name}: emit → parseAtlasManifest → meta.image resolves to the NEW page`, () => {
      const repointed = repointAtlasImage(atlasWith('sheet.png', { kind: 'texturepacker-hash' }), c.sidecar, c.newPage);
      expect(repointed.imageRef).toBe(c.expectRel);
      // matches the manual relativeImageRef call shape the worker mirrors elsewhere
      expect(repointed.imageRef).toBe(relativeImageRef(dirOf(c.sidecar), c.newPage));
      const json = JSON.parse(emitTexturePackerJson(repointed)) as { meta?: { image?: unknown } };
      expect(typeof json.meta?.image).toBe('string');
      const res = parseAtlasManifest(json, {});
      expect(res.ok).toBe(true);
      if (res.ok) {
        // the parsed meta.image, resolved against the sidecar's dir, IS the new page (NOT the old sheet.png)
        expect(resolveImageRef(c.sidecar, res.atlas.imageRef)).toBe(normalize(c.newPage));
        expect(resolveImageRef(c.sidecar, res.atlas.imageRef)).not.toBe('main/sheet.png');
      }
    });
  }

  it('preserves every frame verbatim (no geometry loss on a passthrough transcode)', () => {
    const src = atlasWith('sheet.png', { kind: 'texturepacker-hash' });
    const repointed = repointAtlasImage(src, 'main/sheet.json', 'main/sheet.webp');
    const json = JSON.parse(emitTexturePackerJson(repointed)) as { frames: Record<string, { frame: { w: number; h: number } }> };
    expect(Object.keys(json.frames).sort()).toEqual(['icon', 'star']);
    expect(json.frames.icon!.frame).toEqual({ x: 0, y: 0, w: 32, h: 32 });
    expect(json.frames.star!.frame).toEqual({ x: 32, y: 0, w: 16, h: 16 });
  });
});

describe('repointAtlasImage — Spine .atlas texture-line repoint round-trip', () => {
  it('emit → parseSpineAtlasText → page image line is the NEW page', () => {
    const src = atlasWith('sheet.png', { kind: 'spine' });
    const repointed = repointAtlasImage(src, 'spine/sheet.atlas', 'spine/sheet.webp');
    expect(repointed.imageRef).toBe('sheet.webp');
    const pages = parseSpineAtlasText(emitSpineAtlasText(repointed));
    expect(pages.length).toBe(1);
    expect(pages[0]!.image).toBe('sheet.webp');
    // resolved against the .atlas dir, the texture line points at the NEW page, never the old sheet.png
    expect(resolveImageRef('spine/sheet.atlas', pages[0]!.image)).toBe('spine/sheet.webp');
    expect(resolveImageRef('spine/sheet.atlas', pages[0]!.image)).not.toBe('spine/sheet.png');
  });
});

describe('no-dangling-reference invariant (the bug this closes)', () => {
  // Simulate the worker's emitted output set {emittedPage, emittedSidecar} for a passthrough transcode and
  // assert the sidecar resolves ONLY to a member of that set — never the dropped original page.
  it('TexturePacker: the emitted sidecar resolves to an emitted page (old page is gone)', () => {
    const sidecar = 'main/sheet.json';
    const oldPage = 'main/sheet.png';
    const newPage = 'main/sheet.webp';
    const repointed = repointAtlasImage(atlasWith('sheet.png', { kind: 'texturepacker-hash' }), sidecar, newPage);
    const emittedSet = new Set([newPage, sidecar]); // what out.push would contain (oldPage is in `replaced`)
    const json = JSON.parse(emitTexturePackerJson(repointed)) as object;
    const res = parseAtlasManifest(json, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      const resolved = resolveImageRef(sidecar, res.atlas.imageRef);
      expect(emittedSet.has(resolved)).toBe(true); // the page it references EXISTS in the output
      expect(resolved).not.toBe(oldPage); // the dropped original is NOT referenced
    }
  });

  it('Spine: the emitted .atlas resolves to an emitted page (old page is gone)', () => {
    const sidecar = 'spine/sheet.atlas';
    const oldPage = 'spine/sheet.png';
    const newPage = 'spine/sheet.avif';
    const repointed = repointAtlasImage(atlasWith('sheet.png', { kind: 'spine' }), sidecar, newPage);
    const emittedSet = new Set([newPage, sidecar]);
    const pages = parseSpineAtlasText(emitSpineAtlasText(repointed));
    const resolved = resolveImageRef(sidecar, pages[0]!.image);
    expect(emittedSet.has(resolved)).toBe(true);
    expect(resolved).not.toBe(oldPage);
  });
});
