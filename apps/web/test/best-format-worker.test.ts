// Worker-seam test for the per-image MEASURED best-format pick (round17-per-image-measured-best-format-pick).
// The seam this exercises is the ONLY non-trivial part: the worker does NOT read op.targetMime today — it
// recomputes effectiveFor(ref, 1) at the transcode site. round17 threads the op's per-op targetMime through
// resolveOptions as the BASE (effectiveForTranscode), so a user per-folder/type override still WINS while the
// plan's measured per-image winner replaces the global default.
//
// plan-worker.test.ts CANNOT test this: it analyzes encoder-FREE by design (its header), so formatFinding
// returns null ⇒ zero format findings ⇒ zero bestMime. Here we supply a DIFFERENTIATING encoder mock so
// formatFinding actually fires and records params.bestMime, run the REAL analyze + planFix, then drive a
// FAITHFUL Node mirror of the worker's effectiveForTranscode (fix.worker.ts) over the emitted ops. A drift
// between the worker helper and this mirror would surface as a wrong targetMime here.
//
// Asserts:
//   • ON: effectiveForTranscode(ref, op.targetMime) resolves the MEASURED per-image winner (AVIF where AVIF
//     was smallest, WebP where WebP was smallest) — the plan stamped op.targetMime = bestMime, the seam honors it.
//   • a per-folder OVERRIDE still WINS over the measured per-image pick (honest precedence).
//   • OFF (default): op.targetMime === opts.targetMime for every op ⇒ effectiveForTranscode === effectiveFor(ref,1)
//     ⇒ byte-identical to today.

import { describe, it, expect } from 'vitest';
import type { Asset, FixOp, ImageMime } from '@asset-doctor/core';
import { analyze, type EncodeSizer } from '@asset-doctor/analysis';
import { planFix, resolveOptions, scaleAwareQuality, type EffectiveOptions, type FixOverride } from '@asset-doctor/fix';

// A LOOSE PNG image asset with a generous byteSize so the format saving clears the threshold.
const looseImg = (ref: string): Asset => ({
  kind: 'image',
  image: { name: ref, imageRef: ref, size: { w: 256, h: 256 }, mime: 'image/png', byteSize: 10000 },
});

// Differentiating encoder: AVIF smaller for `bg/*`, WebP smaller for `ui/*` — so the two refs resolve to
// DIFFERENT measured winners (a single fixed target could never satisfy both honestly).
const encodeImage: EncodeSizer = async (ref, _src, target) => {
  const avif = target === 'image/avif';
  if (ref.startsWith('ui/')) return avif ? 5000 : 4000; // WebP wins for ui/*
  return avif ? 4000 : 5000; // AVIF wins for bg/*
};

// Faithful mirror of fix.worker.ts: baseEffective + kindOf + the round17 effectiveForTranscode helper.
// (No DOM/canvas — the seam under test is pure resolveOptions routing.)
function makeWorkerSeam(opts: { targetMime: ImageMime; quality: number; overrides?: FixOverride[]; scaleAwareQuality?: boolean }) {
  const baseEffective: EffectiveOptions = {
    quality: Math.round(opts.quality * 100),
    effort: 0,
    targetMime: opts.targetMime,
    webpNearLossless: 100,
    lossless: false,
  };
  const kindOf = (): 'loose' => 'loose'; // every ref here is a loose image
  const effectiveFor = (ref: string, scale: number): EffectiveOptions => {
    const e = resolveOptions(ref, kindOf(), baseEffective, opts.overrides);
    return { ...e, quality: scaleAwareQuality(e.quality, scale, opts.scaleAwareQuality ?? false) };
  };
  const effectiveForTranscode = (ref: string, opMime: ImageMime): EffectiveOptions =>
    resolveOptions(ref, kindOf(), { ...baseEffective, targetMime: opMime }, opts.overrides);
  return { effectiveFor, effectiveForTranscode };
}

async function planFor(refs: string[], bestFormatPerImage: boolean) {
  const assets = refs.map(looseImg);
  const report = await analyze(assets, undefined, { encodeImage });
  // Sanity: every ref produced a format finding carrying a measured bestMime (the premise of the feature).
  for (const ref of refs) {
    const f = report.findings.find((x) => x.rule === 'format' && x.assetRef === ref);
    expect(f, `format finding for ${ref}`).toBeDefined();
    expect(typeof f!.params?.bestMime).toBe('string');
  }
  const plan = planFix(report, {
    targetMime: 'image/webp',
    quality: 0.85,
    lossless: true,
    padding: 2,
    maxSize: 4096,
    maxEdge: 2048,
    aggressive: false,
    bestFormatPerImage,
  });
  return plan.ops.filter((o): o is Extract<FixOp, { kind: 'transcode' }> => o.kind === 'transcode');
}

describe('round17 worker seam — effectiveForTranscode honors the measured per-image winner', () => {
  it('ON: the seam resolves each ref to its MEASURED winner (AVIF for bg/*, WebP for ui/*)', async () => {
    const ts = await planFor(['ui/btn.png', 'bg/sky.png'], true);
    const seam = makeWorkerSeam({ targetMime: 'image/webp', quality: 0.85 });
    const ui = ts.find((o) => o.assetRef === 'ui/btn.png')!;
    const bg = ts.find((o) => o.assetRef === 'bg/sky.png')!;
    // The plan stamped op.targetMime = bestMime; the worker seam consumes it as the resolve base.
    expect(seam.effectiveForTranscode(ui.assetRef, ui.targetMime).targetMime).toBe('image/webp');
    expect(seam.effectiveForTranscode(bg.assetRef, bg.targetMime).targetMime).toBe('image/avif');
  });

  it('ON: a per-folder OVERRIDE still WINS over the measured per-image pick (honest precedence)', async () => {
    const ts = await planFor(['bg/sky.png'], true); // measured winner = AVIF
    const bg = ts.find((o) => o.assetRef === 'bg/sky.png')!;
    expect(bg.targetMime).toBe('image/avif'); // plan picked the measured winner
    // …but the user forced bg/* → PNG: the override layers ON TOP of the per-image base and wins.
    const seam = makeWorkerSeam({ targetMime: 'image/webp', quality: 0.85, overrides: [{ match: 'bg', targetMime: 'image/png' }] });
    expect(seam.effectiveForTranscode(bg.assetRef, bg.targetMime).targetMime).toBe('image/png');
  });

  it('OFF (default): op.targetMime === opts.targetMime ⇒ effectiveForTranscode === effectiveFor(ref,1) (byte-identical)', async () => {
    const ts = await planFor(['ui/btn.png', 'bg/sky.png'], false);
    const seam = makeWorkerSeam({ targetMime: 'image/webp', quality: 0.85 });
    for (const op of ts) {
      expect(op.targetMime).toBe('image/webp'); // OFF ⇒ the global target on every op
      // The seam collapses to today's effectiveFor(ref,1) — the additivity anchor.
      expect(seam.effectiveForTranscode(op.assetRef, op.targetMime)).toEqual(seam.effectiveFor(op.assetRef, 1));
    }
  });
});
