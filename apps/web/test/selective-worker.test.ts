// Headless worker-pipeline test for SELECTIVE FIX (docs/improvements/selective-fix.md, design test plan
// T4). The impure execute loop in apps/web/src/worker/fix.worker.ts (createImageBitmap / OffscreenCanvas)
// can't run in Node, so — exactly as tier-worker.test.ts / dedup-worker-phase-c.test.ts do — we drive the
// REAL pure pipeline (groupFiles → parse → planFix) over the authored tier-source fixture and a faithful
// node re-implementation of the worker's kind-FILTER CONTROL FLOW. Only the actual pixel encode is skipped
// (irrelevant to which ops run / which surface as skipped).
//
// The filter reuses the SAME pure helpers the worker imports (fixOpKind / deselectedSkips / isOwnerAwareDrop),
// so a broken filter, a drifted op→kind split, or a missing honest skip can't pass green here while shipping
// in fix.worker.ts. Asserts the BINDING from the design:
//   • excludeKinds empty/absent ⇒ the op set that RUNS is byte-identical to today (the additive default)
//   • excludeKinds = [kinds] ⇒ ONLY the non-excluded ops run; every deselected-and-would-run kind surfaces
//     ONE honest "<kind> skipped: deselected in plan" note (never a silent drop; counts reflect what ran)
//   • tier exclusion gates the worker-side tier MULTIPLIER (a gated loop, never a FixOp) — tierExcluded
//     short-circuits the tier loop AND its tier-context skips
//   • HONESTY: the receipt's skipped[] surfaces the deselected kinds; nothing is faked
//   • the Phase-A owner-final-name cross-dependency: a DESELECTED transcode op must NOT be predicted as
//     transcoding an owner (else dedup silently degrades to keep-consumer) — masked with runs(op)

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import type { Asset, Atlas, FixOp } from '@asset-doctor/core';
import { groupFiles, keyOf, type RawFile } from '@asset-doctor/ingest';
import { parseAtlas, parseImage, parseSpineAtlasText, parseSpinePage, type SpinePage } from '@asset-doctor/parsers';
import { analyze, mergeSharedAtlases, hasResolutionToken } from '@asset-doctor/analysis';
import { planFix, validateTiers, DEFAULT_SCALE_TIERS, resolveImageRef, isOwnerAwareDrop } from '@asset-doctor/fix';
import { fixOpKind, deselectedSkips, type OpKind } from '../src/lib/op-manifest';
import type { FixOptions } from '../src/worker/fix-protocol';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/sample-projects/tier-source');

// ── load the fixture as the worker sees it: RawFile[] with dir-aware paths ──────────────────────────
function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
function loadRawFiles(): RawFile[] {
  return walk(FIXTURE)
    .map((abs) => relative(FIXTURE, abs).split('\\').join('/'))
    .filter((rel) => !rel.endsWith('expected.json') && !rel.endsWith('README.md'))
    .sort()
    .map((rel) => ({ name: rel.split('/').pop()!, path: rel, bytes: new Uint8Array(readFileSync(join(FIXTURE, rel))).buffer }));
}

