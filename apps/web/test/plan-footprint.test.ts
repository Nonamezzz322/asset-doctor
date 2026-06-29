// Pure unit test for summarizeFixPlanFootprint (round22 #2, docs/improvements/round22-honest-fix-simulation-
// footprint-pr.md) — the PRIMARY coverage (encoder-free). We hand-build real `Finding` shapes (the MEASURED
// params planFix + the aggregator consume: format srcBytes/bestBytes, wasted-alpha srcBytes/opaqueBytes,
// dimensions-oversize w/h/vram) + drive the REAL planFix to get real FixOps, then assert the honest buckets.
//
// HONESTY (invariants 3 & 5) asserted here, where inputs are fully controlled:
//   • disk = srcBytes − bestBytes for a format ref with a transcode op; estimated===true.
//   • VRAM = params.vram − to.w·to.h·4 for an oversize ref with a resize op (EXACT).
//   • invariant-5 SEPARATION: a transcode never feeds vramBytesSaved; a resize never feeds diskBytesSaved.
//   • disk ≠ VRAM (distinct buckets, never conflated).
//   • op-GATED: a format ref ALSO repacked ⇒ no transcode op ⇒ contributes 0 disk.
//   • format ∩ wasted-alpha same ref ⇒ ONE opaque transcode ⇒ counted once.
//   • mask: excluded {'transcode'} zeroes disk; {'resize'} zeroes VRAM.
//   • BLOCKER-1 regression: npot/solid finding present + no resize op ⇒ 0 VRAM (no op exists for them).
//   • deferredOps counts repack/merge/pack/dedup.
//   • empty / counts-only plan ⇒ undefined (additive — the card stays counts-only).
//   • DETERMINISM: same input ⇒ deep-equal output.

import { describe, it, expect } from 'vitest';
import type { AnalysisReport, Finding, FixOp, ImageMime } from '@asset-doctor/core';
import { DEFAULT_THRESHOLDS } from '@asset-doctor/analysis';
import { planFix, type PlanOptions } from '@asset-doctor/fix';
import { summarizeFixPlanFootprint } from '../src/lib/plan-footprint';
import type { OpKind } from '../src/lib/op-manifest';

const vram = (w: number, h: number): number => w * h * 4;

// ── finding factories (real shapes from packages/analysis/src/rules.ts) ────────────────────────────
const formatFinding = (ref: string, srcBytes: number, bestBytes: number, bestMime: ImageMime = 'image/webp'): Finding => ({
  id: `${ref}:format`,
  rule: 'format',
  severity: 'warn',
  scope: 'asset',
  assetRef: ref,
  title: 'format',
  detail: '',
  messageKey: 'format',
  params: { srcBytes, bestBytes, saved: srcBytes - bestBytes, bestMime },
});

const wastedAlphaFinding = (ref: string, srcBytes: number, opaqueBytes: number): Finding => ({
  id: `${ref}:wasted-alpha`,
  rule: 'wasted-alpha',
  severity: 'warn',
  scope: 'asset',
  assetRef: ref,
  title: 'wasted-alpha',
  detail: '',
  messageKey: 'wasted-alpha',
  params: { srcLabel: 'PNG', srcBytes, opaqueBytes, saved: srcBytes - opaqueBytes, frac: 0.1 },
});

const oversizeFinding = (ref: string, w: number, h: number): Finding => ({
  id: `${ref}:oversize`,
  rule: 'dimensions-oversize',
  severity: 'crit',
  scope: 'asset',
  assetRef: ref,
  title: 'oversize',
  detail: '',
  messageKey: 'oversize',
  params: { w, h, edge: Math.max(w, h), budget: 2048, sev: 'crit', vram: vram(w, h) },
});

const occupancyFinding = (ref: string): Finding => ({
  id: `${ref}:occupancy`,
  rule: 'occupancy',
  severity: 'warn',
  scope: 'asset',
  assetRef: ref,
  title: 'occupancy',
  detail: '',
  messageKey: 'occupancy',
  params: { occ: 0.2, wasted: 0.8, frames: 3, w: 256, h: 256, vram: vram(256, 256) },
});

const npotFinding = (ref: string, w: number, h: number): Finding => ({
  id: `${ref}:npot`,
  rule: 'dimensions-npot',
  severity: 'info',
  scope: 'asset',
  assetRef: ref,
  title: 'npot',
  detail: '',
  messageKey: 'npot',
  params: { w, h, potW: 1024, potH: 1024, waste: 0.5, vram: 1000000 },
  estimate: { vramBytesSaved: 1000000 },
});

