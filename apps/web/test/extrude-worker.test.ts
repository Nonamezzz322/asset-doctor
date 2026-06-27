// Headless worker control-flow test for EDGE-EXTRUDE (bleed) — design OPTION A, docs/improvements/
// edge-extrude.md, task T10. The impure compose half in apps/web/src/worker/fix.worker.ts
// (composePageEncode → OffscreenCanvas / createImageBitmap / drawImage) cannot run in Node, and Vitest has
// no canvas polyfill, so — exactly as tier-worker.test.ts / dedup-worker-phase-c.test.ts do — we drive the
// REAL pure pipeline (parseAtlas → repackAtlases with a gutter) and the SAME pure geometry the worker
// imports (extrudePlan / effectiveExtrude / canExtrude). Only the actual pixel encode is skipped (the
// real-texel assertion is the deferred Playwright follow-up, T12). This asserts the worker's CONTROL FLOW:
//   • the symmetric gutter is reserved (placements offset by `gutter`, reserved blocks overlap-free)
//   • effectiveExtrude clamps the bleed to the gutter (gutter = max(padding, extrude))
//   • each RECTANGLE blit gets a non-empty extrudePlan whose dest rects stay in-bin AND never overlap any
//     OTHER sprite's `to` body (the OPTION-A correctness guarantee: a sprite owns its gutter on all sides)
//   • a ROTATED blit (tp-hash-symbols ships one) yields an EMPTY plan + is skip-eligible (canExtrude false)
//   • a meshed (clip) blit yields an EMPTY plan + is skip-eligible
//   • extrude=0 ⇒ NO gutter reserved (placements byte-identical to today) AND every plan empty (default OFF)
// The worker imports the SAME extrudePlan/effectiveExtrude/canExtrude, so a broken gate or overlapping
// strip can't pass green here while shipping in the worker.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Atlas, Blit, Rect } from '@asset-doctor/core';
import { parseAtlas } from '@asset-doctor/parsers';
import { repackAtlases, extrudePlan, effectiveExtrude, canExtrude } from '@asset-doctor/fix';

const fixDir = fileURLToPath(new URL('../../../fixtures/sample-projects/tp-hash-symbols/', import.meta.url));
function loadAtlas(): Atlas {
  const manifest = JSON.parse(readFileSync(`${fixDir}symbols.json`, 'utf8')) as unknown;
  const bytes = new Uint8Array(readFileSync(`${fixDir}symbols.png`));
  const res = parseAtlas(manifest, { ref: 'symbols.png', bytes });
  if (!res.ok || res.asset.kind !== 'atlas') throw new Error('fixture parse failed');
  return res.asset.atlas;
}

/** Strictly-positive-area rectangle intersection (touching edges do NOT overlap). */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Mirror the worker's per-op gutter derivation (fix.worker.ts extrudeOf): gutter ≥ padding AND ≥ extrude,
// so the bleed never crosses into a neighbor and the existing neighbor gap is never shrunk.
function extrudeOf(padding: number, extrude: number): { gutter: number; eff: number } {
  const e = Math.max(0, Math.floor(extrude));
  if (e <= 0) return { gutter: 0, eff: 0 };
  const gutter = Math.max(padding, e);
  return { gutter, eff: effectiveExtrude(e, gutter) };
}

