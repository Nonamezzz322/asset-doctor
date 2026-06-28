// Regression for round9-cache-busting BLOCKER-0 (fix.worker.ts loose dedup OWNER × pass-through hashing).
//
// THE BUG: a dedup OWNER that is a LOOSE image and is NOT transcoded/resized keeps its Phase-A default
// ownerActualName.image = the ORIGINAL un-hashed path (predictOwnerFinalNames returns it verbatim for a
// non-transcoded owner). The pass-through loop then hashes that same loose image (hashOn && looseRef) to
// name.<hash>.ext and ships ONLY the hashed file. Phase C had already written the byte-identical atlas
// consumer's meta.image = relativeImageRef(dir, actual.image) = the UN-HASHED owner path ⇒ the kept
// consumer manifest points at a file that never ships ⇒ runtime 404 (the worst failure class).
//
// THE FIX (fix.worker.ts): pre-hash every NON-TRANSFORMED loose owner BEFORE Phase C, record the hashed
// name into ownerActualName.image (so the consumer's meta.image is repointed at the file that ships) and
// remember original→hashed so the pass-through emits THAT same hashed path (once, even when manifestOn is
// off — the consumer atlas manifest is the guaranteed referrer). hashOff ⇒ pre-hash skipped ⇒ identical.
//
// This test drives the SAME pure helpers the worker imports (predictOwnerFinalNames / hashedName /
// relativeImageRef / resolveImageRef / emitTexturePackerJson) and a faithful node-side re-implementation
// of the worker's pre-hash + Phase-C + pass-through control flow, then asserts the cardinal correctness
// invariant: EVERY surviving manifest's resolved meta.image is among the emitted zip entries (no dangling
// reference). It also asserts hashOff ⇒ byte-identical emitted paths to today.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { Atlas } from '@asset-doctor/core';
import {
  predictOwnerFinalNames,
  hashedName,
  relativeImageRef,
  resolveImageRef,
  dirOf,
  normalize,
  emitTexturePackerJson,
} from '@asset-doctor/fix';
import { buildDedupGroups } from '@asset-doctor/analysis';

const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(Buffer.from(b)).digest('hex');
const shortHash = (b: Uint8Array): string => sha256Hex(b).slice(0, 8);

// ── synthetic fixture: a LOOSE image and a byte-identical ATLAS page in the same (pixi) pool ──────────
// Byte-identical content ⇒ one contentHash group. cmp-first ref is the owner: 'shared/coin.png' sorts
// before 'ui/coins.png' (codepoint order) ⇒ the LOOSE image is the owner, the ATLAS page is the consumer.
const SHARED_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // identical bytes
const LOOSE_OWNER_REF = 'shared/coin.png';
const ATLAS_CONSUMER_REF = 'ui/coins.png';
const ATLAS_CONSUMER_MANIFEST = 'ui/coins.json';

// The consumer atlas (one frame; the exact shape parseAtlas/emitTexturePackerJson round-trip).
const consumerAtlas: Atlas = {
  name: ATLAS_CONSUMER_REF,
  imageRef: 'coins.png', // relative to ui/
  size: { w: 16, h: 16 },
  format: 'RGBA8888',
  sprites: [{ name: 'coin', frame: { x: 0, y: 0, w: 8, h: 8 }, rotated: false, trimmed: false, sourceSize: { w: 8, h: 8 }, spriteSourceSize: { x: 0, y: 0, w: 8, h: 8 } }],
  source: { kind: 'texturepacker-hash' },
};

interface Built {
  pathByRef: Map<string, string>;
  bytesByRef: Map<string, Uint8Array>;
  atlasByRef: Map<string, Atlas>;
  manifestPathOf: (ref: string) => string | undefined;
  features: { assetRef: string; contentHash: string }[];
}
function build(): Built {
  const pathByRef = new Map<string, string>([
    [LOOSE_OWNER_REF, LOOSE_OWNER_REF],
    [ATLAS_CONSUMER_REF, ATLAS_CONSUMER_REF],
  ]);
  const bytesByRef = new Map<string, Uint8Array>([
    [LOOSE_OWNER_REF, SHARED_BYTES],
    [ATLAS_CONSUMER_REF, SHARED_BYTES],
  ]);
  const atlasByRef = new Map<string, Atlas>([[ATLAS_CONSUMER_REF, consumerAtlas]]);
  const manifestPathByImage = new Map<string, string>([[ATLAS_CONSUMER_REF, ATLAS_CONSUMER_MANIFEST]]);
  const manifestPathOf = (ref: string): string | undefined => manifestPathByImage.get(pathByRef.get(ref) ?? '');
  const features = [LOOSE_OWNER_REF, ATLAS_CONSUMER_REF].map((ref) => ({ assetRef: ref, contentHash: sha256Hex(bytesByRef.get(ref)!) }));
  return { pathByRef, bytesByRef, atlasByRef, manifestPathOf, features };
}

