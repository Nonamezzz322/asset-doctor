// PURE content-hash cache-busting tests (docs/improvements/round9-cache-busting.md §9, H2–H8). No worker /
// OffscreenCanvas harness exists in Node, so the PURE half of the chain — the reference-repoint + the
// hash-ORDERING that makes a sidecar's bytes depend on the image hash it embeds — is proven here against the
// SAME pure helpers the worker uses (withHashedImageRef mirrors the worker's one in-place imageRef patch;
// emitTexturePackerJson / emitSpineAtlasText are the sidecar emitters; hashedName is the naming primitive;
// buildPixiManifest consumes hashed `src` verbatim).
//
// Load-bearing claims under test (NO BROKEN REFERENCE CHAINS — a hashed file whose referrer still points at the
// old name is a runtime 404, the worst failure):
//   H2 — static atlas: patching imageRef repoints meta.image to the hashed image; frames byte-identical.
//   H3 — Spine: line 0 (the texture line) becomes the hashed PNG; regions unchanged.
//   H4 — ordering is load-bearing: the sidecar hash computed AFTER the imageRef patch ≠ the hash before it.
//   H5 — determinism: identical FINAL bytes ⇒ identical hashedName; same atlas+image twice ⇒ same names.
//   H6 — the PixiJS builder lists the hashed `src` verbatim; the alias still derives from the unhashed ref.
//   H7 — the hashed names the loader-migration rows carry (image rename + sheet manifest→hashed-image map).
//   H8 — hashedName preserves a compound resolution token (variantManifestName '_720p' + format ext).
//
// ADDITIVITY (hashFilenames off ⇒ zip byte-identical to today) is enforced by WORKER code structure (every
// hashing branch short-circuited when off; hashedName / shortHash never called) and is NOT reachable from this
// pure package — see the worker tasks K3–K11. withHashedImageRef is NEVER called by the worker (the worker owns
// the one in-place mutation); it exists solely as this golden test double.

import { describe, expect, it } from 'vitest';
import type { Atlas } from '@asset-doctor/core';
import { parseSpineAtlasText } from '@asset-doctor/parsers';
import {
  buildPixiManifest,
  emitSpineAtlasText,
  emitTexturePackerJson,
  hashedName,
  variantManifestName,
  withHashedImageRef,
  type EmittedVariant,
  type ManifestAsset,
} from '../src/index';

// ── pure WebCrypto sha256 → 8-hex (mirrors the worker's sha256Hex(bytes).slice(0,8); invariant 1: in-browser,
//    no native libs). Node ≥20 exposes the same globalThis.crypto.subtle the worker uses. ──
const HASH_LEN = 8;
async function shortHash(bytes: Uint8Array): Promise<string> {
  const buf =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', buf as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, HASH_LEN);
}
const te = new TextEncoder();

/** A tiny static atlas fixture with two trimmed sprites (frame bytes are what H2 asserts stay identical). */
function staticAtlas(imageRef: string): Atlas {
  return {
    name: 'hud',
    imageRef,
    size: { w: 256, h: 128 },
    format: 'RGBA8888',
    sprites: [
      { name: 'btn', frame: { x: 0, y: 0, w: 40, h: 24 }, rotated: false, trimmed: true, sourceSize: { w: 48, h: 32 }, spriteSourceSize: { x: 4, y: 4, w: 40, h: 24 } },
      { name: 'icon', frame: { x: 48, y: 0, w: 16, h: 16 }, rotated: false, trimmed: false, sourceSize: { w: 16, h: 16 } },
    ],
    source: { kind: 'texturepacker-hash' },
  };
}

/** A tiny Spine atlas fixture (one page, two regions). */
function spineAtlas(imageRef: string): Atlas {
  return {
    name: 'hero',
    imageRef,
    size: { w: 512, h: 256 },
    format: 'RGBA8888',
    sprites: [
      { name: 'head', frame: { x: 0, y: 0, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 } },
      { name: 'torso', frame: { x: 64, y: 0, w: 80, h: 96 }, rotated: false, trimmed: false, sourceSize: { w: 80, h: 96 } },
    ],
    source: { kind: 'spine' },
  };
}

function v(src: string, scale = 1, suffix = ''): EmittedVariant {
  return { scale, suffix, src };
}

