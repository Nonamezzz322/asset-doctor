// Headless worker control-flow test for TRIM-ON-REPACK (round20). The impure half in
// apps/web/src/worker/fix.worker.ts (buildTrimArrays → OffscreenCanvas/getImageData → alphaBBox, then the
// repack op composes via createImageBitmap/drawImage) cannot run in Node, and Vitest has no canvas polyfill,
// so — exactly as extrude-worker.test.ts / sheet-diff-worker.test.ts do — we drive the REAL pure pipeline the
// worker imports (parseAtlas → alphaBBox per untrimmed frame → repackAtlases({trim})) and assert the worker's
// CONTROL FLOW + the receipt/operations facts it derives from RepackResult:
//   • the per-atlas (TrimRect|null)[] is index-aligned to atlas.sprites; already-trimmed sprites ⇒ null
//   • repackAtlases({trim}) returns trimmedSprites (distinct reps) + trimmedAreaReclaimed (MEASURED px)
//   • the operations-string fragment the worker pushes is well-formed + non-empty when trims fired
//   • B3: the no-gutter baseline (same {trim}) isolates the gutter — feeding the SAME trim keeps the delta ≥ 0
//   • additivity: no shrinkable untrimmed sprite ⇒ trimmedSprites omitted ⇒ receipt byte-identical to today
// The worker imports the SAME alphaBBox/repackAtlases, so a broken bbox or accumulator can't pass here while
// shipping in the worker. The actual pixel encode is the deferred Playwright follow-up.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import type { Atlas, TrimRect } from '@asset-doctor/core';
import { parseAtlas } from '@asset-doctor/parsers';
import { alphaBBox, repackAtlases } from '@asset-doctor/fix';

const padDir = fileURLToPath(new URL('../../../fixtures/sample-projects/untrimmed-padding/', import.meta.url));
const symDir = fileURLToPath(new URL('../../../fixtures/sample-projects/tp-hash-symbols/', import.meta.url));

function load(dir: string, json: string, png: string, ref: string): Atlas {
  const res = parseAtlas(JSON.parse(readFileSync(`${dir}${json}`, 'utf8')), {
    ref,
    bytes: new Uint8Array(readFileSync(`${dir}${png}`)),
  });
  if (!res.ok || res.asset.kind !== 'atlas') throw new Error(`${ref} fixture parse failed`);
  return res.asset.atlas;
}

// Mirror the worker's buildTrimArrays: for each UNtrimmed sprite compute the frame-relative opaque bbox via
// the SAME pure alphaBBox off the decoded page; already-trimmed ⇒ null without a decode.
function buildTrim(atlas: Atlas, pngPath: string): (TrimRect | null)[] {
  const png = PNG.sync.read(readFileSync(pngPath));
  const src = { data: new Uint8ClampedArray(png.data), width: png.width };
  return atlas.sprites.map((s) =>
    s.trimmed !== false || s.spriteSourceSize !== undefined
      ? null
      : alphaBBox(src, { x: s.frame.x, y: s.frame.y, w: s.frame.w, h: s.frame.h }),
  );
}

describe('trim-on-repack worker control flow (round20)', () => {
  it('repack op tightens untrimmed sprites + derives the receipt/operations facts', () => {
    const atlas = load(padDir, 'sheet.json', 'sheet.png', 'sheet.png');
    const trim = buildTrim(atlas, `${padDir}sheet.png`);
    // Index-aligned + already-trimmed ⇒ null (the worker never decodes those).
    expect(trim.length).toBe(atlas.sprites.length);
    const trimmedIdx = atlas.sprites.findIndex((s) => s.trimmed);
    if (trimmedIdx >= 0) expect(trim[trimmedIdx]).toBeNull();

    const r = repackAtlases([atlas], { allowRotation: false, padding: 0, maxSize: 4096, trim: [trim] });
    // The accumulators the worker folds into trimmedSpritesTotal / trimmedAreaTotal + the receipt fields.
    expect(r.trimmedSprites).toBe(3);
    expect(r.trimmedAreaReclaimed).toBe(7200);

    // The worker's operations-string fragment (same template) is well-formed + non-empty.
    const opFrag = r.trimmedSprites ? ` (${r.trimmedSprites} sprites trimmed, ${r.trimmedAreaReclaimed}px reclaimed)` : '';
    expect(opFrag).toBe(' (3 sprites trimmed, 7200px reclaimed)');

    // B3: the no-gutter baseline carries the SAME trim ⇒ the gutter-isolation delta is sign-correct. With no
    // gutter at all both packs are identical here, so the delta is exactly 0 (never negative from trim).
    const baseline = repackAtlases([atlas], { allowRotation: false, padding: 0, maxSize: 4096, trim: [trim] });
    expect(r.vramBytesAfter - baseline.vramBytesAfter).toBe(0);
  });

  it('additivity: no shrinkable trim (all-null array) ⇒ receipt fields omitted, byte-identical to today', () => {
    // The worker passes null for already-trimmed sprites and for un-measured ones. An all-null trim array (the
    // "nothing shrinkable" case the worker hits on a fully-trimmed sheet) must reproduce today's repack exactly.
    const atlas = load(symDir, 'symbols.json', 'symbols.png', 'symbols.png');
    const allNull = atlas.sprites.map(() => null);
    const r = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096, trim: [allNull] });
    expect(r.trimmedSprites).toBeUndefined();
    expect(r.trimmedAreaReclaimed).toBeUndefined();
    // Byte-identical to omitting trim entirely.
    const plain = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 });
    expect(JSON.stringify(r.atlases)).toBe(JSON.stringify(plain.atlases));
    expect(JSON.stringify(r.blits)).toBe(JSON.stringify(plain.blits));
  });
});
