import { describe, expect, it } from 'vitest';
import type { FixOp, PackGroup } from '@asset-doctor/core';
import { classifyOp, groupOps, OP_KIND_ORDER, REFERENCE_CHANGING, summarizeOpCounts, summarizePlan, dedupKeepConsumerSkip, fixOpKind, deselectedSkips, type DedupConsumerFacts, type OpKind, type PlanGateInputs } from './op-manifest';

// Real worker strings sampled from each operations.push site in fix.worker.ts (verbatim formats).
const SAMPLES: Record<string, OpKind | null> = {
  'repack hero.png (spine) → 1024×512': 'repack', // line 494
  'repack hero.png (polygon) → 1024×512 webp': 'repack', // line 590
  'merge 3 atlases → 1 sheet': 'merge', // line 607
  'resize atlas big.png → 2048×2048': 'resize', // line 661 (resize atlas …)
  'resize huge.png → 2048×1024 webp': 'resize', // line 682 (resize …)
  'transcode photo.png → webp': 'transcode', // line 709
  'drop duplicate copy.png': 'drop', // line 723 (drop duplicate → first token 'drop')
  'pack 12 loose → ui sheet (1 page)': 'pack', // line 916
  'dedup a.png → b.png (repoint meta.image)': 'dedup', // lines 982 & 1009
  'tier bg.png → 3 resolutions': 'tier', // line 1155
};

describe('classifyOp', () => {
  for (const [op, kind] of Object.entries(SAMPLES)) {
    it(`classifies ${JSON.stringify(op)} → ${kind}`, () => {
      expect(classifyOp(op)).toBe(kind);
    });
  }

  it('returns null for an unknown verb', () => {
    expect(classifyOp('frobnicate x.png')).toBeNull();
  });

  it('returns null for an empty / whitespace string', () => {
    expect(classifyOp('')).toBeNull();
    expect(classifyOp('   ')).toBeNull();
  });
});

describe('groupOps', () => {
  it('emits groups in OP_KIND_ORDER regardless of input order', () => {
    const ops = ['tier a → 2', 'repack b → 1×1', 'merge 2 → 1 sheet', 'resize c → 2×2'];
    const got = groupOps(ops).map((g) => g.kind);
    expect(got).toEqual(['repack', 'resize', 'merge', 'tier']);
    // sanity: matches the canonical order's relative positions
    expect(got).toEqual(OP_KIND_ORDER.filter((k) => got.includes(k)));
  });

  it('buckets unknown verbs into a single trailing null group', () => {
    const groups = groupOps(['frobnicate x', 'repack b → 1×1', 'wibble y']);
    expect(groups.map((g) => g.kind)).toEqual(['repack', null]);
    const other = groups[groups.length - 1]!;
    expect(other.kind).toBeNull();
    expect(other.refChanging).toBe(false);
    expect(other.rows.map((r) => r.text)).toEqual(['frobnicate x', 'wibble y']); // input order
  });

  it('preserves input order within a group', () => {
    const groups = groupOps(['transcode a.png → webp', 'transcode b.png → webp', 'transcode c.png → webp']);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map((r) => r.text)).toEqual(['transcode a.png → webp', 'transcode b.png → webp', 'transcode c.png → webp']);
  });

  it('flags refChanging exactly for merge/dedup/pack/tier', () => {
    const ops = [
      'repack b → 1×1',
      'resize c → 2×2',
      'transcode d.png → webp',
      'drop duplicate e.png',
      'merge 2 → 1 sheet',
      'pack 3 loose → s sheet (1 page)',
      'dedup f.png → g.png (repoint meta.image)',
      'tier h → 2 resolutions',
    ];
    const refByKind = new Map(groupOps(ops).map((g) => [g.kind, g.refChanging]));
    for (const k of OP_KIND_ORDER) {
      expect(refByKind.get(k)).toBe(REFERENCE_CHANGING.has(k));
    }
  });

  it('is pure: same input ⇒ deep-equal output', () => {
    const ops = ['repack b → 1×1', 'frobnicate x', 'merge 2 → 1 sheet'];
    expect(groupOps(ops)).toEqual(groupOps(ops));
  });

  it('returns [] for empty input', () => {
    expect(groupOps([])).toEqual([]);
  });
});

