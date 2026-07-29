import { describe, it, expect } from 'vitest';
import { alphaShape, dHashFromGray, grayStdDev, isFlat, blockUpscaleDepth, premultipliedEdgeShape } from '../src/lib/perceptual';

/** Build a w×h RGBA buffer from a per-pixel color fn. */
function rgba(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, al] = fn(x, y);
      const i = (y * w + x) * 4;
      a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = al;
    }
  return a;
}
/** Nearest-neighbour 2× upscale of a source built by `fn` at (w/2 × h/2). */
const nearest2x = (w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]) =>
  rgba(w, h, (x, y) => fn(x >> 1, y >> 1));

const N = 9 * 8;
const flat = new Array<number>(N).fill(128);
// horizontal gradient per row: 0,28,…,224 — repeated for all 8 rows
const gradient = Array.from({ length: N }, (_, i) => (i % 9) * 28);
const reverse = Array.from({ length: N }, (_, i) => (8 - (i % 9)) * 28);

describe('blockUpscaleDepth — provable nearest-2× upscale (a proof, no threshold)', () => {
  it('a nearest 2× upscale of a detailed 4×4 ⇒ depth 1', () => {
    const detail = (x: number, y: number): [number, number, number, number] => [x * 30, y * 30, (x + y) * 10, 255];
    expect(blockUpscaleDepth(nearest2x(8, 8, detail), 8, 8)).toBe(1);
  });
  it('a 16×16 whose every 4×4 block is constant ⇒ depth 2', () => {
    const b = rgba(16, 16, (x, y) => [(x >> 2) * 40, (y >> 2) * 40, 0, 255]);
    expect(blockUpscaleDepth(b, 16, 16)).toBe(2);
  });
  it('a genuinely detailed image (per-pixel variation) ⇒ depth 0 (no false positive)', () => {
    expect(blockUpscaleDepth(rgba(8, 8, (x, y) => [x * 8, y * 8, 0, 255]), 8, 8)).toBe(0);
  });
  it('ALPHA is part of the constancy test: constant RGB but alpha varying inside a block ⇒ depth 0', () => {
    expect(blockUpscaleDepth(rgba(8, 8, (x, y) => [0, 0, 0, (x + y) & 1 ? 255 : 0]), 8, 8)).toBe(0);
  });
  it('odd dimension ⇒ 0; too small ⇒ 0; short buffer ⇒ 0', () => {
    expect(blockUpscaleDepth(rgba(6, 8, () => [0, 0, 0, 255]), 6, 7)).toBe(0); // h odd
    expect(blockUpscaleDepth(rgba(1, 1, () => [0, 0, 0, 255]), 1, 1)).toBe(0);
    expect(blockUpscaleDepth(new Uint8ClampedArray(4), 8, 8)).toBe(0); // buffer shorter than w·h·4
  });
  it('the uint32 fast path and the number[] byte fallback agree (a plain Array skips the typed-view path)', () => {
    // The typed getImageData buffer takes the one-uint32-per-pixel path; a plain number[] falls back to the
    // per-byte loop. Both must return the identical depth on the identical pixels — verify on an upscale, a
    // deeper upscale, and a non-upscale.
    const cases: Array<{ buf: Uint8ClampedArray; w: number; h: number; want: number }> = [
      { buf: nearest2x(8, 8, (x, y) => [x * 30, y * 30, (x + y) * 10, 255]), w: 8, h: 8, want: 1 },
      { buf: rgba(16, 16, (x, y) => [(x >> 2) * 40, (y >> 2) * 40, 0, 255]), w: 16, h: 16, want: 2 },
      { buf: rgba(8, 8, (x, y) => [x * 8, y * 8, 0, 255]), w: 8, h: 8, want: 0 },
    ];
    for (const { buf, w, h, want } of cases) {
      expect(blockUpscaleDepth(buf, w, h)).toBe(want); // typed Uint8ClampedArray ⇒ uint32 fast path
      expect(blockUpscaleDepth(Array.from(buf), w, h)).toBe(want); // number[] ⇒ byte fallback agrees
    }
  });
  it('a solid image descends fully (documents why analyze de-overlaps with solid-fill)', () => {
    expect(blockUpscaleDepth(rgba(8, 8, () => [100, 100, 100, 255]), 8, 8)).toBe(3); // 8→4→2→1
  });
});