// ── faithful node-side model of the worker's pre-hash + Phase-C + pass-through (cache-bust ON/OFF) ────
interface RunResult {
  emitted: { path: string; bytes?: Uint8Array; manifest?: unknown }[];
  dropped: Set<string>;
}
function run(b: Built, hashOn: boolean, manifestOn: boolean): RunResult {
  const isAtlasRef = (ref: string): boolean => b.atlasByRef.has(ref);
  const kindOf = (ref: string): 'loose' | 'pixi' => (isAtlasRef(ref) ? 'pixi' : 'loose');
  // All members eager ⇒ eager-anchored cmp-first owner (the loose image). marking by bundle (first segment).
  const marking = { shared: 'eager' as const, ui: 'eager' as const };
  const groups = buildDedupGroups(b.features, new Set(), marking, {});

  // Phase A — predict owner final names (loose owner is non-transcoded ⇒ image === original path).
  const predicted = predictOwnerFinalNames(groups, (ref) => ({
    imagePath: b.pathByRef.get(ref),
    manifestPath: b.manifestPathOf(ref),
    transcoded: false,
    targetMime: 'image/webp',
  }));
  // Mirror the worker (fix.worker.ts:789): COPY each OwnerFinalName so mutating ownerActualName.image does
  // NOT alias the prediction (which is the divergence basis).
  const ownerActualName = new Map([...predicted].map(([ref, fn]) => [ref, { ...fn }] as const));
  const ownerActualUnhashed = new Map([...predicted].map(([ref, fn]) => [ref, fn.image] as const));

  // ── THE FIX under test: pre-hash non-transformed LOOSE owners before Phase C. ──
  const prehashedLooseOwner = new Map<string, string>();
  if (hashOn) {
    for (const [ref, fn] of predicted) {
      if (kindOf(ref) !== 'loose') continue;
      const p = b.pathByRef.get(ref);
      if (!p || fn.image !== p) continue;
      const bytes = b.bytesByRef.get(ref)!;
      const hashed = hashedName(p, shortHash(bytes));
      if (hashed === p) continue;
      ownerActualName.get(ref)!.image = hashed;
      prehashedLooseOwner.set(p, hashed);
    }
  }

  // Phase C — repoint the atlas consumer's meta.image at the OWNER's reconciled final (now hashed) image.
  const out: RunResult = { emitted: [], dropped: new Set() };
  for (const g of groups) {
    for (const c of g.consumers) {
      const consumerRef = c.ref;
      const consumerManifest = b.manifestPathOf(consumerRef);
      const consumerAtlasObj = b.atlasByRef.get(consumerRef);
      const actual = ownerActualName.get(c.ownerRef)?.image;
      const predImg = predicted.get(c.ownerRef)?.image;
      const unhashed = ownerActualUnhashed.get(c.ownerRef) ?? actual;
      // divergence guard on the UN-HASHED basis — a content hash must NOT count as a divergence.
      if (actual == null || predImg == null || unhashed !== predImg) continue;
      if (!consumerManifest || !consumerAtlasObj) continue;
      const repointed: Atlas = { ...consumerAtlasObj, imageRef: relativeImageRef(dirOf(consumerManifest), actual) };
      out.emitted.push({ path: consumerManifest, bytes: new TextEncoder().encode(emitTexturePackerJson(repointed)), manifest: JSON.parse(emitTexturePackerJson(repointed)) });
      out.dropped.add(b.pathByRef.get(consumerRef)!); // drop the redundant consumer IMAGE; manifest kept
    }
  }

  // Pass-through — emit every untouched file. A pre-hashed loose owner ships at its hashed path.
  for (const [ref, p] of b.pathByRef) {
    if (out.dropped.has(p)) continue;
    const looseRef = manifestOn && kindOf(ref) === 'loose' ? ref : undefined;
    const prehashed = hashOn ? prehashedLooseOwner.get(p) : undefined;
    const emittedPath = prehashed ?? (hashOn && looseRef ? hashedName(p, shortHash(b.bytesByRef.get(ref)!)) : p);
    out.emitted.push({ path: emittedPath, bytes: b.bytesByRef.get(ref) });
  }
  return out;
}