/* ── DRY-RUN plan summary (docs/improvements/dry-run-plan-preview.md) ──────────────────────────────────
 * The plan path tallies the STRUCTURED FixOp[] the execute path would run WITHOUT composing any pixels.
 * These tests are 100% pure (no canvas, no worker) — they synthesize FixOp[] + gate facts directly. */

const repack = (atlasRefs: string[]): FixOp => ({ kind: 'repack', atlasRefs, targetMime: 'image/webp', pot: true, allowRotation: false, padding: 2, maxSize: 4096 });
const resize = (assetRef: string): FixOp => ({ kind: 'resize', assetRef, to: { w: 1024, h: 512 }, targetMime: 'image/webp', quality: 0.85 });
const transcode = (assetRef: string): FixOp => ({ kind: 'transcode', assetRef, targetMime: 'image/webp', quality: 0.85, lossless: false });
const dropLegacy = (assetRef: string): FixOp => ({ kind: 'drop', assetRef, reason: 'duplicate-exact' });
const dropOwned = (assetRef: string, ownerRef: string): FixOp => ({ kind: 'drop', assetRef, reason: 'duplicate-exact', ownerRef });
const pack = (id: string): FixOp => ({ kind: 'pack', group: { id, kind: 'static', regions: [] } as unknown as PackGroup, targetMime: 'image/webp', trim: true, padding: 2, maxSize: 4096, allowRotation: false });

describe('summarizeOpCounts (structured FixOp[] tally)', () => {
  it('splits repack vs merge by atlasRefs.length', () => {
    const counts = summarizeOpCounts([repack(['a']), repack(['b', 'c']), repack(['d', 'e', 'f'])], 0);
    expect(counts).toEqual({ repack: 1, merge: 2 });
  });

  it('splits drop vs dedup by ownerRef presence', () => {
    const counts = summarizeOpCounts([dropLegacy('x'), dropOwned('y', 'owner'), dropOwned('z', 'owner')], 0);
    expect(counts).toEqual({ drop: 1, dedup: 2 });
  });

  it('counts resize / transcode / pack literally', () => {
    const counts = summarizeOpCounts([resize('a'), transcode('b'), transcode('c'), pack('g1')], 0);
    expect(counts).toEqual({ resize: 1, transcode: 2, pack: 1 });
  });

  it('folds the worker tier multiplier into counts.tier', () => {
    expect(summarizeOpCounts([], 4)).toEqual({ tier: 4 });
    // tier coexists with real ops
    expect(summarizeOpCounts([resize('a')], 3)).toEqual({ resize: 1, tier: 3 });
  });

  it('OMITS zero-count kinds (no key for an op kind that never appeared)', () => {
    const counts = summarizeOpCounts([transcode('a')], 0);
    expect(counts).toEqual({ transcode: 1 });
    expect(Object.keys(counts)).toEqual(['transcode']); // nothing else present
  });

  it('clamps a negative tier multiplier to 0 (never emits a negative or NaN count)', () => {
    expect(summarizeOpCounts([], -5)).toEqual({});
  });

  it('is deterministic + key order follows OP_KIND_ORDER (same input ⇒ deep-equal output)', () => {
    const ops = [pack('g'), dropOwned('y', 'o'), repack(['a', 'b']), transcode('t'), resize('r'), dropLegacy('d'), repack(['x'])];
    const a = summarizeOpCounts(ops, 2);
    const b = summarizeOpCounts([...ops], 2);
    expect(a).toEqual(b);
    // emitted keys are a subsequence of the canonical order (repack→resize→transcode→drop→merge→pack→dedup→tier)
    const present = Object.keys(a) as OpKind[];
    expect(present).toEqual(OP_KIND_ORDER.filter((k) => present.includes(k)));
    expect(a).toEqual({ repack: 1, resize: 1, transcode: 1, drop: 1, merge: 1, pack: 1, dedup: 1, tier: 2 });
  });

  it('returns {} for an empty plan with no tiering', () => {
    expect(summarizeOpCounts([], 0)).toEqual({});
  });
});

