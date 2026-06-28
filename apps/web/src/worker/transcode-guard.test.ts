// Unit test for the keep-original-on-size-LOSS guard (round15 #2). The worker can't run in Node, so the
// load-bearing predicate is extracted and asserted here (the same discipline as sheet-diff.test.ts /
// selective-worker.test.ts): an opaque re-encode is shipped ONLY when STRICTLY smaller than the source; a
// general (format-changing) transcode is never gated here.

import { describe, it, expect } from 'vitest';
import { transcodeIsSizeLoss } from './transcode-guard';

describe('transcodeIsSizeLoss — never ship a larger page from an opaque "optimization"', () => {
  it('opaque + re-encode SMALLER ⇒ ship (not a loss)', () => {
    expect(transcodeIsSizeLoss(true, 7000, 10000)).toBe(false);
  });

  it('opaque + re-encode EQUAL ⇒ keep original (no win to ship)', () => {
    expect(transcodeIsSizeLoss(true, 10000, 10000)).toBe(true);
  });

  it('opaque + re-encode LARGER ⇒ keep original (a size loss — never ship)', () => {
    expect(transcodeIsSizeLoss(true, 12000, 10000)).toBe(true);
  });

  it('NON-opaque (general format transcode) is NEVER gated here, even when larger', () => {
    // A PNG→WebP transcode that comes out larger is a legitimate format choice handled downstream — the
    // guard must not touch it (scoped to the alpha-drop case only).
    expect(transcodeIsSizeLoss(false, 12000, 10000)).toBe(false);
    expect(transcodeIsSizeLoss(undefined, 12000, 10000)).toBe(false);
  });

  it('non-opaque smaller ⇒ also false (ships, unchanged behavior)', () => {
    expect(transcodeIsSizeLoss(false, 5000, 10000)).toBe(false);
  });
});

describe('export-profile fan-out same-format opaque size-loss gating (round17 hole)', () => {
  // Mirror the worker guard verbatim (emitLooseProfileFanout): a fanned-out variant is SKIPPED (original
  // kept) only when it is an opaque re-encode to the SAME mime as the source AND not strictly smaller. A real
  // format CHANGE (enc.mime !== srcMime) is never gated — it can legitimately grow and is handled downstream.
  const fanoutSkips = (opaque: boolean, srcMime: string, variantMime: string, v: number, s: number) =>
    opaque && variantMime === srcMime && transcodeIsSizeLoss(true, v, s);

  it('opaque same-format (png→png) LARGER ⇒ skip (keep original)', () => {
    expect(fanoutSkips(true, 'image/png', 'image/png', 12000, 10000)).toBe(true);
  });
  it('opaque same-format (png→png) EQUAL ⇒ skip (no win to ship)', () => {
    expect(fanoutSkips(true, 'image/png', 'image/png', 10000, 10000)).toBe(true);
  });
  it('opaque same-format (png→png) SMALLER ⇒ ship (the real win)', () => {
    expect(fanoutSkips(true, 'image/png', 'image/png', 7000, 10000)).toBe(false);
  });
  it('opaque FORMAT CHANGE (png→webp) larger ⇒ ship (downstream-accounted, never gated)', () => {
    expect(fanoutSkips(true, 'image/png', 'image/webp', 12000, 10000)).toBe(false);
  });
  it('opaque FORMAT CHANGE (png→avif) much larger ⇒ ship (never gated)', () => {
    expect(fanoutSkips(true, 'image/png', 'image/avif', 99999, 10000)).toBe(false);
  });
  it('NON-opaque same-format larger ⇒ ship (branch dead when opaque off ⇒ byte-identical to today)', () => {
    expect(fanoutSkips(false, 'image/png', 'image/png', 12000, 10000)).toBe(false);
  });
});