// ── build the worker's data structures via the REAL pure pipeline (mirrors fix.worker.ts:106-184) ────
interface Built {
  merged: Asset[];
  pathByRef: Map<string, string>;
  spineRefs: Set<string>;
  atlasByRef: Map<string, Atlas>;
  spineInfoOf: (ref: string) => { path: string; pages: number } | undefined;
  report: Awaited<ReturnType<typeof analyze>>;
}
async function buildWorkerState(files: RawFile[]): Promise<Built> {
  const grouped = groupFiles(files);
  const assets: Asset[] = [];
  const pathByRef = new Map<string, string>();
  const spineRefs = new Set<string>();
  for (const a of grouped.atlases) {
    const image = { ref: a.name, bytes: new Uint8Array(a.image.bytes) };
    const res = a.kind === 'spine' ? parseSpinePage(a.manifest as SpinePage, image, { name: a.name }) : parseAtlas(a.manifest, image, { name: a.name });
    if (res.ok && res.asset.kind === 'atlas') {
      assets.push(res.asset);
      pathByRef.set(res.asset.atlas.name, a.image.path ?? a.image.name);
      if (a.kind === 'spine') spineRefs.add(res.asset.atlas.name);
    }
  }
  for (const im of grouped.images) {
    const ref = keyOf(im);
    const res = parseImage(ref, new Uint8Array(im.bytes));
    if (res.ok && res.asset.kind === 'image') {
      assets.push(res.asset);
      pathByRef.set(res.asset.image.name, im.path ?? im.name);
    }
  }
  const td = new TextDecoder();
  const spineAtlasInfo = new Map<string, { path: string; pages: number }>();
  for (const f of files) {
    if (!/\.atlas$/i.test(f.name)) continue;
    try {
      const pages = parseSpineAtlasText(td.decode(new Uint8Array(f.bytes)));
      for (const pg of pages) spineAtlasInfo.set(resolveImageRef(f.path!, pg.image), { path: f.path!, pages: pages.length });
    } catch {
      /* not a spine atlas */
    }
  }
  const spineInfoOf = (ref: string): { path: string; pages: number } | undefined => spineAtlasInfo.get(pathByRef.get(ref) ?? '');

  const merged = mergeSharedAtlases(assets);
  const atlasByRef = new Map<string, Atlas>();
  for (const a of merged) if (a.kind === 'atlas') atlasByRef.set(a.atlas.name, a.atlas);
  const report = await analyze(merged, undefined, {});
  return { merged, pathByRef, spineRefs, atlasByRef, spineInfoOf, report };
}

const baseOptions = (over: Partial<FixOptions> = {}): FixOptions => ({
  targetMime: 'image/webp',
  quality: 0.85,
  padding: 2,
  maxSize: 4096,
  maxEdge: 4096,
  aggressive: false,
  polygon: false,
  ...over,
});