describe('withHashedImageRef (pure test-double for the worker imageRef patch)', () => {
  it('returns a NEW atlas with only imageRef replaced; input untouched', () => {
    const original = staticAtlas('hud.webp');
    const patched = withHashedImageRef(original, 'hud.a1b2c3d4.webp');
    expect(patched).not.toBe(original); // fresh object
    expect(original.imageRef).toBe('hud.webp'); // non-destructive — worker mutates in place; helper does not
    expect(patched.imageRef).toBe('hud.a1b2c3d4.webp');
    // every other field carried through unchanged (frames/size/format/source identity preserved)
    expect(patched.sprites).toBe(original.sprites);
    expect(patched.size).toBe(original.size);
    expect(patched.format).toBe(original.format);
    expect(patched.source).toBe(original.source);
  });
});

describe('H2 — static atlas: imageRef patch repoints meta.image only, frames byte-identical', () => {
  it('emitTexturePackerJson(patched) carries the hashed meta.image and otherwise === the unpatched JSON', () => {
    const before = staticAtlas('hud.webp');
    const after = withHashedImageRef(before, 'hud.a1b2c3d4.webp');

    const beforeJson = JSON.parse(emitTexturePackerJson(before)) as { frames: unknown; meta: { image: string } };
    const afterJson = JSON.parse(emitTexturePackerJson(after)) as { frames: unknown; meta: { image: string } };

    expect(beforeJson.meta.image).toBe('hud.webp');
    expect(afterJson.meta.image).toBe('hud.a1b2c3d4.webp'); // referrer now points at the hashed image
    // frames (the geometry the loader uses) are byte-identical — only the referrer changed
    expect(JSON.stringify(afterJson.frames)).toBe(JSON.stringify(beforeJson.frames));
  });
});

describe('H3 — Spine: line 0 (texture line) becomes the hashed PNG, regions unchanged', () => {
  it('emitSpineAtlasText(patched) line 0 = hashed image; the rest of the page === unpatched', () => {
    const before = spineAtlas('hero.png');
    const after = withHashedImageRef(before, 'hero.deadbeef.png');

    const beforeText = emitSpineAtlasText(before);
    const afterText = emitSpineAtlasText(after);

    expect(beforeText.split('\n')[0]).toBe('hero.png');
    expect(afterText.split('\n')[0]).toBe('hero.deadbeef.png'); // texture line repointed

    // everything AFTER line 0 (size/format/filter/repeat + every region block) is identical
    expect(afterText.split('\n').slice(1).join('\n')).toBe(beforeText.split('\n').slice(1).join('\n'));

    // round-trips back through the parser to the same regions (the hashed name is the only delta)
    const page = parseSpineAtlasText(afterText)[0]!;
    expect(page.image).toBe('hero.deadbeef.png'); // the texture line the parser reads back
    expect(page.sprites.map((s) => s.name).sort()).toEqual(['head', 'torso']);
    expect(page.malformedRegions ?? []).toEqual([]);
  });
});

describe('H4 — chain ORDER is load-bearing (sidecar hash depends on the embedded image hash)', () => {
  it('static: hashing the patched .json ≠ hashing the unpatched .json', async () => {
    const before = staticAtlas('hud.webp');
    const after = withHashedImageRef(before, 'hud.a1b2c3d4.webp');
    const hBefore = await shortHash(te.encode(emitTexturePackerJson(before)));
    const hAfter = await shortHash(te.encode(emitTexturePackerJson(after)));
    // because meta.image is embedded in the sidecar, patching imageRef BEFORE emitting changes the bytes ⇒
    // the sidecar's content hash. Emitting the sidecar BEFORE the patch would have hashed the OLD name → 404.
    expect(hAfter).not.toBe(hBefore);
  });

  it('Spine: hashing the patched .atlas ≠ hashing the unpatched .atlas', async () => {
    const before = spineAtlas('hero.png');
    const after = withHashedImageRef(before, 'hero.deadbeef.png');
    const hBefore = await shortHash(te.encode(emitSpineAtlasText(before)));
    const hAfter = await shortHash(te.encode(emitSpineAtlasText(after)));
    expect(hAfter).not.toBe(hBefore);
  });

  it('models the full per-iteration order: image bytes → patch imageRef → emit sidecar → hash sidecar', async () => {
    // 1) image bytes → hash → emitted image name
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]); // stand-in for FINAL emitted png/webp bytes
    const imgHash = await shortHash(imageBytes);
    const emittedImage = hashedName('ui/hud.webp', imgHash); // ui/hud.<hash>.webp
    // 2) patch imageRef to the emitted image's basename (the worker writes a basename into imageRef)
    const basename = emittedImage.split('/').pop()!;
    const patched = withHashedImageRef(staticAtlas('hud.webp'), basename);
    // 3) emit the sidecar — it now embeds the hashed image basename
    const sidecarBytes = te.encode(emitTexturePackerJson(patched));
    expect((JSON.parse(emitTexturePackerJson(patched)) as { meta: { image: string } }).meta.image).toBe(basename);
    // 4) hash the sidecar AFTER the embed → emitted sidecar name
    const sidecarHash = await shortHash(sidecarBytes);
    const emittedSidecar = hashedName('ui/hud.json', sidecarHash);
    expect(emittedSidecar).toMatch(/^ui\/hud\.[0-9a-f]{8}\.json$/);
    // the emitted sidecar references the emitted image that exists — no dangling reference
    expect(basename).toMatch(/^hud\.[0-9a-f]{8}\.webp$/);
  });
});