describe('summarizePlan (the fix-plan payload assembled in plan mode)', () => {
  const gate = (over: Partial<PlanGateInputs> = {}): PlanGateInputs => ({
    ops: [repack(['a']), repack(['b', 'c']), resize('r'), transcode('t'), dropOwned('y', 'o'), pack('g')],
    tierAssets: 2,
    skipped: [{ assetRef: '(folder)', reason: 'tier skipped: folder already ships resolution tiers' }],
    referencesChanged: true,
    ...over,
  });

  it('totalOps is the SUM of every per-kind count (tier included as its upper bound)', () => {
    const s = summarizePlan(gate());
    // repack 1, merge 1, resize 1, transcode 1, dedup 1, pack 1, tier 2 = 8
    expect(s.opCounts).toEqual({ repack: 1, resize: 1, transcode: 1, merge: 1, pack: 1, dedup: 1, tier: 2 });
    expect(s.totalOps).toBe(8);
    expect(s.totalOps).toBe((Object.values(s.opCounts) as number[]).reduce((n, v) => n + v, 0));
  });

  it('passes the pixel-free skips + references-changed prediction through verbatim', () => {
    const skips = [{ assetRef: 'm.png', reason: 'tier skipped: meshed atlas not supported (scaleAtlas drops mesh)' }];
    const s = summarizePlan(gate({ skipped: skips, referencesChanged: false }));
    expect(s.skipped).toEqual(skips);
    expect(s.referencesChanged).toBe(false);
  });

  it('ALWAYS sets hasDeferredChecks (pixel-dependent skips, the refs caveat + the tier upper bound resolve only at execute)', () => {
    expect(summarizePlan(gate()).hasDeferredChecks).toBe(true);
    expect(summarizePlan(gate({ ops: [], tierAssets: 0, skipped: [], referencesChanged: false })).hasDeferredChecks).toBe(true);
  });

  it('HONESTY GUARD (invariant 5): the summary carries op COUNTS only — NO byte/VRAM savings field', () => {
    const s = summarizePlan(gate());
    // the structural contract: exactly these five keys, none of them a disk/VRAM number.
    expect(Object.keys(s).sort()).toEqual(['hasDeferredChecks', 'opCounts', 'referencesChanged', 'skipped', 'totalOps']);
    // defensively scan every key (incl. any future addition) for a bytes/vram/saving leak.
    const FORBIDDEN = /(byte|vram|saved|saving|kb|mb|disk)/i;
    for (const k of Object.keys(s)) expect(FORBIDDEN.test(k), `summary key "${k}" must not promise bytes/VRAM pre-execute`).toBe(false);
    // opCounts is a tally of integers, never a savings map.
    for (const v of Object.values(s.opCounts)) expect(Number.isInteger(v) && v > 0).toBe(true);
  });

  it('is pure: same gate input ⇒ deep-equal summary', () => {
    expect(summarizePlan(gate())).toEqual(summarizePlan(gate()));
  });

  it('empty plan ⇒ empty opCounts, totalOps 0, still carries any pixel-free skips', () => {
    const skips = [{ assetRef: 'p.png | q.png', reason: "pack skipped: two files map to one region name 'r' — kept the first" }];
    const s = summarizePlan({ ops: [], tierAssets: 0, skipped: skips, referencesChanged: false });
    expect(s.opCounts).toEqual({});
    expect(s.totalOps).toBe(0);
    expect(s.skipped).toEqual(skips);
  });
});

/* ── dedupKeepConsumerSkip (the plan block's pixel-free keep-consumer predicate, fix.worker.ts Phase C) ──
 * Reviewer M2: the plan must NOT count a dedup the execute path will SKIP for a pixel-free reason. This is
 * the single source of truth the worker plan block + plan-worker.test.ts both call. */