// ── faithful node re-implementation of the worker execute path's kind-FILTER (fix.worker.ts ~283-291,
//    509-530, 664-684, 1282-1426) ────────────────────────────────────────────────────────────────────
// Reuses the SAME pure helpers the worker imports (fixOpKind / isOwnerAwareDrop / deselectedSkips). Returns
// which ops the main loop ran (by ref+kind), the tier-loop gate, the Phase-A transcoded predictions, and the
// final receipt skipped[]. NO pixel work (no canvas/createImageBitmap) — the FILTER control flow is pure.
interface FilterResult {
  /** Ops the main compose loop actually ran (excluded kinds + Phase-C-deferred owner-drops removed). */
  ranOps: { kind: OpKind; ref: string }[];
  /** Owner-aware dedup drops Phase C would execute (after the runs() filter). */
  dedupDrops: FixOp[];
  /** tier multiplier gated off? (excludeKinds includes 'tier'). */
  tierExcluded: boolean;
  /** Would the tier loop body run? (tiering on, folder not already tiered, tier not excluded). */
  tierLoopRuns: boolean;
  /** progress total = ops that run + 1 (the zip step) — fills to 100% even when kinds are excluded. */
  total: number;
  /** The receipt skipped[] entries the deselected-kind honesty pass appends. */
  deselectedSkipped: { assetRef: string; reason: string }[];
}
function runFilter(b: Built, opts: FixOptions): FilterResult {
  const tierReq = opts.scaleTiers ?? [];
  const tierValidation = tierReq.length > 0 ? validateTiers(tierReq) : null;
  const tiers = tierValidation?.ok ? tierValidation.tiers : [];
  const tieringOn = tiers.length > 0;
  const folderAlreadyTiered = tieringOn && !opts.tierForce && b.merged.some((a) => hasResolutionToken(a.kind === 'atlas' ? a.atlas.name : a.image.name));
  const tierEligible = (ref: string): boolean => {
    if (!opts.tierForce && hasResolutionToken(ref)) return false;
    const atlas = b.atlasByRef.get(ref);
    if (atlas) {
      if (atlas.sprites.some((s) => s.mesh)) return false;
      if (b.spineRefs.has(ref)) {
        const info = b.spineInfoOf(ref);
        if (info && info.pages > 1) return false;
      }
    }
    return true;
  };

  const plan = planFix(
    b.report,
    {
      targetMime: opts.targetMime,
      quality: opts.quality,
      lossless: true,
      padding: opts.padding,
      maxSize: opts.maxSize,
      maxEdge: opts.maxEdge,
      aggressive: opts.aggressive,
      isAtlasRef: (ref) => b.atlasByRef.has(ref),
      ...(tieringOn && !folderAlreadyTiered ? { scaleTiers: tiers, tierEligible } : {}),
    },
    undefined,
    undefined,
  );

  // ── the worker's selective-fix predicates (fix.worker.ts:283-291), verbatim ──
  const excluded = new Set<OpKind>(opts.excludeKinds ?? []);
  const runs = (op: FixOp): boolean => !excluded.has(fixOpKind(op));
  const tierExcluded = excluded.has('tier');
  const wouldRunByKind = new Set<OpKind>(plan.ops.map(fixOpKind));
  if (tieringOn && !folderAlreadyTiered) wouldRunByKind.add('tier');

  // Owner-aware drops deferred to Phase C, filtered by runs (fix.worker.ts:530).
  const dedupDrops = plan.ops.filter(isOwnerAwareDrop).filter(runs);

  // ── main compose loop gate (fix.worker.ts:664, 677-684) ──
  const total = plan.ops.filter(runs).length + 1; // +1 zip step
  const ranOps: { kind: OpKind; ref: string }[] = [];
  for (const op of plan.ops) {
    if (!runs(op)) continue; // selective: deselected kind ⇒ no pixel work
    if (op.kind === 'drop' && op.ownerRef != null) continue; // owner-aware ⇒ Phase C
    const ref = op.kind === 'repack' ? op.atlasRefs.join('+') : op.kind === 'pack' ? op.group.id : op.assetRef;
    ranOps.push({ kind: fixOpKind(op), ref });
  }

  // ── tier multiplier gate (fix.worker.ts:1282-1290): tierExcluded short-circuits the whole loop ──
  const tierLoopRuns = tieringOn && !tierExcluded && !folderAlreadyTiered;

  // ── deselected-kind honesty pass (fix.worker.ts:1426) — the SAME pure emitter the worker calls ──
  const deselectedSkipped = deselectedSkips(excluded, wouldRunByKind);

  return { ranOps, dedupDrops, tierExcluded, tierLoopRuns, total, deselectedSkipped };
}