describe('H5 — determinism (same FINAL bytes ⇒ same names)', () => {
  it('identical bytes ⇒ identical hashedName; same atlas+image twice ⇒ identical emitted names', async () => {
    const bytesA = new Uint8Array([10, 20, 30, 40, 50]);
    const bytesB = new Uint8Array([10, 20, 30, 40, 50]); // distinct buffer, identical content
    const hA = await shortHash(bytesA);
    const hB = await shortHash(bytesB);
    expect(hA).toBe(hB);
    expect(hA).toMatch(/^[0-9a-f]{8}$/);
    expect(hashedName('hud.webp', hA)).toBe(hashedName('hud.webp', hB));

    // full re-run of the chain on the same inputs yields the same image + sidecar names
    const run = async () => {
      const ih = await shortHash(bytesA);
      const emittedImage = hashedName('hud.webp', ih);
      const patched = withHashedImageRef(staticAtlas('hud.webp'), emittedImage.split('/').pop()!);
      const sh = await shortHash(te.encode(emitTexturePackerJson(patched)));
      return { emittedImage, emittedSidecar: hashedName('hud.json', sh) };
    };
    expect(await run()).toEqual(await run());
  });

  it('handles a subarray view (non-zero byteOffset) by slicing the exact bytes', async () => {
    const backing = new Uint8Array([99, 99, 10, 20, 30, 40, 50, 99]);
    const view = backing.subarray(2, 7); // [10,20,30,40,50] at byteOffset 2
    const full = new Uint8Array([10, 20, 30, 40, 50]);
    expect(await shortHash(view)).toBe(await shortHash(full)); // hashes the slice content, not the whole buffer
  });
});

describe('H6 — PixiJS builder lists the hashed src verbatim; alias from the unhashed ref', () => {
  it('a hashed sheet sidecar src is carried through verbatim; aliases stay clean (ref-derived)', () => {
    const assets: ManifestAsset[] = [
      // the worker records the HASHED sidecar path as `src`; the ref is the unhashed dir-aware ingest key
      { ref: 'ui/hud.json', kind: 'atlas', source: 'ui/hud.json', variants: [v('ui/hud.a1b2c3d4.json')] },
      { ref: 'logo.png', kind: 'loose', source: 'logo.png', variants: [v('logo.deadbeef.webp')] },
    ];
    const m = JSON.parse(buildPixiManifest(assets)) as { bundles: { assets: { alias: string[]; src: string[] }[] }[] };
    const entries = m.bundles[0]!.assets;

    const hud = entries.find((e) => e.alias.includes('ui/hud'))!;
    expect(hud.src).toEqual(['ui/hud.a1b2c3d4.json']); // hashed sidecar, verbatim
    expect(hud.alias).toContain('ui/hud'); // alias derived from the UNHASHED ref
    expect(hud.alias).toContain('hud');
    // no hashed token leaked into any alias
    expect(entries.every((e) => e.alias.every((a) => !/[0-9a-f]{8}/.test(a)))).toBe(true);

    const logo = entries.find((e) => e.alias.includes('logo'))!;
    expect(logo.src).toEqual(['logo.deadbeef.webp']);
  });

  it('multi-format hashed candidates of one tier are listed verbatim, format-ranked (avif<webp<png)', () => {
    const assets: ManifestAsset[] = [
      {
        ref: 'ui/hud.json',
        kind: 'atlas',
        source: 'ui/hud.json',
        variants: [v('ui/hud.11111111.png'), v('ui/hud.22222222.avif'), v('ui/hud.33333333.webp')],
      },
    ];
    const entries = (JSON.parse(buildPixiManifest(assets)) as { bundles: { assets: { src: string[] }[] }[] }).bundles[0]!.assets;
    expect(entries[0]!.src).toEqual(['ui/hud.22222222.avif', 'ui/hud.33333333.webp', 'ui/hud.11111111.png']);
  });
});

