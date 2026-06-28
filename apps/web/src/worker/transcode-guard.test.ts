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