describe('cache-bust BLOCKER-0: loose dedup owner × pass-through hashing (no dangling reference)', () => {
  it('hashFilenames + emitPixiManifest: the atlas consumer meta.image resolves to an EMITTED file (no 404)', () => {
    const b = build();
    const res = run(b, /*hashOn*/ true, /*manifestOn*/ true);

    const consumerEntry = res.emitted.find((e) => e.path === ATLAS_CONSUMER_MANIFEST);
    expect(consumerEntry, 'the kept atlas consumer manifest must be re-emitted').toBeDefined();
    const meta = (consumerEntry!.manifest as { meta?: { image?: string } }).meta;
    expect(typeof meta?.image).toBe('string');

    // Resolve meta.image the way a loader (parseAtlas) would, then assert that path is among emitted entries.
    const resolved = resolveImageRef(ATLAS_CONSUMER_MANIFEST, meta!.image!);
    const emittedPaths = new Set(res.emitted.map((e) => normalize(e.path)));
    expect(emittedPaths.has(resolved), `meta.image resolves to ${resolved} which must be an emitted file`).toBe(true);

    // And concretely: it points at the HASHED owner image (the un-hashed original must NOT ship).
    const expectedHashed = hashedName(LOOSE_OWNER_REF, shortHash(SHARED_BYTES));
    expect(resolved).toBe(normalize(expectedHashed));
    expect(emittedPaths.has(normalize(LOOSE_OWNER_REF))).toBe(false); // original un-hashed owner NOT shipped
  });

  it('hashFilenames + emitPixiManifest OFF: still no dangling reference (consumer manifest is the referrer)', () => {
    const b = build();
    const res = run(b, /*hashOn*/ true, /*manifestOn*/ false);
    const consumerEntry = res.emitted.find((e) => e.path === ATLAS_CONSUMER_MANIFEST)!;
    const meta = (consumerEntry.manifest as { meta?: { image?: string } }).meta!;
    const resolved = resolveImageRef(ATLAS_CONSUMER_MANIFEST, meta.image!);
    const emittedPaths = new Set(res.emitted.map((e) => normalize(e.path)));
    // Even with the Pixi manifest off, the loose owner is hashed (consumer manifest is the guaranteed
    // referrer) and the consumer points at the shipped hashed file.
    expect(resolved).toBe(normalize(hashedName(LOOSE_OWNER_REF, shortHash(SHARED_BYTES))));
    expect(emittedPaths.has(resolved)).toBe(true);
    expect(emittedPaths.has(normalize(LOOSE_OWNER_REF))).toBe(false);
  });

  it('hashFilenames OFF: emitted paths byte-identical to today (additivity)', () => {
    const b = build();
    const res = run(b, /*hashOn*/ false, /*manifestOn*/ true);
    const paths = new Set(res.emitted.map((e) => normalize(e.path)));
    // The loose owner ships at its ORIGINAL name; the consumer manifest is re-emitted at its original name;
    // the consumer IMAGE is dropped (the only dedup effect). No .<hash>. suffix anywhere.
    expect(paths.has(normalize(LOOSE_OWNER_REF))).toBe(true);
    expect(paths.has(ATLAS_CONSUMER_MANIFEST)).toBe(true);
    expect([...paths].some((p) => /\.[0-9a-f]{8}\./.test(p))).toBe(false);
    expect(res.dropped.has(ATLAS_CONSUMER_REF)).toBe(true);
    // meta.image still resolves to the (un-hashed) owner, which DOES ship.
    const consumerEntry = res.emitted.find((e) => e.path === ATLAS_CONSUMER_MANIFEST)!;
    const meta = (consumerEntry.manifest as { meta?: { image?: string } }).meta!;
    expect(resolveImageRef(ATLAS_CONSUMER_MANIFEST, meta.image!)).toBe(normalize(LOOSE_OWNER_REF));
  });
});