describe('selective fix — execute-path kind filter (design BINDING / T4)', () => {
  const tiers = validateTiers([...DEFAULT_SCALE_TIERS]);
  if (!tiers.ok) throw new Error('default ladder must validate');
  const ladder = tiers.tiers;

  it('excludeKinds ABSENT ⇒ the op set that runs is byte-identical to an explicitly-empty mask (additive default)', async () => {
    const b = await buildWorkerState(loadRawFiles());
    const absent = runFilter(b, baseOptions({ scaleTiers: ladder }));
    const empty = runFilter(b, baseOptions({ scaleTiers: ladder, excludeKinds: [] }));
    expect(empty.ranOps).toEqual(absent.ranOps);
    expect(empty.total).toBe(absent.total);
    expect(empty.tierLoopRuns).toBe(absent.tierLoopRuns);
    expect(empty.deselectedSkipped).toEqual([]); // empty mask ⇒ no honest-skip notes
    expect(absent.deselectedSkipped).toEqual([]);
    // the unmasked run actually HAS ops + the tier loop runs (so the exclusion tests below are meaningful).
    expect(absent.ranOps.length).toBeGreaterThan(0);
    expect(absent.tierLoopRuns).toBe(true);
  });

  it('excluding repack ⇒ NO repack op runs; the others still run; repack surfaces ONE honest skip', async () => {
    const b = await buildWorkerState(loadRawFiles());
    const full = runFilter(b, baseOptions({ scaleTiers: ladder }));
    const masked = runFilter(b, baseOptions({ scaleTiers: ladder, excludeKinds: ['repack'] }));

    // tier-source's under-filled sheet/spine atlases yield repack ops in the full run.
    expect(full.ranOps.some((o) => o.kind === 'repack')).toBe(true);
    // masked: zero repack ops ran (deselected) …
    expect(masked.ranOps.some((o) => o.kind === 'repack')).toBe(false);
    // … but every NON-repack op the full run had still ran (the rest of the plan is untouched).
    const nonRepackFull = full.ranOps.filter((o) => o.kind !== 'repack');
    expect(masked.ranOps).toEqual(nonRepackFull);
    // honest skip: exactly one "repack skipped: deselected in plan" (surfaced, never silently dropped).
    expect(masked.deselectedSkipped).toEqual([{ assetRef: '(deselected)', reason: 'repack skipped: deselected in plan' }]);
    // progress total shrank by the number of excluded repack ops (so the bar still fills to 100%).
    const excludedCount = full.ranOps.filter((o) => o.kind === 'repack').length;
    expect(masked.total).toBe(full.total - excludedCount);
  });

  it('excluding tier GATES the tier multiplier loop (the gated worker loop, never a FixOp)', async () => {
    const b = await buildWorkerState(loadRawFiles());
    const full = runFilter(b, baseOptions({ scaleTiers: ladder }));
    const masked = runFilter(b, baseOptions({ scaleTiers: ladder, excludeKinds: ['tier'] }));

    expect(full.tierLoopRuns).toBe(true); // unmasked: the tier loop runs
    expect(masked.tierExcluded).toBe(true);
    expect(masked.tierLoopRuns).toBe(false); // masked: the WHOLE tier loop is gated off
    // tier is a multiplier, not a FixOp ⇒ excluding it does NOT change the structured-op run set.
    expect(masked.ranOps).toEqual(full.ranOps);
    // honest skip: "tier skipped: deselected in plan" surfaced once (tiering WOULD have run here).
    expect(masked.deselectedSkipped).toEqual([{ assetRef: '(deselected)', reason: 'tier skipped: deselected in plan' }]);
  });

  it('excluding multiple kinds (repack+tier) ⇒ only the rest run; both surface honest skips in OP_KIND_ORDER', async () => {
    const b = await buildWorkerState(loadRawFiles());
    const full = runFilter(b, baseOptions({ scaleTiers: ladder }));
    const masked = runFilter(b, baseOptions({ scaleTiers: ladder, excludeKinds: ['tier', 'repack'] }));

    expect(masked.ranOps.some((o) => o.kind === 'repack')).toBe(false);
    expect(masked.ranOps).toEqual(full.ranOps.filter((o) => o.kind !== 'repack'));
    expect(masked.tierLoopRuns).toBe(false);
    // both honest skips, ordered by OP_KIND_ORDER (repack before tier) regardless of exclude-set order.
    expect(masked.deselectedSkipped).toEqual([
      { assetRef: '(deselected)', reason: 'repack skipped: deselected in plan' },
      { assetRef: '(deselected)', reason: 'tier skipped: deselected in plan' },
    ]);
  });

  it('NEVER surfaces a phantom deselected-skip for a kind the run had no work for (e.g. dedup with no aggressive)', async () => {
    const b = await buildWorkerState(loadRawFiles());
    // aggressive off ⇒ no dedup/merge ops exist; deselecting them must surface NOTHING (only what WOULD run).
    const masked = runFilter(b, baseOptions({ scaleTiers: ladder, excludeKinds: ['dedup', 'merge', 'pack'] }));
    expect(masked.deselectedSkipped).toEqual([]);
    // and the run is unchanged from the full run (nothing of those kinds was there to exclude).
    const full = runFilter(b, baseOptions({ scaleTiers: ladder }));
    expect(masked.ranOps).toEqual(full.ranOps);
    expect(masked.tierLoopRuns).toBe(full.tierLoopRuns);
  });

  it('Phase-A cross-dep: a DESELECTED transcode op is NOT predicted as transcoding an owner (masked with runs)', () => {
    // The B-class cross-dependency (fix.worker.ts:513): the owner-final-name prediction masks the transcode
    // flag with runs(op). A DESELECTED transcode op will NOT rename its owner at execute, so it must NOT be
    // predicted as transcoded — else the owner's actual name (original) diverges from its (renamed)
    // prediction and Phase C silently degrades an otherwise-running dedup to keep-consumer. Proven PURELY
    // against the SAME fixOpKind/runs predicate the worker uses (no encoder/fixture dependency — the
    // load-bearing expression is `op.kind === 'transcode' && runs(op)`).
    const transcodeOp: FixOp = { kind: 'transcode', assetRef: 'owner.png', targetMime: 'image/webp', quality: 0.85, lossless: false };
    const predicted = (excludeKinds: OpKind[]): boolean => {
      const excluded = new Set<OpKind>(excludeKinds);
      const runs = (op: FixOp): boolean => !excluded.has(fixOpKind(op));
      return transcodeOp.kind === 'transcode' && runs(transcodeOp); // the worker's exact line 513
    };
    // transcode NOT excluded ⇒ predicted transcoded (today's behavior, byte-identical to `op.kind === 'transcode'`).
    expect(predicted([])).toBe(true);
    expect(predicted(['repack', 'tier'])).toBe(true); // unrelated exclusions don't mask it
    // transcode DESELECTED ⇒ NOT predicted transcoded (the mask that protects dedup from a diverged keep).
    expect(predicted(['transcode'])).toBe(false);
  });

  it('all-kinds-excluded ⇒ NO structured op runs + the tier loop is gated; every would-run kind surfaces a skip', async () => {
    const b = await buildWorkerState(loadRawFiles());
    const full = runFilter(b, baseOptions({ scaleTiers: ladder }));
    const allKinds: OpKind[] = ['repack', 'merge', 'resize', 'transcode', 'drop', 'pack', 'dedup', 'tier'];
    const masked = runFilter(b, baseOptions({ scaleTiers: ladder, excludeKinds: allKinds }));

    expect(masked.ranOps).toEqual([]); // nothing composes — a pass-through of the inputs
    expect(masked.tierLoopRuns).toBe(false);
    expect(masked.total).toBe(1); // only the zip step
    // every kind the full run WOULD have done is surfaced as an honest skip (never silently dropped).
    const fullKinds = new Set<OpKind>(full.ranOps.map((o) => o.kind));
    if (full.tierLoopRuns) fullKinds.add('tier');
    const skippedKinds = new Set(masked.deselectedSkipped.map((s) => s.reason.split(' ')[0]));
    for (const k of fullKinds) expect(skippedKinds.has(k)).toBe(true);
  });

  it('is deterministic: same fixture + same mask ⇒ deep-equal filter result', async () => {
    const a = runFilter(await buildWorkerState(loadRawFiles()), baseOptions({ scaleTiers: ladder, excludeKinds: ['repack', 'tier'] }));
    const c = runFilter(await buildWorkerState(loadRawFiles()), baseOptions({ scaleTiers: ladder, excludeKinds: ['repack', 'tier'] }));
    expect(a.ranOps).toEqual(c.ranOps);
    expect(a.deselectedSkipped).toEqual(c.deselectedSkipped);
    expect(a.tierLoopRuns).toBe(c.tierLoopRuns);
    expect(a.total).toBe(c.total);
  });
});
