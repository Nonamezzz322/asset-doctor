// Owner-aware dedup repoint round-trip (design §10.7 / §10.8). The worker's Phase-C repoints a consumer
// atlas manifest's `meta.image` at its OWNER's FINAL image path by writing a path RELATIVE to the consumer
// manifest's own directory (relativeImageRef). The load-bearing contract: that relative ref must resolve
// back to the owner image through @asset-doctor/parsers `parseAtlas` (which reads meta.image) — otherwise
// the repointed atlas dangles. These tests pin relativeImageRef as the exact inverse of resolveImageRef
// (the resolution the parser performs) across same-folder, cross-folder, and root-owner cases, AND drive a
// real emitTexturePackerJson → parseAtlas round-trip so a broken repoint can't pass green.

import { describe, it, expect } from 'vitest';
import type { Atlas } from '@asset-doctor/core';
import { parseAtlasManifest } from '@asset-doctor/parsers';
import { dirOf, normalize, relativeImageRef, resolveImageRef, emitTexturePackerJson } from '../src/index';

describe('relativeImageRef ↔ resolveImageRef (pure path inverse)', () => {
  // Each case: a consumer manifest path + the owner's folder-relative image path. relativeImageRef writes
  // the meta.image; resolveImageRef (== the parser's resolution) must recover the owner image exactly.
  const cases: { name: string; manifest: string; ownerImage: string; expectRel: string }[] = [
    { name: 'cross-folder (owner in a sibling dir)', manifest: 'extra/sheet.json', ownerImage: 'main_game/sheet.png', expectRel: '../main_game/sheet.png' },
    { name: 'same-folder (owner beside the consumer)', manifest: 'main_game/b.json', ownerImage: 'main_game/a.png', expectRel: 'a.png' },
    { name: 'deeper consumer → shallower owner', manifest: 'a/b/c/sheet.json', ownerImage: 'a/owner.png', expectRel: '../../owner.png' },
    { name: 'root-level consumer → nested owner', manifest: 'sheet.json', ownerImage: 'shared/owner.png', expectRel: 'shared/owner.png' },
    { name: 'both at root', manifest: 'sheet.json', ownerImage: 'owner.png', expectRel: 'owner.png' },
  ];

  for (const c of cases) {
    it(`${c.name}: round-trips meta.image back to the owner image`, () => {
      const rel = relativeImageRef(dirOf(c.manifest), c.ownerImage);
      expect(rel).toBe(c.expectRel);
      // The parser resolves meta.image relative to the manifest's own dir → must recover the owner image.
      expect(resolveImageRef(c.manifest, rel)).toBe(normalize(c.ownerImage));
    });
  }
});

describe('meta.image repoint round-trip through @asset-doctor/parsers parseAtlas (§10.7)', () => {
  /** Build a minimal consumer Atlas with one frame (the worker keeps frame rects; only meta.image changes). */
  const consumerAtlas = (imageRef: string): Atlas => ({
    name: 'consumer',
    imageRef,
    size: { w: 64, h: 64 },
    source: { kind: 'texturepacker-hash' },
    sprites: [{ name: 'icon', frame: { x: 0, y: 0, w: 16, h: 16 }, rotated: false, trimmed: false, sourceSize: { w: 16, h: 16 } }],
  });

  // Re-parse the emitted manifest the way the worker output would be re-loaded (no image bytes — the
  // parser takes meta.image as the imageRef). The parsed imageRef, resolved against the manifest dir,
  // must equal the OWNER's image path.
  const cases = [
    { name: 'cross-folder owner', consumerManifest: 'extra/sheet.json', ownerImage: 'main_game/sheet.png' },
    { name: 'same-folder owner', consumerManifest: 'pack/dup.json', ownerImage: 'pack/orig.png' },
    { name: 'root owner', consumerManifest: 'a/b/dup.json', ownerImage: 'orig.png' },
  ];

  for (const c of cases) {
    it(`${c.name}: emit → parseAtlasManifest → meta.image resolves to the owner image`, () => {
      // Phase-C: repoint the consumer's imageRef relative to its OWN manifest dir, then emit.
      const repointed: Atlas = { ...consumerAtlas('dup.png'), imageRef: relativeImageRef(dirOf(c.consumerManifest), c.ownerImage) };
      const json = JSON.parse(emitTexturePackerJson(repointed)) as { meta?: { image?: unknown } };
      expect(typeof json.meta?.image).toBe('string');

      // Re-parse the emitted MANIFEST the way a loader would (meta.image is the imageRef; no image bytes
      // needed — this is the same parseAtlasManifest round-trip the repack golden tests use).
      const res = parseAtlasManifest(json, {});
      expect(res.ok).toBe(true);
      if (res.ok) {
        // The parsed manifest's meta.image, resolved relative to the consumer manifest's dir, IS the owner image.
        expect(resolveImageRef(c.consumerManifest, res.atlas.imageRef)).toBe(normalize(c.ownerImage));
      }
    });
  }

  it('transcoded-owner divergence (§10.8): repoint resolves to the FINAL (renamed) owner image', () => {
    // The owner is transcoded png → webp; Phase-C must point the consumer at the FINAL .webp name.
    const ownerFinal = 'main_game/sheet.webp';
    const repointed: Atlas = { ...consumerAtlas('dup.png'), imageRef: relativeImageRef(dirOf('extra/sheet.json'), ownerFinal) };
    expect(repointed.imageRef).toBe('../main_game/sheet.webp');
    const json = JSON.parse(emitTexturePackerJson(repointed)) as { meta: { image: string } };
    const res = parseAtlasManifest(json, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(resolveImageRef('extra/sheet.json', res.atlas.imageRef)).toBe('main_game/sheet.webp');
    }
  });
});