// ── premultipliedEdgeShape — the premultiplied-alpha folder disclosure's pure metric ─────────────────
// Column layout shared by the sprite fixtures (8×8): x∈[0,3] the opaque body, x==4 the ONE anti-aliasing
// transition column (α=128 ∈ [PMA_ALPHA_MIN, PMA_ALPHA_MAX], adjacent to the body), x∈[5,7] fully clear.
// A bright body (RGB 200 ⇒ luma 200 ≥ PMA_BRIGHT_MIN) with α=128 clears the gap: 200·(1−128/255) ≈ 99.6
// ≥ PMA_GAP_MIN ⇒ all 8 transition pixels (one per row) qualify ⇒ edgePixels === 8 deterministic.
describe('premultipliedEdgeShape — implied-matte edge classification (measure, never guess)', () => {
  const C = 200; // bright body value (luma exactly 200: 0.299+0.587+0.114 = 1)
  const A = 128; // transition alpha, mid-band
  /** Premultiplied/black-matted export: stored RGB collapses with alpha (S = C·α/255). */
  const premultStored = Math.round((C * A) / 255); // 100
  const premultSprite = rgba(8, 8, (x) => {
    if (x < 4) return [C, C, C, 255];
    if (x === 4) return [premultStored, premultStored, premultStored, A];
    return [0, 0, 0, 0];
  });
  /** Correct straight alpha: stored RGB HOLDS the opaque colour at the soft edge (S = C). */
  const straightSprite = rgba(8, 8, (x) => {
    if (x < 4) return [C, C, C, 255];
    if (x === 4) return [C, C, C, A];
    return [0, 0, 0, 0];
  });

  it('a premult/black-matted sprite (S = C·α) ⇒ every transition pixel dark-fringes (fringeFrac 1)', () => {
    const r = premultipliedEdgeShape(premultSprite, 8, 8);
    expect(r.edgePixels).toBe(8); // one transition pixel per row — all qualify
    expect(r.fringeFrac).toBe(1); // implied matte collapses to ~0 ≤ PMA_MATTE_DARK on every one
  });

  it('a correct straight-alpha sprite (S = C at the edge) ⇒ fringeFrac 0 (no false positive)', () => {
    const r = premultipliedEdgeShape(straightSprite, 8, 8);
    expect(r.edgePixels).toBe(8); // same 8 transition pixels measured…
    expect(r.fringeFrac).toBe(0); // …but the implied matte recovers the bright colour (~200 > 40)
  });

  // THE semantic ambiguity the finding's copy hedges (invariant 3): a correctly-PREMULTIPLIED export
  // (S = C·α, meant to be blended premultiplied) and STRAIGHT art composited onto a BLACK matte
  // (S = C·α + 0·(1−α), meant to be blended straight) are BYTE-IDENTICAL buffers. No pixel measurement
  // can tell them apart — which is exactly why the finding is a conditional DISCLOSURE, never a defect.
  it('BYTE-IDENTITY: a correctly-premultiplied buffer EQUALS the black-matted straight one', () => {
    const correctlyPremultiplied = rgba(8, 8, (x) => {
      const a = x < 4 ? 255 : x === 4 ? A : 0;
      const s = Math.round((C * a) / 255); // premultiplied export: S = C·α
      return [s, s, s, a];
    });
    const straightOnBlackMatte = rgba(8, 8, (x) => {
      const a = x < 4 ? 255 : x === 4 ? A : 0;
      const s = Math.round((C * a) / 255 + 0 * (1 - a / 255)); // straight art over black: S = C·α + 0·(1−α)
      return [s, s, s, a];
    });
    expect(correctlyPremultiplied).toEqual(straightOnBlackMatte);
  });

  it('a DARK-outlined straight sprite (dark opaque core) ⇒ edgePixels 0 (the FP trap dies at brightMin)', () => {
    const dark = rgba(8, 8, (x) => {
      if (x < 4) return [30, 30, 30, 255]; // luma 30 < PMA_BRIGHT_MIN — dark art fringes dark legitimately
      if (x === 4) return [30, 30, 30, A];
      return [0, 0, 0, 0];
    });
    expect(premultipliedEdgeShape(dark, 8, 8)).toEqual({ edgePixels: 0, fringeFrac: 0 });
  });

  it('a soft glow with NO opaque core ⇒ edgePixels 0 (no near-opaque neighbour to measure against)', () => {
    const glow = rgba(8, 8, (x) => [C, C, C, x < 4 ? 180 : 60]); // α never reaches PMA_OPAQUE_MIN
    expect(premultipliedEdgeShape(glow, 8, 8)).toEqual({ edgePixels: 0, fringeFrac: 0 });
  });

  it('a hard cutout (α only 0/255) ⇒ edgePixels 0 (no transition band at all)', () => {
    const cutout = rgba(8, 8, (x) => [C, C, C, x < 4 ? 255 : 0]);
    expect(premultipliedEdgeShape(cutout, 8, 8)).toEqual({ edgePixels: 0, fringeFrac: 0 });
  });

  it('a fully opaque image ⇒ 0; a short/empty buffer ⇒ 0 (never throws, never claims on no data)', () => {
    expect(premultipliedEdgeShape(rgba(8, 8, () => [C, C, C, 255]), 8, 8)).toEqual({ edgePixels: 0, fringeFrac: 0 });
    expect(premultipliedEdgeShape(new Uint8ClampedArray(4), 8, 8)).toEqual({ edgePixels: 0, fringeFrac: 0 });
    expect(premultipliedEdgeShape([], 8, 8)).toEqual({ edgePixels: 0, fringeFrac: 0 });
    expect(premultipliedEdgeShape([], 0, 0)).toEqual({ edgePixels: 0, fringeFrac: 0 });
  });
});

