// PURE unit coverage for the owner-aware dedup EXECUTION helpers (design §3d / §10.8): the rename rule
// (EXT/renamedTo), the Phase-A owner final-name prediction (predictOwnerFinalNames — the two-phase
// contract's first phase), and the owner-aware-drop type guard (isOwnerAwareDrop). These are the SINGLE
// source of truth the fix.worker imports; pinning them here (and the worker's Node round-trip driving the
// same functions) means the dangling-reference guard can't drift between the worker and its test.

import { describe, it, expect } from 'vitest';
import type { DedupGroup, FixOp, ImageMime } from '@asset-doctor/core';
import { EXT, renamedTo, predictOwnerFinalNames, isOwnerAwareDrop, type OwnerPlanInput } from '../src/index';

describe('EXT + renamedTo (rename rule)', () => {
  it('EXT maps every ImageMime to its file extension', () => {
    expect(EXT).toEqual({ 'image/webp': '.webp', 'image/avif': '.avif', 'image/png': '.png', 'image/jpeg': '.jpg' });
  });

  it('swaps the final-segment extension, preserving the directory', () => {
    expect(renamedTo('main_game/sheet.png', 'image/webp')).toBe('main_game/sheet.webp');
    expect(renamedTo('a/b/c/icon.jpeg', 'image/avif')).toBe('a/b/c/icon.avif');
    expect(renamedTo('root.png', 'image/webp')).toBe('root.webp'); // root-level path, no dir
  });

  it('only touches the basename, never a dot earlier in the path', () => {
    // a dotted DIRECTORY must be left intact — only the file extension changes.
    expect(renamedTo('v1.2/sheet.png', 'image/webp')).toBe('v1.2/sheet.webp');
  });

  it('an unknown mime falls back to .webp (matches the worker fallback)', () => {
    expect(renamedTo('x.png', 'image/gif' as ImageMime)).toBe('x.webp');
  });
});

describe('predictOwnerFinalNames (Phase A)', () => {
  // One group with two owners; the lookup supplies each owner's plan facts (the worker passes its maps).
  const groups: DedupGroup[] = [
    { contentHash: 'h1', pool: 'pixi', skinGroup: 'general', owners: ['main_game/sheet.png', 'fs_game/logo.png'], consumers: [] },
  ];

  it('a transcoded owner is predicted at its renamed (target-mime) image; a non-transcoded owner keeps its path', () => {
    const lookup = (ref: string): OwnerPlanInput =>
      ref === 'main_game/sheet.png'
        ? { imagePath: 'main_game/sheet.png', manifestPath: 'main_game/sheet.json', transcoded: true, targetMime: 'image/webp' }
        : { imagePath: 'fs_game/logo.png', transcoded: false, targetMime: 'image/webp' };

    const out = predictOwnerFinalNames(groups, lookup);
    // transcoded atlas owner → renamed image + its manifest carried through.
    expect(out.get('main_game/sheet.png')).toEqual({ image: 'main_game/sheet.webp', manifest: 'main_game/sheet.json' });
    // untouched loose owner → original path, no manifest key.
    expect(out.get('fs_game/logo.png')).toEqual({ image: 'fs_game/logo.png' });
  });

  it('a transcode owner follows the EFFECTIVE target mime (per-folder/type override redirect)', () => {
    const lookup = (): OwnerPlanInput => ({ imagePath: 'a/o.png', transcoded: true, targetMime: 'image/avif' });
    const out = predictOwnerFinalNames([{ contentHash: 'h', pool: 'pixi', skinGroup: 'general', owners: ['a/o.png'], consumers: [] }], lookup);
    expect(out.get('a/o.png')).toEqual({ image: 'a/o.avif' });
  });

  it('an owner with no known image path is omitted (the worker keeps the consumer)', () => {
    const lookup = (ref: string): OwnerPlanInput =>
      ref === 'main_game/sheet.png' ? { imagePath: undefined, transcoded: false, targetMime: 'image/webp' } : { imagePath: 'fs_game/logo.png', transcoded: false, targetMime: 'image/webp' };
    const out = predictOwnerFinalNames(groups, lookup);
    expect(out.has('main_game/sheet.png')).toBe(false);
    expect(out.has('fs_game/logo.png')).toBe(true);
  });

  it('undefined groups ⇒ empty prediction (non-dedup runs are untouched)', () => {
    expect(predictOwnerFinalNames(undefined, () => ({ imagePath: 'x', transcoded: false, targetMime: 'image/webp' })).size).toBe(0);
  });

  it('dedups owner refs across groups so the lookup runs once per ref', () => {
    let calls = 0;
    const twoGroupsSameOwner: DedupGroup[] = [
      { contentHash: 'h1', pool: 'pixi', skinGroup: 'general', owners: ['o.png'], consumers: [] },
      { contentHash: 'h2', pool: 'pixi', skinGroup: 'general', owners: ['o.png'], consumers: [] },
    ];
    predictOwnerFinalNames(twoGroupsSameOwner, (ref) => {
      calls++;
      return { imagePath: ref, transcoded: false, targetMime: 'image/webp' };
    });
    expect(calls).toBe(1); // owner refs are de-duplicated into a Set before lookup
  });
});

describe('isOwnerAwareDrop (Phase-C op guard)', () => {
  const ownerDrop: FixOp = { kind: 'drop', assetRef: 'extra/sheet.png', reason: 'duplicate-exact', ownerRef: 'main_game/sheet.png', repointManifest: true };
  const bareDrop: FixOp = { kind: 'drop', assetRef: 'dup.png', reason: 'duplicate-exact' };
  const transcode: FixOp = { kind: 'transcode', assetRef: 'a.png', targetMime: 'image/webp', quality: 0.9, lossless: true };

  it('matches only drops carrying an ownerRef (owner-aware) — bare drops + other ops excluded', () => {
    expect([ownerDrop, bareDrop, transcode].filter(isOwnerAwareDrop)).toEqual([ownerDrop]);
  });
});