describe('dedupKeepConsumerSkip (pixel-free keep-consumer predicate ↔ execute Phase C)', () => {
  // A "drop-in" atlas consumer that WILL actually dedup: repointable manifest + resolvable atlas.
  const dropInAtlas: DedupConsumerFacts = { keepConsumer: false, repointManifest: true, isSpine: false, hasManifest: true, isAtlas: true };
  // A "drop-in" loose consumer (no repointManifest) that WILL actually dedup: has an AD-emitted manifest.
  const dropInLoose: DedupConsumerFacts = { keepConsumer: false, repointManifest: false, isSpine: false, hasManifest: true, isAtlas: true };

  it('returns null for a consumer the execute path WILL dedup (atlas repoint + loose)', () => {
    expect(dedupKeepConsumerSkip('owner.png', dropInAtlas)).toBeNull();
    expect(dedupKeepConsumerSkip('owner.png', dropInLoose)).toBeNull();
  });

  it('keepConsumer (tiering renames the owner) ⇒ kept, names the owner (Phase C 1132)', () => {
    const r = dedupKeepConsumerSkip('owner.png', { ...dropInAtlas, keepConsumer: true });
    expect(r).toBe('dedup skipped: owner owner.png renamed by scale tiering — kept duplicate');
  });

  it('Spine consumer ⇒ kept (Phase C 1148), checked before the repointManifest branch', () => {
    // even with repointManifest set (a Spine ref IS an atlas), Spine wins → cross-page keep.
    expect(dedupKeepConsumerSkip('o', { ...dropInAtlas, isSpine: true })).toBe('dedup skipped: Spine cross-page dedup not drop-in — kept duplicate');
  });

  it('atlas-repoint consumer with no manifest / no atlas ⇒ kept (Phase C 1160)', () => {
    expect(dedupKeepConsumerSkip('o', { ...dropInAtlas, hasManifest: false })).toBe('dedup skipped: atlas consumer manifest unavailable — kept duplicate');
    expect(dedupKeepConsumerSkip('o', { ...dropInAtlas, isAtlas: false })).toBe('dedup skipped: atlas consumer manifest unavailable — kept duplicate');
  });

  it('loose consumer whose reference may live in game code (no manifest) ⇒ kept (Phase C 1183)', () => {
    expect(dedupKeepConsumerSkip('o', { ...dropInLoose, hasManifest: false })).toBe('dedup skipped: loose duplicate reference may live in game code — kept duplicate');
  });

  it('loose consumer with a manifest but unresolvable atlas ⇒ kept (Phase C 1189)', () => {
    expect(dedupKeepConsumerSkip('o', { ...dropInLoose, isAtlas: false })).toBe('dedup skipped: referencing manifest unavailable — kept duplicate');
  });

  it('the count EXCLUDES kept-consumer drops (plan block hands summarizeOpCounts only real dedups)', () => {
    // Three owner-aware drops; one is a real dedup, two are pixel-free keeps. The plan block filters the
    // keeps out BEFORE counting, so the dedup count is 1 — matching what execute would actually do.
    const ownerAware = (assetRef: string): FixOp => dropOwned(assetRef, 'owner');
    const all = [ownerAware('real'), ownerAware('spineKeep'), ownerAware('looseKeep')];
    const facts: Record<string, DedupConsumerFacts> = {
      real: dropInLoose,
      spineKeep: { ...dropInLoose, isSpine: true },
      looseKeep: { ...dropInLoose, hasManifest: false },
    };
    const counted = all.filter((op) => op.kind === 'drop' && dedupKeepConsumerSkip('owner', facts[op.assetRef]!) === null);
    expect(summarizeOpCounts(counted, 0)).toEqual({ dedup: 1 });
    // WITHOUT the exclusion the naive tally would over-count to 3 (the bug this fixes).
    expect(summarizeOpCounts(all, 0)).toEqual({ dedup: 3 });
  });
});

/* ── SELECTIVE FIX (docs/improvements/selective-fix.md) ─────────────────────────────────────────────────
 * fixOpKind + deselectedSkips are the PURE half of the kind-filter the worker's execute path runs: the
 * single source of truth that classifies a structured FixOp into the OpKind the plan tally, the receipt
 * change-manifest, AND the selective `runs(op)` predicate all key on (so the filter can't drift from the
 * count), plus the deterministic honest skip-note emitter. 100% canvas-free (no worker, no DOM). */

const dropOwnedTier = (assetRef: string, ownerRef: string): FixOp => ({ kind: 'drop', assetRef, reason: 'duplicate-exact', ownerRef, keepConsumer: true });