// ── alphaShape — the shared scan behind interior-transparency + binary-alpha ────────────────────────
// EXACT-count semantics on hand-built RGBA: the bbox is of alpha>0 pixels; interiorTransparent counts
// alpha===0 INSIDE it (margins outside the bbox are trim territory, deliberately excluded).
describe('alphaShape — bbox of alpha>0 + interior transparency + binary alpha (one scan, exact counts)', () => {
  it('a hard-edged RING ⇒ high interior ratio, binaryAlpha true, exact counts', () => {
    // 16×16; opaque 1px square ring on x,y ∈ [2,13] (border only), hole + outside fully transparent.
    const onRing = (x: number, y: number): boolean =>
      x >= 2 && x <= 13 && y >= 2 && y <= 13 && (x === 2 || x === 13 || y === 2 || y === 13);
    const ring = rgba(16, 16, (x, y) => (onRing(x, y) ? [200, 50, 50, 255] : [0, 0, 0, 0]));
    const r = alphaShape(ring, 16, 16)!;
    expect(r).not.toBeNull();
    expect(r.bboxW).toBe(12);
    expect(r.bboxH).toBe(12);
    expect(r.opaqueCount).toBe(44); // ring perimeter: 12·4 − 4 corners
    expect(r.interiorTransparent).toBe(144 - 44); // the 10×10 hole = every bbox px not on the ring
    expect(r.binaryAlpha).toBe(true); // hard-edged: every alpha byte is 0 or 255
    expect(r.interiorTransparent / (r.bboxW * r.bboxH)).toBeGreaterThan(0.6); // ring ⇒ high interior ratio
  });

  it('a soft-edged glow ⇒ binaryAlpha false (mid-band alpha bytes use the 8-bit depth)', () => {
    // Same ring, but the hole carries a soft alpha=128 glow — the channel genuinely uses its depth.
    const soft = rgba(8, 8, (x, y) => {
      if (x === 0 || x === 7 || y === 0 || y === 7) return [200, 200, 200, 255];
      return [200, 200, 200, 128];
    });
    const r = alphaShape(soft, 8, 8)!;
    expect(r.binaryAlpha).toBe(false);
    expect(r.interiorTransparent).toBe(0); // alpha 128 > 0 — soft pixels are NOT interior transparency
    expect(r.opaqueCount).toBe(28); // the opaque border only
  });

  it('a solid opaque rect ⇒ ratio 0, opaqueCount = w·h, binaryAlpha true (255-only is binary)', () => {
    const r = alphaShape(rgba(8, 8, () => [10, 20, 30, 255]), 8, 8)!;
    expect(r.bboxW).toBe(8);
    expect(r.bboxH).toBe(8);
    expect(r.interiorTransparent).toBe(0);
    expect(r.opaqueCount).toBe(64);
    expect(r.binaryAlpha).toBe(true);
  });

  it('transparent MARGINS around a solid core ⇒ interiorTransparent 0, bbox SMALLER than the image (trim territory, not holes)', () => {
    // 16×16 with an opaque 8×8 core at [4,11]² — all transparency is OUTSIDE the bbox.
    const core = rgba(16, 16, (x, y) => (x >= 4 && x <= 11 && y >= 4 && y <= 11 ? [90, 90, 90, 255] : [0, 0, 0, 0]));
    const r = alphaShape(core, 16, 16)!;
    expect(r.bboxW).toBe(8);
    expect(r.bboxH).toBe(8);
    expect(r.interiorTransparent).toBe(0); // margins never count — deliberate separation from trim-margin
    expect(r.opaqueCount).toBe(64);
    expect(r.binaryAlpha).toBe(true);
  });

  it('a fully-transparent image ⇒ null (no bbox — nothing to measure, never a fabricated shape)', () => {
    expect(alphaShape(rgba(8, 8, () => [0, 0, 0, 0]), 8, 8)).toBeNull();
  });

  it('short buffer / empty / degenerate dims ⇒ null (never throws, never claims on no data)', () => {
    expect(alphaShape(new Uint8ClampedArray(4), 8, 8)).toBeNull();
    expect(alphaShape([], 8, 8)).toBeNull();
    expect(alphaShape([], 0, 0)).toBeNull();
    expect(alphaShape(rgba(8, 8, () => [0, 0, 0, 255]), 8.5 as unknown as number, 8)).toBeNull();
  });
});