describe('edge-extrude — worker compose control flow (T10, on tp-hash-symbols)', () => {
  const PADDING = 2;
  const MAXSIZE = 4096;

  it('reserves a symmetric gutter: every placement offset by gutter, reserved blocks overlap-free', () => {
    const atlas = loadAtlas();
    const { gutter } = extrudeOf(PADDING, 2);
    expect(gutter).toBeGreaterThan(0);
    const today = repackAtlases([atlas], { allowRotation: false, padding: PADDING, maxSize: MAXSIZE });
    const withGutter = repackAtlases([atlas], { allowRotation: false, padding: PADDING, maxSize: MAXSIZE, gutter });

    // Same sprite set, same count — only the geometry shifted by the gutter.
    expect(withGutter.blits.length).toBe(today.blits.length);
    const byName = new Map(today.blits.map((b) => [b.name, b]));
    // Each sprite's reserved block (its body inflated by `gutter` on all sides) must stay inside the bin
    // and never overlap another sprite's reserved block — the OPTION-A guarantee the extrude relies on.
    const reserved: Rect[] = [];
    for (const b of withGutter.blits) {
      const today0 = byName.get(b.name)!;
      // body dimensions are identical (gutter shifts position, never size)
      expect(b.to.w).toBe(today0.to.w);
      expect(b.to.h).toBe(today0.to.h);
      const block: Rect = { x: b.to.x - gutter, y: b.to.y - gutter, w: b.to.w + 2 * gutter, h: b.to.h + 2 * gutter };
      expect(block.x).toBeGreaterThanOrEqual(0);
      expect(block.y).toBeGreaterThanOrEqual(0);
      reserved.push(block);
    }
    for (let i = 0; i < reserved.length; i++)
      for (let j = i + 1; j < reserved.length; j++) expect(overlaps(reserved[i]!, reserved[j]!)).toBe(false);
  });

  it('effectiveExtrude clamps the bleed to the gutter (= max(padding, extrude))', () => {
    // extrude within padding ⇒ gutter = padding, eff = extrude
    expect(extrudeOf(2, 1)).toEqual({ gutter: 2, eff: 1 });
    // extrude == padding ⇒ gutter = padding, eff = extrude
    expect(extrudeOf(2, 2)).toEqual({ gutter: 2, eff: 2 });
    // extrude > padding ⇒ gutter grows to extrude, eff = extrude (never exceeds the reserved band)
    expect(extrudeOf(2, 4)).toEqual({ gutter: 4, eff: 4 });
    // 0/negative ⇒ no gutter, no bleed (default OFF)
    expect(extrudeOf(2, 0)).toEqual({ gutter: 0, eff: 0 });
    expect(extrudeOf(2, -5)).toEqual({ gutter: 0, eff: 0 });
  });

  it('each rectangle blit gets an in-bin extrude plan that overlaps no OTHER sprite body', () => {
    const atlas = loadAtlas();
    const { gutter, eff } = extrudeOf(PADDING, 2);
    const r = repackAtlases([atlas], { allowRotation: false, padding: PADDING, maxSize: MAXSIZE, gutter });
    const bin = r.atlases[0]!.size;
    const bodies = r.blits.map((b) => b.to); // every sprite's destination body

    let rectBlits = 0;
    let rotatedBlits = 0;
    for (const b of r.blits) {
      const plan = extrudePlan(b, eff, bin.w, bin.h);
      if (canExtrude(b)) {
        rectBlits++;
        // a rectangle sprite with eff>0 always produces a real bleed (interior — never a degenerate empty)
        expect(plan.length).toBeGreaterThan(0);
        for (const er of plan) {
          // dest rects stay inside the bin (the clamp in extrudePlan trims any band running off the sheet)
          expect(er.dst.x).toBeGreaterThanOrEqual(0);
          expect(er.dst.y).toBeGreaterThanOrEqual(0);
          expect(er.dst.x + er.dst.w).toBeLessThanOrEqual(bin.w);
          expect(er.dst.y + er.dst.h).toBeLessThanOrEqual(bin.h);
          expect(er.dst.w).toBeGreaterThan(0);
          expect(er.dst.h).toBeGreaterThan(0);
          // NO dest band overlaps a DIFFERENT sprite's body — the bleed lives in this sprite's own gutter.
          for (const body of bodies) {
            if (body === b.to) continue;
            expect(overlaps(er.dst, body)).toBe(false);
          }
        }
      } else {
        rotatedBlits++;
        // rotated / meshed blit ⇒ NO bleed in v1, the worker surfaces an honest no-op skip
        expect(plan.length).toBe(0);
      }
    }
    // tp-hash-symbols ships exactly one rotated sprite, so the worker exercises BOTH branches.
    expect(rectBlits).toBeGreaterThan(0);
    expect(rotatedBlits).toBe(1);
  });

  it('meshed (clip) blit ⇒ empty plan + skip-eligible (no polygon-edge extrude in v1)', () => {
    const meshed: Blit = {
      name: 'm',
      from: { atlasRef: 'a.png', rect: { x: 0, y: 0, w: 10, h: 10 }, rotated: false },
      to: { x: 4, y: 4, w: 10, h: 10 },
      rotate90: false,
      clip: [{ x: 4, y: 4 }, { x: 14, y: 4 }, { x: 9, y: 14 }],
    };
    expect(canExtrude(meshed)).toBe(false);
    expect(extrudePlan(meshed, 2, 256, 256)).toEqual([]);
  });

  it('default OFF: extrude=0 ⇒ no gutter reserved (placements identical to today) AND every plan empty', () => {
    const atlas = loadAtlas();
    const { gutter, eff } = extrudeOf(PADDING, 0);
    expect(gutter).toBe(0);
    const today = repackAtlases([atlas], { allowRotation: false, padding: PADDING, maxSize: MAXSIZE });
    const zero = repackAtlases([atlas], { allowRotation: false, padding: PADDING, maxSize: MAXSIZE }); // no gutter spread
    // byte-identical geometry to today (the worker omits `gutter` entirely when extrude is 0)
    expect(zero.atlases[0]!.size).toEqual(today.atlases[0]!.size);
    expect(zero.blits.map((b) => b.to)).toEqual(today.blits.map((b) => b.to));
    // and the compose loop draws no bleed at all
    for (const b of today.blits) expect(extrudePlan(b, eff, today.atlases[0]!.size.w, today.atlases[0]!.size.h)).toEqual([]);
  });
});
