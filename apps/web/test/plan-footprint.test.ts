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

// strippable-metadata (rules.ts shape): the EXACT header-measured strippable bytes ride on params.bytes +
// estimate.diskBytesSaved. A surviving `strip` op credits `params.bytes` to DISK (never VRAM).
const strippableFinding = (ref: string, bytes: number): Finding => ({
  id: `${ref}:strippable-metadata`,
  rule: 'strippable-metadata',
  severity: bytes >= 65536 ? 'warn' : 'info',
  scope: 'asset',
  assetRef: ref,
  title: 'strippable-metadata',
  detail: '',
  messageKey: 'strippable-metadata',
  params: { label: 'PNG', bytes },
  estimate: { diskBytesSaved: bytes },
});

// Near-duplicate (folder scope, relatedRefs). In aggressive mode planFix (no groups) bare-drops every copy
// after the first — the op the fix-honesty guard below asserts contributes ZERO hard VRAM to the preview.
const duplicateSimilarFinding = (a: string, b: string): Finding => ({
  id: `${a}:dup-similar`,
  rule: 'duplicate-similar',
  severity: 'info',
  scope: 'folder',
  assetRef: a,
  relatedRefs: [a, b],
  title: 'duplicate-similar',
  detail: '',
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
    const r = report([formatFinding('a.png', 10000, 6000)]); // factory bestMime defaults to WebP
    const plan = planFix(r, baseOpts()); // baseOpts targetMime defaults to WebP
    const t = plan.ops.find((o): o is Extract<FixOp, { kind: 'transcode' }> => o.kind === 'transcode');
    expect(t).toBeDefined();
    expect(t!.targetMime).toBe('image/webp'); // op target === finding bestMime ⇒ codec MATCH ⇒ credited
    const fp = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK);
    expect(fp?.diskBytesSaved).toBe(4000);
    expect(fp?.vramBytesSaved).toBe(0);
    expect(fp?.estimated).toBe(true);
    expect(fp?.deferredOps).toBe(0);
  });

  // Fix-honesty (invariant 3): the DISK credit sums `srcBytes − bestBytes` — where `bestBytes` was MEASURED
  // for the strict-smaller FORMAT_TARGETS winner (`bestMime`, CAN be WebP even at an AVIF target). With
  // bestFormatPerImage OFF (default) the run encodes `opts.targetMime`, so crediting the WebP saving at an
  // AVIF target over-claims a saving the run never produces. The preview must credit ONLY on a codec match;
  // a mismatch defers to the honest "sized at download" bucket. These cases pin that gate on the REAL planFix.
  it('OVER-CLAIM guard: bestMime=WebP at an AVIF target (default) is NOT credited — deferred', () => {
    const r = report([formatFinding('a.png', 10000, 6000, 'image/webp')]); // measured winner WebP, saving 4000
    const plan = planFix(r, baseOpts({ targetMime: 'image/avif' })); // default bestFormatPerImage OFF
    const t = plan.ops.find((o): o is Extract<FixOp, { kind: 'transcode' }> => o.kind === 'transcode')!;
    expect(t.targetMime).toBe('image/avif'); // the run encodes AVIF, NOT the credited WebP
    const fp = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK)!;
    expect(fp.diskBytesSaved).toBe(0); // WebP saving withdrawn — target ≠ bestMime
    expect(fp.deferredOps).toBe(1); // the AVIF transcode is "sized at download"
    expect(fp.estimated).toBe(false); // no lossy-format estimate was summed
  });

  it('MATCH: bestMime=AVIF at an AVIF target → credited srcBytes − bestBytes; estimated', () => {
    const r = report([formatFinding('a.png', 10000, 6000, 'image/avif')]); // winner AVIF (the common case)
    const plan = planFix(r, baseOpts({ targetMime: 'image/avif' }));
    const t = plan.ops.find((o): o is Extract<FixOp, { kind: 'transcode' }> => o.kind === 'transcode')!;
    expect(t.targetMime).toBe('image/avif'); // run emits EXACTLY the measured winner
    const fp = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK)!;
    expect(fp.diskBytesSaved).toBe(4000); // codec matches ⇒ credited exactly as before
    expect(fp.estimated).toBe(true);
    expect(fp.deferredOps).toBe(0);
  });

  // Lossless metadata strip (pass 2c): a strippable-metadata ref with a surviving `strip` op credits the
  // EXACT header-measured bytes to DISK — never VRAM (invariant 5), never `estimated` (it's an exact count,
  // not a lossy-encode estimate).
  it('DISK: a strippable ref with a surviving strip op → params.bytes; NOT estimated, NOT VRAM', () => {
    const r = report([strippableFinding('logo.png', 8192)]);
    const plan = planFix(r, baseOpts({ stripMetadata: true }));
    expect(plan.ops.some((o) => o.kind === 'strip' && o.assetRef === 'logo.png')).toBe(true);
    const fp = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK)!;
    expect(fp.diskBytesSaved).toBe(8192);
    expect(fp.vramBytesSaved).toBe(0); // a strip NEVER feeds VRAM (invariant 5)
    expect(fp.estimated).toBe(false); // exact header count, not a lossy estimate
    expect(fp.deferredOps).toBe(0);
  });

  it('a strippable ref with the strip op DESELECTED contributes nothing (mask honored)', () => {
    const r = report([strippableFinding('logo.png', 8192)]);
    const plan = planFix(r, baseOpts({ stripMetadata: true }));
    const fp = summarizeFixPlanFootprint(r, plan.ops, new Set<OpKind>(['strip']));
    expect(fp).toBeUndefined(); // only a deselected strip existed ⇒ nothing knowable ⇒ counts-only card
  });

  it('stripMetadata OFF ⇒ no strip op ⇒ the strippable finding contributes nothing', () => {
    const r = report([strippableFinding('logo.png', 8192)]);
    const plan = planFix(r, baseOpts()); // stripMetadata omitted
    expect(plan.ops.some((o) => o.kind === 'strip')).toBe(false);
    expect(summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK)).toBeUndefined();
  });

  it('bestFormatPerImage ON: op stamps the measured winner ⇒ credited even at a divergent global target', () => {
    const r = report([formatFinding('a.png', 10000, 6000, 'image/webp')]); // winner WebP
    const plan = planFix(r, baseOpts({ targetMime: 'image/avif', bestFormatPerImage: true }));
    const t = plan.ops.find((o): o is Extract<FixOp, { kind: 'transcode' }> => o.kind === 'transcode')!;
    expect(t.targetMime).toBe('image/webp'); // plan.ts routes the op to the measured winner ⇒ codec MATCH
    const fp = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK)!;
    expect(fp.diskBytesSaved).toBe(4000); // credited — the run WILL emit the format bestBytes measured
    expect(fp.estimated).toBe(true);
    expect(fp.deferredOps).toBe(0);
  });

  it('format ∩ wasted-alpha, codec MISMATCH → deferred once, wasted-alpha NOT double-credited', () => {
    const ref = 'opaque.png';
    const r = report([formatFinding(ref, 10000, 6000, 'image/webp'), wastedAlphaFinding(ref, 10000, 7000)]);
    const plan = planFix(r, baseOpts({ targetMime: 'image/avif', opaqueAlpha: true }));
    const transcodes = plan.ops.filter((o) => o.kind === 'transcode');
    expect(transcodes.length).toBe(1); // single opaque AVIF transcode (wasted-alpha folded in)
    const fp = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK)!;
    expect(fp.diskBytesSaved).toBe(0); // WebP-winner saving withdrawn; wasted-alpha delta not summed behind our back
    expect(fp.deferredOps).toBe(1); // counted once (the format branch owns this ref's disk attribution)
  });

  it('DETERMINISM (codec-mismatch input): same input ⇒ deep-equal output', () => {
    const mk = (): AnalysisReport => report([formatFinding('a.png', 10000, 6000, 'image/webp')]);
    const a = summarizeFixPlanFootprint(mk(), planFix(mk(), baseOpts({ targetMime: 'image/avif' })).ops, EMPTY_MASK);
    const b = summarizeFixPlanFootprint(mk(), planFix(mk(), baseOpts({ targetMime: 'image/avif' })).ops, EMPTY_MASK);
    expect(a).toEqual(b);
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

  // Fix-honesty (near-dup drop VRAM) — PREVIEW↔RECEIPT parity guard (invariants 3 & 5). A bare duplicate drop
  // (ownerRef undefined, no auto-repoint) must claim ZERO HARD VRAM in the preview — it is neither a measured-now
  // delta (transcode/resize) nor a deferred pack/repack/merge/dedup. This pins the honest reference the receipt's
  // vramBytesAfter is coded to MATCH: the dropped copy's w·h·4 is routed to a SEPARATE upper bound in the worker,
  // never into the hard claim. (Regression guard: were the drop ever summed as hard VRAM here — or in the receipt —
  // the two would disagree and this would fail.)
  it('near-dup BARE drop claims 0 HARD VRAM (not measured-now, not deferred) → footprint undefined', () => {
    const r = report([duplicateSimilarFinding('a.png', 'b.png')]);
    const plan = planFix(r, baseOpts({ aggressive: true }));
    // planFix (no groups) emits a BARE drop for the second copy — ownerRef undefined ⇒ NOT owner-aware dedup.
    const drops = plan.ops.filter((o): o is Extract<FixOp, { kind: 'drop' }> => o.kind === 'drop');
    expect(drops).toHaveLength(1);
    expect(drops[0]!.assetRef).toBe('b.png');
    expect(drops[0]!.ownerRef).toBeUndefined(); // bare drop (the ownerRef==null fold site in fix.worker.ts)
    // The preview sums NO hard VRAM for it and does NOT count it as a deferred op ⇒ nothing knowable ⇒ undefined.
    const fp = summarizeFixPlanFootprint(r, plan.ops, EMPTY_MASK);
    expect(fp).toBeUndefined();
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