describe('H7 — the hashed names a loader-migration row carries (image rename + sheet manifest→image map)', () => {
  // The FixChange builders (looseRenameChange / setChanges) are web-app-local (apps/web/src/lib/loader-migration.ts)
  // and have their own test; here we prove the PURE name-production the worker threads INTO those builders so the
  // emitted rows reference files that exist (no broken reference chain in the migration guide).
  it('loose transcode: from=ORIGINAL, to=hashed emitted image', async () => {
    const imageBytes = new Uint8Array([1, 2, 3, 4]);
    const h = await shortHash(imageBytes);
    const from = 'logo.png';
    const to = hashedName('logo.webp', h); // transcode renamed logo.png → logo.webp, then content-hashed
    expect(to).toBe(`logo.${h}.webp`);
    expect(to).not.toBe(from);
    expect(to).toMatch(/^logo\.[0-9a-f]{8}\.webp$/);
  });

  it('merge/pack sheet: the manifest target maps to the hashed page IMAGE that it embeds', async () => {
    // image first → hash → emitted image; patch imageRef; emit sidecar → hash → emitted sidecar.
    const imageBytes = new Uint8Array([5, 6, 7, 8, 9]);
    const imgHash = await shortHash(imageBytes);
    const emittedImage = hashedName('atlas-merged.webp', imgHash);
    const patched = withHashedImageRef(staticAtlas('atlas-merged.webp'), emittedImage.split('/').pop()!);
    const sidecarHash = await shortHash(te.encode(emitTexturePackerJson(patched)));
    const emittedManifest = hashedName('atlas-merged.json', sidecarHash);

    // the loader-migration row's pageImages map (manifest → real page image) must point the hashed manifest at
    // the hashed image — Phaser's this.load.atlas(key, textureURL=hashedImage, atlasURL=hashedManifest).
    const pageImages: Record<string, string> = { [emittedManifest]: emittedImage };
    expect(pageImages[emittedManifest]).toBe(emittedImage);
    // and the manifest itself embeds that same hashed image in meta.image (the Pixi loader reads it directly)
    expect((JSON.parse(emitTexturePackerJson(patched)) as { meta: { image: string } }).meta.image).toBe(
      emittedImage.split('/').pop()!,
    );
  });
});

describe('H8 — hashedName preserves a compound resolution token (variantManifestName + format)', () => {
  it('hashedName(variantManifestName("ui/btn.json","_720p","image/webp",true), h) === ui/btn_720p.<hash>.json', () => {
    const sidecar = variantManifestName('ui/btn.json', '_720p', 'image/webp', true);
    expect(sidecar).toBe('ui/btn_720p.webp.json'); // token + format-disambiguated sidecar
    const out = hashedName(sidecar, 'a1b2c3d4');
    expect(out).toBe('ui/btn_720p.webp.a1b2c3d4.json'); // hash inserted before the FINAL ext, token preserved
  });

  it('single-format tier keeps the legacy token name and inserts the hash before .json', () => {
    const sidecar = variantManifestName('ui/btn.json', '_540p', 'image/webp', false);
    expect(sidecar).toBe('ui/btn_540p.json');
    expect(hashedName(sidecar, 'deadbeef')).toBe('ui/btn_540p.deadbeef.json');
  });

  it('no-extension path appends the hash (loose image with no ext)', () => {
    expect(hashedName('noext', 'cafebabe')).toBe('noext.cafebabe');
  });
});