const solidFinding = (ref: string, w: number, h: number): Finding => ({
  id: `${ref}:solid`,
  rule: 'solid-fill',
  severity: 'warn',
  scope: 'asset',
  assetRef: ref,
  title: 'solid',
  detail: '',
  messageKey: 'solid-fill',
  params: { w, h, vram: vram(w, h) },
  estimate: { vramBytesSaved: vram(w, h) - 4 },
});

const report = (findings: Finding[]): AnalysisReport => ({
  assets: [],
  findings,
  totals: {
    diskBytes: 0,
    vramBytes: 0,
    vramBytesMipmapped: 0,
    loadedVramBytes: 0,
    loadedVramBytesMipmapped: 0,
    potentialDiskSaved: 0,
  },
  thresholds: DEFAULT_THRESHOLDS,
});

const baseOpts = (over: Partial<PlanOptions> = {}): PlanOptions => ({
  targetMime: 'image/webp',
  quality: 0.85,
  lossless: false,
  padding: 2,
  maxSize: 4096,
  maxEdge: 2048,
  aggressive: false,
  ...over,
});

const EMPTY_MASK: ReadonlySet<OpKind> = new Set();

describe('summarizeFixPlanFootprint — honest pre-compose footprint buckets (round22 #2)', () => {
  it('DISK: a format ref with a surviving transcode op → srcBytes − bestBytes; estimated', () => {
    const r = report([formatFinding('a.png', 10000, 6000)]);
    const plan = planFix(r, baseOpts());
    expect(plan.ops.some((o) => o.kind === 'transcode')).toBe(true);
    const fp = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK);
    expect(fp?.diskBytesSaved).toBe(4000);
    expect(fp?.vramBytesSaved).toBe(0);
    expect(fp?.estimated).toBe(true);
    expect(fp?.deferredOps).toBe(0);
  });

  it('VRAM: an oversize ref with a surviving resize op → params.vram − to.w·to.h·4 (EXACT)', () => {
    const r = report([oversizeFinding('big.png', 4096, 2048)]); // longest 4096 > maxEdge 2048
    const plan = planFix(r, baseOpts());
    const resize = plan.ops.find((o): o is Extract<FixOp, { kind: 'resize' }> => o.kind === 'resize');
    expect(resize).toBeDefined();
    const expected = vram(4096, 2048) - resize!.to.w * resize!.to.h * 4;
    const fp = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK);
    expect(fp?.vramBytesSaved).toBe(expected);
    expect(fp?.diskBytesSaved).toBe(0); // a resize NEVER feeds disk (invariant-5 separation)
    expect(fp?.estimated).toBe(false); // no format estimate involved
  });

  it('invariant-5 SEPARATION + disk ≠ VRAM: a mixed plan keeps the two buckets distinct', () => {
    const r = report([formatFinding('a.png', 10000, 6000), oversizeFinding('big.png', 4096, 2048)]);
    const plan = planFix(r, baseOpts());
    const resize = plan.ops.find((o): o is Extract<FixOp, { kind: 'resize' }> => o.kind === 'resize')!;
    const fp = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK)!;
    expect(fp.diskBytesSaved).toBe(4000); // only the transcode delta
    expect(fp.vramBytesSaved).toBe(vram(4096, 2048) - resize.to.w * resize.to.h * 4); // only the resize delta
    expect(fp.diskBytesSaved).not.toBe(fp.vramBytesSaved); // distinct, never conflated
  });

  it('op-GATED: a format ref ALSO repacked (occupancy) → no transcode op → 0 disk', () => {
    // The same ref earns an occupancy (→ repack) AND a format finding; planFix's `repacked` guard suppresses
    // the standalone transcode, so the format delta is NOT knowable as a separate disk win → excluded.
    const ref = 'sheet.png';
    const r = report([occupancyFinding(ref), formatFinding(ref, 10000, 6000)]);
    const plan = planFix(r, baseOpts());
    expect(plan.ops.some((o) => o.kind === 'transcode')).toBe(false); // repack ate it
    expect(plan.ops.some((o) => o.kind === 'repack')).toBe(true);
    const fp = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK)!;
    expect(fp.diskBytesSaved).toBe(0); // op-gated to 0
    expect(fp.deferredOps).toBe(1); // the repack is "computed at download"
  });

  it('format ∩ wasted-alpha same ref → ONE opaque transcode → disk counted once', () => {
    const ref = 'opaque.png';
    const r = report([formatFinding(ref, 10000, 6000), wastedAlphaFinding(ref, 10000, 7000)]);
    const plan = planFix(r, baseOpts({ opaqueAlpha: true }));
    const transcodes = plan.ops.filter((o) => o.kind === 'transcode');
    expect(transcodes.length).toBe(1); // single opaque transcode
    const fp = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK)!;
    // counted once via the format branch (srcBytes − bestBytes), NOT also the wasted-alpha delta.
    expect(fp.diskBytesSaved).toBe(4000);
  });

  it('mask: excluding transcode zeroes disk; excluding resize zeroes VRAM', () => {
    const r = report([formatFinding('a.png', 10000, 6000), oversizeFinding('big.png', 4096, 2048)]);
    const plan = planFix(r, baseOpts());
    const noTranscode = summarizeFixPlanFootprint(r, plan.ops, new Set<OpKind>(['transcode']))!;
    expect(noTranscode.diskBytesSaved).toBe(0);
    expect(noTranscode.vramBytesSaved).toBeGreaterThan(0);
    const noResize = summarizeFixPlanFootprint(r, plan.ops, new Set<OpKind>(['resize']))!;
    expect(noResize.vramBytesSaved).toBe(0);
    expect(noResize.diskBytesSaved).toBeGreaterThan(0);
  });

  it('BLOCKER-1 regression: npot/solid findings + no resize op → 0 VRAM (no op exists for them)', () => {
    // planFix emits NO op for dimensions-npot or solid-fill. A standalone npot/solid asset gets no plan op
    // at all, so the footprint must be undefined — never a fabricated POT-padding / 1×1 VRAM win.
    const r = report([npotFinding('np.png', 1000, 1000), solidFinding('solid.png', 2048, 2048)]);
    const plan = planFix(r, baseOpts());
    expect(plan.ops.length).toBe(0); // no op for npot/solid
    const fp = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK);
    expect(fp).toBeUndefined();
  });

  it('BLOCKER-1 regression: a resize coincident with an npot ref does NOT add the npot estimate', () => {
    // An oversize ref that is ALSO NPOT gets a resize (for the OVERSIZE reclaim). The npot estimate is a
    // DIFFERENT, conditional baseline (POT padding) — the VRAM bucket must be exactly the oversize×resize
    // delta, never oversize + npot.
    const ref = 'big.png';
    const r = report([oversizeFinding(ref, 4096, 2048), npotFinding(ref, 4096, 2048)]);
    const plan = planFix(r, baseOpts());
    const resize = plan.ops.find((o): o is Extract<FixOp, { kind: 'resize' }> => o.kind === 'resize')!;
    const fp = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK)!;
    expect(fp.vramBytesSaved).toBe(vram(4096, 2048) - resize.to.w * resize.to.h * 4); // ONLY the resize delta
  });

  it('deferredOps counts repack/merge/pack/dedup (sized at download), never summed into disk/VRAM', () => {
    // two under-filled atlases merged (aggressive) → a merge op; plus a single-atlas occupancy → repack.
    const r = report([occupancyFinding('s1.png'), occupancyFinding('s2.png')]);
    const plan = planFix(r, baseOpts());
    const fp = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK)!;
    expect(fp.deferredOps).toBe(2); // two repacks
    expect(fp.diskBytesSaved).toBe(0);
    expect(fp.vramBytesSaved).toBe(0);
  });

  it('empty plan / counts-only → undefined (additive: card stays counts-only)', () => {
    expect(summarizeFixPlanFootprint(report([]), [], EMPTY_MASK)).toBeUndefined();
  });

  it('DETERMINISM: same input ⇒ deep-equal output', () => {
    const r = report([formatFinding('a.png', 10000, 6000), oversizeFinding('big.png', 4096, 2048), occupancyFinding('s.png')]);
    const plan = planFix(r, baseOpts());
    const a = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK);
    const b = summarizeFixPlanFootprint(report([formatFinding('a.png', 10000, 6000), oversizeFinding('big.png', 4096, 2048), occupancyFinding('s.png')]), planFix(report([formatFinding('a.png', 10000, 6000), oversizeFinding('big.png', 4096, 2048), occupancyFinding('s.png')]), baseOpts()).ops, EMPTY_MASK);
    expect(a).toEqual(b);
  });

  it('clamps negative deltas to 0 (a transcode that would grow bytes contributes 0, never negative)', () => {
    const r = report([formatFinding('a.png', 6000, 10000)]); // bestBytes > srcBytes (degenerate)
    const plan = planFix(r, baseOpts());
    const fp = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK);
    // disk clamps to 0; with no other contribution and no deferred ops → undefined.
    expect(fp).toBeUndefined();
  });
});