describe('perceptual hashing', () => {
  it('treats a uniform image as flat (zero variance)', () => {
    expect(grayStdDev(flat)).toBe(0);
    expect(isFlat(flat)).toBe(true);
  });

  it('does not flag a textured (gradient) image as flat', () => {
    expect(grayStdDev(gradient)).toBeGreaterThan(6);
    expect(isFlat(gradient)).toBe(false);
  });

  it('produces distinct hashes for distinct content', () => {
    expect(dHashFromGray(gradient)).not.toBe(dHashFromGray(flat));
    expect(dHashFromGray(gradient)).not.toBe(dHashFromGray(reverse));
    expect(dHashFromGray(gradient)).toHaveLength(16);
  });
});

describe('alphaShape holeRects — coarse under-claiming interior-hole map (V1 overlay)', () => {
  // 32×32 ⇒ defaultCell = 8 ⇒ a 4×4 grid; coords below are cell-aligned on purpose.
  const ring32 = rgba(32, 32, (x, y) => {
    const hole = x >= 8 && x < 24 && y >= 8 && y < 24;
    return hole ? [0, 0, 0, 0] : [200, 80, 40, 255];
  });

  it('a cell-aligned ring hole merges to ONE absolute-coords rect', () => {
    const s = alphaShape(ring32, 32, 32)!;
    expect(s.holeRects).toEqual([{ x: 8, y: 8, w: 16, h: 16 }]);
  });

  it('margins-only sprite (opaque core, transparent border) ⇒ NO holeRects (margins are trim territory)', () => {
    const margins = rgba(32, 32, (x, y) => {
      const core = x >= 8 && x < 24 && y >= 8 && y < 24;
      return core ? [200, 80, 40, 255] : [0, 0, 0, 0];
    });
    const s = alphaShape(margins, 32, 32)!;
    expect(s.holeRects).toBeUndefined();
    expect(s.interiorTransparent).toBe(0);
  });

  it('a hole that straddles every cell boundary under-claims to NO rects (never marks a real pixel)', () => {
    const straddle = rgba(32, 32, (x, y) => {
      const hole = x >= 10 && x < 22 && y >= 10 && y < 22; // 12×12, no whole 8px cell fits fully clear
      return hole ? [0, 0, 0, 0] : [200, 80, 40, 255];
    });
    const s = alphaShape(straddle, 32, 32)!;
    expect(s.holeRects).toBeUndefined();
    expect(s.interiorTransparent).toBe(144); // the exact count is untouched — only the coarse map is absent
  });

  it('all-or-nothing cap: a shredded checkerboard of isolated holes emits NO map at all', () => {
    // 256² ⇒ cell 8 ⇒ 32×32 grid; alternating fully-clear cells (odd parity keeps corners opaque ⇒ full
    // bbox) merge into ~512 single-cell rects — far past MAX_HOLE_RECTS ⇒ the field must be ABSENT.
    const board = rgba(256, 256, (x, y) => {
      const c = (x >> 3) + (y >> 3);
      return c % 2 === 1 ? [0, 0, 0, 0] : [200, 80, 40, 255];
    });
    const s = alphaShape(board, 256, 256)!;
    expect(s.holeRects).toBeUndefined();
    expect(s.interiorTransparent).toBeGreaterThan(0);
  });
});
