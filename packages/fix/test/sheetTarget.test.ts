// sheetPageTarget — the PURE sheet-page format decision (settings-page design §0.1/§4). Pins the FULL
// decision matrix, the byte-identity defaults (every default arg combination must reproduce today's
// hardcodes: Spine ⇒ PNG, static repack/merge ⇒ lossless WebP, static pack ⇒ the legacy resolved target),
// the formats[0] selection + multiNote flag, and determinism.

import { describe, expect, it } from 'vitest';
import { sheetPageTarget, type SheetTargetArgs } from '../src/sheetTarget';
import type { FormatTarget } from '@asset-doctor/core';

const avif: FormatTarget = { format: 'image/avif', quality: 80 };
const webpLossless: FormatTarget = { format: 'image/webp', lossless: true };
const png: FormatTarget = { format: 'image/png' };

/** Base args builder — defaults mirror the worker's untouched-options call shape. */
const args = (over: Partial<SheetTargetArgs>): SheetTargetArgs => ({
  site: 'repack',
  isSpine: false,
  spinePageFormat: 'png',
  profileFormats: [],
  legacyMime: 'image/avif',
  ...over,
});

describe("sheetPageTarget — byte-identity defaults (absent wire field ⇒ today's hardcodes)", () => {
  it("SPINE repack, default spinePageFormat, profile OFF ⇒ spine-png (today's :1965 literal)", () => {
    expect(sheetPageTarget(args({ isSpine: true }))).toEqual({ kind: 'spine-png' });
  });

  it("SPINE pack, default spinePageFormat, profile OFF ⇒ spine-png (today's :2845 literal + '.png' probeExt)", () => {
    expect(sheetPageTarget(args({ site: 'pack', isSpine: true }))).toEqual({ kind: 'spine-png' });
  });

  it('SPINE + default spinePageFormat ignores an ACTIVE profile (default wins ⇒ byte-identical PNG)', () => {
    expect(sheetPageTarget(args({ isSpine: true, profileFormats: [avif, webpLossless] }))).toEqual({
      kind: 'spine-png',
    });
    expect(sheetPageTarget(args({ site: 'pack', isSpine: true, profileFormats: [avif] }))).toEqual({
      kind: 'spine-png',
    });
  });

  it('STATIC repack/merge, profile OFF ⇒ webp-lossless UNCONDITIONALLY (§0.1 — never the lossy legacy default)', () => {
    // legacyMime is deliberately avif here — the decision must NOT consult it for static repack/merge.
    expect(sheetPageTarget(args({}))).toEqual({ kind: 'webp-lossless' });
  });

  it("STATIC pack, profile OFF ⇒ legacy resolved target (today's resolveOptions path)", () => {
    expect(sheetPageTarget(args({ site: 'pack' }))).toEqual({
      kind: 'legacy',
      mime: 'image/avif',
    });
    // …and it passes the legacy mime through verbatim (a per-folder override that resolved to webp).
    expect(sheetPageTarget(args({ site: 'pack', legacyMime: 'image/webp' }))).toEqual({
      kind: 'legacy',
      mime: 'image/webp',
    });
  });
});

describe('sheetPageTarget — profile ON (the feature: sheets follow the profile)', () => {
  it('STATIC repack, single-format profile ⇒ formats[0], multiNote false', () => {
    expect(sheetPageTarget(args({ profileFormats: [avif] }))).toEqual({
      kind: 'profile',
      format: avif,
      multiNote: false,
    });
  });

  it('STATIC pack, single-format profile ⇒ formats[0] (profile beats the legacy target)', () => {
    expect(sheetPageTarget(args({ site: 'pack', profileFormats: [webpLossless] }))).toEqual({
      kind: 'profile',
      format: webpLossless,
      multiNote: false,
    });
  });

  it('multi-format profile ⇒ STILL formats[0] (FIRST, never a "best" pick) + multiNote true', () => {
    const d = sheetPageTarget(args({ profileFormats: [webpLossless, avif, png] }));
    expect(d).toEqual({ kind: 'profile', format: webpLossless, multiNote: true });
    // Order decides: swapping the list swaps the shipped format.
    const d2 = sheetPageTarget(args({ profileFormats: [avif, webpLossless, png] }));
    expect(d2).toEqual({ kind: 'profile', format: avif, multiNote: true });
  });

  it("SPINE + spinePageFormat 'profile' + profile ON ⇒ formats[0] (repack AND pack sites)", () => {
    expect(
      sheetPageTarget(
        args({ isSpine: true, spinePageFormat: 'profile', profileFormats: [webpLossless] }),
      ),
    ).toEqual({ kind: 'profile', format: webpLossless, multiNote: false });
    expect(
      sheetPageTarget(
        args({
          site: 'pack',
          isSpine: true,
          spinePageFormat: 'profile',
          profileFormats: [avif, png],
        }),
      ),
    ).toEqual({ kind: 'profile', format: avif, multiNote: true });
  });

  it("SPINE + spinePageFormat 'profile' + profile OFF ⇒ legacy resolved Spine target", () => {
    expect(
      sheetPageTarget(
        args({ isSpine: true, spinePageFormat: 'profile', legacyMime: 'image/webp' }),
      ),
    ).toEqual({ kind: 'legacy', mime: 'image/webp' });
    expect(
      sheetPageTarget(
        args({ site: 'pack', isSpine: true, spinePageFormat: 'profile', legacyMime: 'image/avif' }),
      ),
    ).toEqual({ kind: 'legacy', mime: 'image/avif' });
  });
});

describe('sheetPageTarget — totality + determinism', () => {
  const formatLists: readonly FormatTarget[][] = [[], [avif], [webpLossless, avif, png]];

  it('total: every {site × isSpine × spinePageFormat × profile} cell yields exactly one known kind', () => {
    for (const site of ['repack', 'pack'] as const)
      for (const isSpine of [false, true])
        for (const spinePageFormat of ['png', 'profile'] as const)
          for (const profileFormats of formatLists) {
            const d = sheetPageTarget({
              site,
              isSpine,
              spinePageFormat,
              profileFormats,
              legacyMime: 'image/avif',
            });
            expect(['spine-png', 'webp-lossless', 'legacy', 'profile']).toContain(d.kind);
          }
  });

  it('deterministic: same args ⇒ structurally equal decisions (and formats[0] returned BY REFERENCE)', () => {
    const a = args({ site: 'pack', profileFormats: [avif, png] });
    const d1 = sheetPageTarget(a);
    const d2 = sheetPageTarget(a);
    expect(d1).toEqual(d2);
    // The chosen FormatTarget is the caller's object, untouched — formatEncode downstream reads it verbatim.
    expect(d1.kind).toBe('profile');
    if (d1.kind === 'profile') expect(d1.format).toBe(avif);
  });

  it('the input args object is never mutated', () => {
    const a = args({ isSpine: true, spinePageFormat: 'profile', profileFormats: [avif] });
    const snapshot = JSON.parse(JSON.stringify(a)) as SheetTargetArgs;
    sheetPageTarget(a);
    expect(a).toEqual(snapshot);
  });
});