describe('fixOpKind (the single-source-of-truth FixOp → OpKind classifier the worker `runs` filter shares)', () => {
  it('splits repack vs merge by atlasRefs.length (1 ⇒ repack, >1 ⇒ merge)', () => {
    expect(fixOpKind(repack(['a']))).toBe('repack');
    expect(fixOpKind(repack(['b', 'c']))).toBe('merge');
    expect(fixOpKind(repack(['d', 'e', 'f']))).toBe('merge');
  });

  it('splits drop vs dedup by ownerRef presence (legacy bare-drop ⇒ drop, owner-aware ⇒ dedup)', () => {
    expect(fixOpKind(dropLegacy('x'))).toBe('drop');
    expect(fixOpKind(dropOwned('y', 'owner'))).toBe('dedup');
    expect(fixOpKind(dropOwnedTier('z', 'owner'))).toBe('dedup'); // keepConsumer still owner-aware
  });

  it('classifies resize / transcode / pack literally (never tier — tier is a worker multiplier, not a FixOp)', () => {
    expect(fixOpKind(resize('a'))).toBe('resize');
    expect(fixOpKind(transcode('b'))).toBe('transcode');
    expect(fixOpKind(pack('g'))).toBe('pack');
  });

  it('agrees with summarizeOpCounts on EVERY FixOp variant (so `runs` can never disagree with the tally)', () => {
    const ops = [repack(['a']), repack(['b', 'c']), resize('r'), transcode('t'), dropLegacy('d'), dropOwned('y', 'o'), pack('g')];
    // recount independently via fixOpKind, then assert it equals summarizeOpCounts (the same classifier).
    const byKind: Partial<Record<OpKind, number>> = {};
    for (const op of ops) byKind[fixOpKind(op)] = (byKind[fixOpKind(op)] ?? 0) + 1;
    expect(byKind).toEqual(summarizeOpCounts(ops, 0));
  });

  it('is total + pure: every kind maps to a defined OpKind, same input ⇒ same output', () => {
    const ops = [repack(['a']), repack(['a', 'b']), resize('r'), transcode('t'), dropLegacy('d'), dropOwned('y', 'o'), pack('g')];
    for (const op of ops) {
      expect(OP_KIND_ORDER.includes(fixOpKind(op))).toBe(true);
      expect(fixOpKind(op)).toBe(fixOpKind(op));
    }
  });
});

describe('deselectedSkips (honest "<kind> skipped: deselected in plan" notes the worker surfaces)', () => {
  it('empty excludeKinds ⇒ NO skips (the additive default — byte-identical to today)', () => {
    const wouldRun = new Set<OpKind>(['repack', 'transcode', 'tier']);
    expect(deselectedSkips(new Set<OpKind>(), wouldRun)).toEqual([]);
  });

  it('surfaces one honest note per deselected-AND-would-run kind', () => {
    const wouldRun = new Set<OpKind>(['repack', 'transcode', 'dedup', 'tier']);
    const excluded = new Set<OpKind>(['transcode', 'dedup']);
    expect(deselectedSkips(excluded, wouldRun)).toEqual([
      { assetRef: '(deselected)', reason: 'transcode skipped: deselected in plan' },
      { assetRef: '(deselected)', reason: 'dedup skipped: deselected in plan' },
    ]);
  });

  it('NEVER surfaces a phantom skip for a deselected kind the run had no work for', () => {
    // 'merge'/'pack' are excluded but absent from wouldRun ⇒ no note (we only surface what WOULD have run).
    const wouldRun = new Set<OpKind>(['repack', 'transcode']);
    const excluded = new Set<OpKind>(['merge', 'pack', 'transcode']);
    expect(deselectedSkips(excluded, wouldRun)).toEqual([{ assetRef: '(deselected)', reason: 'transcode skipped: deselected in plan' }]);
  });

  it('emits notes in OP_KIND_ORDER regardless of Set insertion order (deterministic)', () => {
    const wouldRun = new Set<OpKind>(OP_KIND_ORDER);
    // insert excluded kinds OUT of canonical order — output must still follow OP_KIND_ORDER.
    const excluded = new Set<OpKind>(['tier', 'repack', 'dedup', 'resize']);
    const reasons = deselectedSkips(excluded, wouldRun).map((s) => s.reason);
    expect(reasons).toEqual([
      'repack skipped: deselected in plan',
      'resize skipped: deselected in plan',
      'dedup skipped: deselected in plan',
      'tier skipped: deselected in plan',
    ]);
    // every assetRef is the neutral sentinel (no real asset is named — the WHOLE kind was deselected).
    expect(deselectedSkips(excluded, wouldRun).every((s) => s.assetRef === '(deselected)')).toBe(true);
  });

  it('is pure: same input ⇒ deep-equal output', () => {
    const wouldRun = new Set<OpKind>(['repack', 'tier']);
    const excluded = new Set<OpKind>(['repack', 'tier']);
    expect(deselectedSkips(excluded, wouldRun)).toEqual(deselectedSkips(excluded, wouldRun));
  });
});
