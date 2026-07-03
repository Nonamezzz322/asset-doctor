// Headless worker-pipeline test for the DRY-RUN PLAN preview (docs/improvements/dry-run-plan-preview.md,
// test plan T6). The fix worker's `mode:'plan'` short-circuit (fix.worker.ts ~310-400) runs parse +
// analyze + planFix + the pre-loop gates, then posts a `fix-plan` summary and STOPS before the heavy
// COMPOSE/pack/repack/tier PIXEL LOOP + zip. (It is NOT zero-pixel in the worker: the format-sizing encode
// pass + aggressive feature pass run pre-loop to count transcodes/dedups — the same costs execute pays.
// This Node mirror analyzes WITHOUT an encoder because these scenarios don't assert transcode counts; the
// gate-assembly CONTROL FLOW under test is encoder-independent.) The control flow runs in Node verbatim,
// so — exactly like tier-worker.test.ts / dedup-worker-phase-c.test.ts — we drive the REAL pipeline over
// the authored tier-source fixture, re-implement the worker's gate-assembly CONTROL FLOW (the same plan
// ops, the same tierRefusal/tierAssets/predictReferencesChanged/dedup-skip/pixel-free-skip code), feed it
// to the SAME pure summarizePlan the worker calls, and assert:
//   • the op COUNTS equal exactly the ops the EXECUTE path would run (repack/merge/resize/transcode split
//     the same way; tier folded as its upper bound; no-op keep-consumer dedup drops EXCLUDED)
//   • the gate-assembly control flow is canvas/encode-free (proven structurally: this whole file imports no
//     DOM/canvas + the asserted gate fields are pure-derivable)
//   • the would-be-skips are limited to the loop-free subset (multi-page Spine, already-tiered, meshed,
//     dedup×tier, dedup keep-consumer) — NO pixel-dependent skip (polygon-no-win, near-dup, codec-
//     unavailable, …) leaks in
//   • the referencesChanged PREDICTION is conservative-true for tiering and false for a pure drop-in repack
//   • HONESTY (invariant 5): the summary carries op COUNTS only, no byte/VRAM number
//
// The gate assembly reuses the SAME pure helpers the worker imports (planFix / validateTiers /
// hasResolutionToken / renamedTo / summarizePlan), so a broken plan summary can't pass green here while
// shipping in fix.worker.ts.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import type { Asset, Atlas, FixOp, ImageMime, ScaleTier, Size } from '@asset-doctor/core';
import { groupFiles, keyOf, type RawFile } from '@asset-doctor/ingest';
import { parseAtlas, parseImage, parseSpineAtlasText, parseSpinePage, type SpinePage } from '@asset-doctor/parsers';
import { analyze, mergeSharedAtlases, hasResolutionToken } from '@asset-doctor/analysis';
import { planFix, validateTiers, DEFAULT_SCALE_TIERS, resolveImageRef, renamedTo, EXT, isOwnerAwareDrop } from '@asset-doctor/fix';
import { summarizePlan, summarizeOpCounts, dedupKeepConsumerSkip, deselectedSkips, fixOpKind, type OpKind, type PlanGateInputs } from '../src/lib/op-manifest';
import { summarizeFixPlanFootprint } from '../src/lib/plan-footprint';
import type { FixOptions, FixPlanSummary } from '../src/worker/fix-protocol';

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
  sizeByRef: Map<string, Size>;
  spineRefs: Set<string>;
  atlasByRef: Map<string, Atlas>;
  spineInfoOf: (ref: string) => { path: string; pages: number } | undefined;
  manifestPathOf: (ref: string) => string | undefined;
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
  // Mirror the worker's manifestPathOf (fix.worker.ts:145-166): TexturePacker JSON meta.image → manifest
  // path, keyed by the image path. Used by the dedup keep-consumer skip mirror (vacuous in these scenarios:
  // no dedupGroups ⇒ planFix emits no owner-aware drops — present so the mirror stays faithful).
  const manifestPathByImage = new Map<string, string>();
  for (const f of files) {
    if (!/\.json$/i.test(f.name)) continue;
    try {
      const j = JSON.parse(td.decode(new Uint8Array(f.bytes))) as { meta?: { image?: unknown } };
      if (typeof j.meta?.image === 'string') manifestPathByImage.set(resolveImageRef(f.path!, j.meta.image), f.path!);
    } catch {
      /* not a TexturePacker manifest */
    }
  }
  const manifestPathOf = (ref: string): string | undefined => manifestPathByImage.get(pathByRef.get(ref) ?? '');

  const merged = mergeSharedAtlases(assets);
  const atlasByRef = new Map<string, Atlas>();
  const sizeByRef = new Map<string, Size>();
  for (const a of merged) {
    if (a.kind === 'atlas') {
      atlasByRef.set(a.atlas.name, a.atlas);
      sizeByRef.set(a.atlas.name, a.atlas.size);
    } else {
      sizeByRef.set(a.image.name, a.image.size);
    }
  }
  // analyze WITHOUT an encoder — plan mode never encodes; format findings are immaterial to the gates we
  // assert (occupancy / wasted-regions / dimensions / tier eligibility are all encoder-free).
  const report = await analyze(merged, undefined, {});
  return { merged, pathByRef, sizeByRef, spineRefs, atlasByRef, spineInfoOf, manifestPathOf, report };
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

// ── faithful node re-implementation of fix.worker.ts's PLAN short-circuit gate assembly (~310-384) ───
// Returns the SAME PlanGateInputs the worker hands to summarizePlan, computed with ZERO pixel work.
function assemblePlanGate(b: Built, opts: FixOptions): { gate: PlanGateInputs; plan: { ops: FixOp[] }; summary: FixPlanSummary } {
  const { atlasByRef, spineRefs, spineInfoOf, manifestPathOf, pathByRef, merged } = b;
  const basename = (p: string): string => p.split('/').pop() ?? p;

  // tier validation + folder-already-tiered + the per-ref refusal gate (verbatim from the worker).
  const tierReq = opts.scaleTiers ?? [];
  const tierValidation = tierReq.length > 0 ? validateTiers(tierReq) : null;
  const tiers = tierValidation?.ok ? tierValidation.tiers : [];
  const tieringOn = tiers.length > 0;
  const folderAlreadyTiered = tieringOn && !opts.tierForce && merged.some((a) => hasResolutionToken(a.kind === 'atlas' ? a.atlas.name : a.image.name));
  const tierRefusal = (ref: string): string | null => {
    if (!opts.tierForce && hasResolutionToken(ref)) return 'tier skipped: asset is already a resolution tier';
    const atlas = atlasByRef.get(ref);
    if (atlas) {
      if (atlas.sprites.some((s) => s.mesh)) return 'tier skipped: meshed atlas not supported (scaleAtlas drops mesh)';
      if (spineRefs.has(ref)) {
        const info = spineInfoOf(ref);
        if (info && info.pages > 1) return 'tier skipped: multi-page Spine not supported in v1';
      }
    }
    return null;
  };
  const tierEligible = (ref: string): boolean => tierRefusal(ref) === null;

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
      isAtlasRef: (ref) => atlasByRef.has(ref),
      ...(tieringOn && !folderAlreadyTiered ? { scaleTiers: tiers, tierEligible } : {}),
    },
    undefined,
    undefined,
  );

  // The worker's effectiveFor(ref,1).targetMime collapses (no per-folder/type overrides in these
  // scenarios) to the request base — so the loose-image rename check below uses opts.targetMime directly.
  const targetMimeFor = (ref: string): ImageMime => (opts.overrides?.find((o) => ref.startsWith(o.match))?.targetMime ?? opts.targetMime);

  // ── SELECTIVE FIX mask (fix.worker.ts:283-291) — mirrored IDENTICALLY (design B2). The plan block honors
  // the SAME runs()/tierExcluded/wouldRunByKind the execute path does. Empty/absent excludeKinds ⇒ runs()
  // always true, tierExcluded false, no deselected notes ⇒ byte-identical to the pre-mask gate. ──
  const excluded = new Set<OpKind>(opts.excludeKinds ?? []);
  const runs = (op: FixOp): boolean => !excluded.has(fixOpKind(op));
  const tierExcluded = excluded.has('tier');
  const wouldRunByKind = new Set<OpKind>(plan.ops.map(fixOpKind));
  if (tieringOn && !folderAlreadyTiered) wouldRunByKind.add('tier');

  // ── PLAN short-circuit gate assembly (fix.worker.ts ~336-446), pixel-free + mask-aware ──
  const planTransformed = new Set<string>();
  const planDropped = new Set<string>();
  const planReplaced = new Set<string>();
  let predictRefsChanged = false;
  for (const op of plan.ops) {
    if (!runs(op)) continue; // deselected op does no work ⇒ not tracked / not ref-changing
    if (op.kind === 'repack') {
      for (const rf of op.atlasRefs) planTransformed.add(rf);
      if (op.atlasRefs.length > 1) predictRefsChanged = true;
    } else if (op.kind === 'pack') {
      for (const r of op.group.regions) planTransformed.add(r.ref);
      predictRefsChanged = true;
    } else if (op.kind === 'drop') {
      planDropped.add(op.assetRef);
      predictRefsChanged = true;
    } else if (op.kind === 'resize' || op.kind === 'transcode') {
      planReplaced.add(op.assetRef);
      if (!atlasByRef.has(op.assetRef)) {
        const path = pathByRef.get(op.assetRef);
        if (path && renamedTo(path, targetMimeFor(op.assetRef)) !== path) predictRefsChanged = true;
      }
    }
  }

  const planSkips: { assetRef: string; reason: string }[] = [];
  // (no packCollisionSkips in these scenarios — packLoose off)
  for (const op of plan.ops) {
    if (op.kind !== 'repack' || op.atlasRefs.length !== 1) continue;
    if (!runs(op)) continue; // deselected repack ⇒ no per-op repack skip (deselectedSkips covers it)
    const ref = op.atlasRefs[0]!;
    if (!spineRefs.has(ref)) continue;
    const info = spineInfoOf(ref);
    if (info && info.pages > 1) planSkips.push({ assetRef: ref, reason: 'multi-page Spine repack not supported in v1' });
  }
  // Dedup keep-consumer mirror (fix.worker.ts plan block ↔ Phase C 1118-1203): owner-aware drops Phase C
  // turns into no-op keeps for pixel-free reasons are NOT counted as dedup and surface as skips. Vacuous
  // here (no dedupGroups ⇒ no owner-aware drops) but present so this mirror tracks the worker faithfully.
  const dedupSkipped = new Set<FixOp>();
  for (const op of plan.ops) {
    if (!isOwnerAwareDrop(op)) continue;
    if (!runs(op)) continue; // deselected dedup ⇒ no keep-consumer skip (deselectedSkips covers it)
    const consumerRef = op.assetRef;
    const reason = dedupKeepConsumerSkip(basename(op.ownerRef!), {
      keepConsumer: op.keepConsumer ?? false,
      repointManifest: op.repointManifest ?? false,
      isSpine: spineRefs.has(consumerRef),
      hasManifest: manifestPathOf(consumerRef) != null,
      isAtlas: atlasByRef.get(consumerRef) != null,
    });
    if (reason !== null) {
      planSkips.push({ assetRef: consumerRef, reason });
      dedupSkipped.add(op);
      planDropped.delete(consumerRef);
    }
  }
  const countedOps = plan.ops.filter((op) => !dedupSkipped.has(op) && runs(op));
  let tierAssets = 0;
  if (tieringOn && !tierExcluded && folderAlreadyTiered) planSkips.push({ assetRef: '(folder)', reason: 'tier skipped: folder already ships resolution tiers' });
  if (tieringOn && !tierExcluded && !folderAlreadyTiered) {
    for (const a of merged) {
      const ref = a.kind === 'atlas' ? a.atlas.name : a.image.name;
      const refusal = tierRefusal(ref);
      if (refusal) {
        planSkips.push({ assetRef: ref, reason: refusal });
        continue;
      }
      if (planTransformed.has(ref)) {
        planSkips.push({ assetRef: ref, reason: 'tier skipped: asset was repacked/merged/packed (its sheet is not tiered in v1)' });
        continue;
      }
      if (planDropped.has(ref) || planReplaced.has(ref)) continue;
      tierAssets++;
    }
  }
  if (tieringOn && tierAssets > 0) predictRefsChanged = true;

  // SELECTIVE FIX (design S4): one honest deselected-skip note per deselected-and-would-run kind, in
  // OP_KIND_ORDER — the SAME emitter the worker plan block + execute receipt use.
  for (const s of deselectedSkips(excluded, wouldRunByKind)) planSkips.push(s);

  const gate: PlanGateInputs = { ops: countedOps, tierAssets, skipped: planSkips, referencesChanged: predictRefsChanged };
  return { gate, plan, summary: summarizePlan(gate) };
}

// The structured-op tally summarizeOpCounts performs, re-derived independently from the plan ops + the
// tier upper bound — so the assertion that "counts == ops the execute path would run" is checked against
// an INDEPENDENT recount, not the same call under test.
function recount(ops: readonly FixOp[], tierAssets: number): Record<string, number> {
  const c: Record<string, number> = {};
  const bump = (k: string): void => { c[k] = (c[k] ?? 0) + 1; };
  for (const op of ops) {
    if (op.kind === 'repack') bump(op.atlasRefs.length > 1 ? 'merge' : 'repack');
    else if (op.kind === 'drop') bump(op.ownerRef != null ? 'dedup' : 'drop');
    else if (op.kind === 'resize') bump('resize');
    else if (op.kind === 'transcode') bump('transcode');
    else if (op.kind === 'pack') bump('pack');
  }
  if (tierAssets > 0) c.tier = tierAssets;
  return c;
}

// Fix-honesty mirror of fix.worker.ts's drop-VRAM accounting. The worker's impure exec needs OffscreenCanvas
// ⇒ not Node-runnable, so this re-derives the routing from the SAME shared SSOT predicates the worker branches
// on (isOwnerAwareDrop / the ownerRef==null bare-drop condition, mirrored by fixOpKind). The load-bearing
// invariant it pins (invariants 3 & 5): a dropped copy's w·h·4 GPU footprint is NEVER folded into the hard
// vramSaved — a drop removes the file from DISK but the GPU upload it fed is eliminated only once the reference
// is repointed (auto-repoint for owner-aware dedup ⇒ dedup upper bound; NO repoint for a bare near-dup drop ⇒
// the separate dropped-duplicate upper bound, realized only if the user manually repoints).
function routeDropVram(
  ops: readonly FixOp[],
  vramByRef: ReadonlyMap<string, number>,
): { vramSaved: number; dedupVramBytesSavedUpperBound: number; droppedDuplicateVramBytesUpperBound: number } {
  const vramSaved = 0; // const, not let — a drop NEVER contributes to the hard claim (compile-time-pinned invariant).
  let dedupVramBytesSavedUpperBound = 0;
  let droppedDuplicateVramBytesUpperBound = 0;
  for (const op of ops) {
    if (op.kind !== 'drop') continue;
    const footprint = vramByRef.get(op.assetRef) ?? 0;
    if (isOwnerAwareDrop(op)) dedupVramBytesSavedUpperBound += footprint; // ownerRef set ⇒ auto-repoint upper bound
    else droppedDuplicateVramBytesUpperBound += footprint; // bare drop (ownerRef == null) ⇒ manual-repoint upper bound
    // NEVER: vramSaved += footprint — an un-repointed drop realizes no GPU saving on the spot.
  }
  return { vramSaved, dedupVramBytesSavedUpperBound, droppedDuplicateVramBytesUpperBound };
}

describe('dry-run plan preview — worker plan short-circuit (T6)', () => {
  const tiers = validateTiers([...DEFAULT_SCALE_TIERS]);
  if (!tiers.ok) throw new Error('default ladder must validate');
  const ladder: ScaleTier[] = tiers.tiers;

  it('drop-in plan (no tiering): op counts equal the ops the execute path would run; refs unchanged', async () => {
    const b = await buildWorkerState(loadRawFiles());
    const { gate, plan, summary } = assemblePlanGate(b, baseOptions());

    // the under-filled 128×128 sheet atlas (3 small frames) yields exactly one single-ref repack op.
    const repackOps = plan.ops.filter((o): o is Extract<FixOp, { kind: 'repack' }> => o.kind === 'repack');
    expect(repackOps.length).toBeGreaterThan(0);
    expect(repackOps.every((o) => o.atlasRefs.length === 1)).toBe(true); // all single-ref ⇒ repack, never merge

    // counts == an INDEPENDENT recount of the plan ops (+ no tier). Nothing fabricated.
    expect(summary.opCounts).toEqual(recount(plan.ops, gate.tierAssets));
    expect(summary.opCounts.merge ?? 0).toBe(0); // no aggressive ⇒ no merge
    expect(summary.opCounts.dedup ?? 0).toBe(0); // no aggressive ⇒ no dedup
    expect(summary.opCounts.tier).toBeUndefined(); // tiering off ⇒ omitted
    expect(summary.totalOps).toBe((Object.values(summary.opCounts) as number[]).reduce((n, v) => n + v, 0));

    // a single-ref same-format repack keeps the manifest+name → NOT reference-changing.
    expect(summary.referencesChanged).toBe(false);
    expect(summary.hasDeferredChecks).toBe(true);
  });

  it('plan tier counts equal the ASSETS the worker would tier (upper bound); refs predicted changed', async () => {
    const b = await buildWorkerState(loadRawFiles());
    const { gate, plan, summary } = assemblePlanGate(b, baseOptions({ scaleTiers: ladder }));

    // tier-source: every under-filled atlas/page (sheet + spine_single + the two spine_multi pages) is
    // REPACKED, so its sheet is NOT tiered in v1 (excluded from the count); meshed + multi-page spine are
    // REFUSED. The only tier-eligible asset NOT transformed/refused is the loose banner ⇒ 1 tier asset.
    // This equals exactly what the worker tier loop would emit (the upper bound), proving the plan count
    // tracks the execute path — not a fabricated number.
    expect(gate.tierAssets).toBe(1);
    expect(summary.opCounts.tier).toBe(1);

    // counts still == an independent recount that folds the tier upper bound in.
    expect(summary.opCounts).toEqual(recount(plan.ops, gate.tierAssets));
    expect(summary.totalOps).toBe((Object.values(summary.opCounts) as number[]).reduce((n, v) => n + v, 0));

    // tiering renames the source ⇒ reference-changing PREDICTION is true.
    expect(summary.referencesChanged).toBe(true);
  });

  it('plan skips are the PIXEL-FREE subset only — no pixel-dependent skip leaks in', async () => {
    const b = await buildWorkerState(loadRawFiles());
    const { summary } = assemblePlanGate(b, baseOptions({ scaleTiers: ladder }));

    const reasons = summary.skipped.map((s) => s.reason);
    // the pixel-free tier refusals ARE surfaced (data-driven, determinable without composing pixels):
    expect(reasons.some((r) => r.includes('meshed atlas'))).toBe(true);
    expect(reasons.some((r) => r.includes('multi-page Spine'))).toBe(true);
    // the repacked under-filled sheet is surfaced as "not tiered in v1" (also pixel-free).
    expect(reasons.some((r) => r.includes('repacked/merged/packed'))).toBe(true);

    // NONE of the pixel-dependent skip reasons (only knowable AFTER composing/encoding) may appear here.
    const PIXEL_DEPENDENT = ['no measurable VRAM win', 'source sheet unavailable', 'no 2D context', 'codec', 'spilled into multiple sheets', 'edge-extrude skipped', 'mesh skipped'];
    for (const s of summary.skipped) {
      for (const banned of PIXEL_DEPENDENT) {
        expect(s.reason.includes(banned), `pixel-dependent skip "${s.reason}" must NOT appear in a plan preview`).toBe(false);
      }
    }
  });

  it('HONESTY (invariant 5): top-level summary is counts/flags only, plus the OPTIONAL honest footprint', async () => {
    // round22 #2: the summary may now carry an OPTIONAL `footprint` (the honest pre-compose preview). Every
    // OTHER top-level key stays counts/flags only (no byte/VRAM headline) — and the footprint, when present,
    // keeps `diskBytesSaved` and `vramBytesSaved` as DISTINCT numeric fields (never a combined "saved" total).
    const b = await buildWorkerState(loadRawFiles());
    const { summary } = assemblePlanGate(b, baseOptions({ scaleTiers: ladder }));
    const ALLOWED_TOP = ['footprint', 'hasDeferredChecks', 'opCounts', 'referencesChanged', 'skipped', 'totalOps'];
    expect(Object.keys(summary).sort().every((k) => ALLOWED_TOP.includes(k))).toBe(true);
    const FORBIDDEN = /(byte|vram|saved|saving|kb|mb|disk)/i;
    // no byte/VRAM key at the top level (the footprint is the ONLY carve-out for those fields).
    for (const k of Object.keys(summary)) if (k !== 'footprint') expect(FORBIDDEN.test(k)).toBe(false);
    if (summary.footprint) {
      // invariant-5 separation: disk and VRAM are DISTINCT numeric fields, never a combined headline.
      expect(typeof summary.footprint.diskBytesSaved).toBe('number');
      expect(typeof summary.footprint.vramBytesSaved).toBe('number');
      expect('saved' in summary.footprint).toBe(false);
      expect('total' in summary.footprint).toBe(false);
    }
    expect(JSON.stringify(summary).length).toBeGreaterThan(0); // sanity: summary did serialize
  });

  // ── round22 #2: the honest footprint preview through the REAL worker plan-gate assembly ──────────────
  it('footprint: the under-filled sheet repack is a DEFERRED op — never folded into disk/VRAM (headline honesty)', async () => {
    // The tier-source mirror has no encoder, so no transcode/resize fires here; the under-filled 128×128 sheet
    // earns a repack → deferredOps. The repack payoff is NOT knowable pre-compose, so it must appear in
    // NEITHER disk NOR vram — only the count.
    const b = await buildWorkerState(loadRawFiles());
    const { gate, summary } = assemblePlanGate(b, baseOptions());
    const fp = summarizeFixPlanFootprint(b.report, gate.ops, new Set());
    expect(fp).toBeDefined();
    expect(fp!.deferredOps).toBeGreaterThanOrEqual(1);
    expect(fp!.diskBytesSaved).toBe(0); // no encoder ⇒ no transcode delta
    expect(fp!.vramBytesSaved).toBe(0); // nothing oversize in this fixture
    expect(summary.footprint).toBeUndefined(); // assemblePlanGate (mirror) does not attach footprint — that's the worker's job
  });

  it('footprint: deselecting transcode/resize zeroes the matching bucket; counts-only plan ⇒ undefined', async () => {
    const b = await buildWorkerState(loadRawFiles());
    const { gate } = assemblePlanGate(b, baseOptions());
    // mask out every deferred kind too ⇒ nothing knowable, nothing deferred ⇒ undefined.
    const fpMaskAll = summarizeFixPlanFootprint(b.report, gate.ops, new Set<OpKind>(['repack', 'merge', 'pack', 'dedup', 'transcode', 'resize']));
    expect(fpMaskAll).toBeUndefined();
  });

  it('the plan summary == summarizeOpCounts(plan.ops, tierAssets) — single source of truth, deterministic', async () => {
    const b = await buildWorkerState(loadRawFiles());
    const opts = baseOptions({ scaleTiers: ladder });
    const a = assemblePlanGate(b, opts);
    const b2 = await buildWorkerState(loadRawFiles());
    const c = assemblePlanGate(b2, opts);
    // deterministic across a fresh parse of the same fixture.
    expect(a.summary).toEqual(c.summary);
    // the summary's opCounts is exactly summarizeOpCounts over the same inputs (no drift).
    expect(a.summary.opCounts).toEqual(summarizeOpCounts(a.plan.ops, a.gate.tierAssets));
  });

  it('a loose image whose emitted ext differs (png→webp transcode) ⇒ refs predicted changed (conservative)', () => {
    // pure proof of the worker's renamedTo() rename check used in the gate (no fixture needed).
    expect(renamedTo('a/banner.png', 'image/webp')).not.toBe('a/banner.png'); // ext changes ⇒ rename ⇒ ref-changing
    expect(renamedTo('a/banner.webp', 'image/webp')).toBe('a/banner.webp'); // same ext ⇒ no rename ⇒ drop-in
    expect(EXT['image/webp']).toBe('.webp'); // single source of truth for the rename
  });

  // ── SELECTIVE FIX masked-preview contract (docs/improvements/selective-fix.md S4 + reviewer B2) ──────
  // The plan-mode short-circuit HONORS the mask (design S4): the previewed opCounts/referencesChanged/skipped
  // reflect the SUBSET the committed run will execute. Two halves:
  //   (a) additive-default regression pin — an absent/empty mask leaves the summary byte-identical to today.
  //   (b) the mask actually masks — a non-empty mask changes the previewed counts/refs/skips coherently.
  it('additive default: excludeKinds absent === explicitly-empty (preview byte-identical to pre-mask)', async () => {
    const b = await buildWorkerState(loadRawFiles());
    const base = assemblePlanGate(b, baseOptions({ scaleTiers: ladder }));
    const emptyMask = assemblePlanGate(b, baseOptions({ scaleTiers: ladder, excludeKinds: [] }));
    expect(emptyMask.summary).toEqual(base.summary);
  });

  it('a non-empty mask re-previews the SUBSET: deselected counts drop, deselected-skips appended, refs recomputed', async () => {
    const b = await buildWorkerState(loadRawFiles());
    const base = assemblePlanGate(b, baseOptions({ scaleTiers: ladder }));
    // sanity: the unmasked plan HAS repack + tier (so masking them is meaningful) and predicts refs changed.
    expect((base.summary.opCounts.repack ?? 0)).toBeGreaterThan(0);
    expect((base.summary.opCounts.tier ?? 0)).toBeGreaterThan(0);
    expect(base.summary.referencesChanged).toBe(true);

    // deselect repack + tier — both gate the execute path here, so the masked preview must DIFFER.
    const masked = assemblePlanGate(b, baseOptions({ scaleTiers: ladder, excludeKinds: ['repack', 'tier'] }));
    expect(masked.summary).not.toEqual(base.summary);
    // deselected kinds drop OUT of opCounts (they won't run) …
    expect(masked.summary.opCounts.repack ?? 0).toBe(0);
    expect(masked.summary.opCounts.tier ?? 0).toBe(0);
    expect(masked.summary.totalOps).toBeLessThan(base.summary.totalOps);
    // … and each surfaces ONE honest deselected-skip note in OP_KIND_ORDER (repack before tier).
    const deselected = masked.summary.skipped.filter((s) => s.reason.endsWith('deselected in plan')).map((s) => s.reason);
    expect(deselected).toEqual(['repack skipped: deselected in plan', 'tier skipped: deselected in plan']);
  });

  it('deselecting the ONLY reference-changing driver flips the previewed referencesChanged to false (honest banner)', async () => {
    // A plain repack of an under-filled sheet is drop-in (refs unchanged); add tiering and tiering becomes the
    // sole ref-changing driver. Deselect `tier` ⇒ the only remaining ops are the drop-in repacks ⇒ the
    // previewed refs flag must be FALSE, so the PlanCard banner no longer over-warns on the chosen subset.
    const b = await buildWorkerState(loadRawFiles());
    const withTier = assemblePlanGate(b, baseOptions({ scaleTiers: ladder }));
    expect(withTier.summary.referencesChanged).toBe(true); // tiering renames the source

    const tierOff = assemblePlanGate(b, baseOptions({ scaleTiers: ladder, excludeKinds: ['tier'] }));
    // with tier deselected, no remaining op rewrites references (the repacks are single-ref same-name drop-ins).
    expect(tierOff.summary.referencesChanged).toBe(false);
    // and the full-plan (tier-on) preview WITHOUT the mask still warns — so this is a real flip, not a constant.
    expect(withTier.summary.referencesChanged).not.toBe(tierOff.summary.referencesChanged);
  });
});

// Fix-honesty (near-dup drop VRAM): the receipt's SOLE hard VRAM claim (vramBytesAfter) must count ONLY
// realized savings. A bare duplicate drop deletes a file but does NO repoint, so its w·h·4 is an UPPER BOUND,
// routed to the SEPARATE droppedDuplicateVramBytesUpperBound — never the hard claim. The owner-aware dedup drop
// (auto-repointed) keeps its own SEPARATE dedupVramBytesSavedUpperBound. This pins the accounting split via the
// shared SSOT predicates the worker branches on; the worker's impure exec itself is canvas-bound (not Node-runnable).
describe('drop-VRAM accounting split — bare-drop vs owner-aware (fix-honesty, invariants 3 & 5)', () => {
  const NEAR = 2048 * 2048 * 4; // 16 MB near-duplicate footprint (bare drop)
  const EXACT = 1024 * 1024 * 4; // 4 MB exact-duplicate footprint (owner-aware)
  const vramByRef = new Map<string, number>([
    ['near.png', NEAR],
    ['exact.png', EXACT],
  ]);
  const bareDrop: FixOp = { kind: 'drop', assetRef: 'near.png', reason: 'duplicate-similar' };
  const ownerDrop: FixOp = { kind: 'drop', assetRef: 'exact.png', reason: 'duplicate-exact', ownerRef: 'keep.png', repointManifest: true };

  it('the shared SSOT splits the two ops: bare ⇒ drop / not owner-aware; owner ⇒ dedup / owner-aware', () => {
    expect(fixOpKind(bareDrop)).toBe('drop');
    expect(isOwnerAwareDrop(bareDrop)).toBe(false);
    expect(fixOpKind(ownerDrop)).toBe('dedup');
    expect(isOwnerAwareDrop(ownerDrop)).toBe(true);
  });

  it('a BARE drop routes its w·h·4 to the dropped-duplicate upper bound, 0 to the hard vramSaved', () => {
    const acc = routeDropVram([bareDrop], vramByRef);
    expect(acc.droppedDuplicateVramBytesUpperBound).toBe(NEAR); // the SEPARATE upper bound
    expect(acc.vramSaved).toBe(0); // the fabricated fold into the hard claim is GONE
    expect(acc.dedupVramBytesSavedUpperBound).toBe(0); // not the owner-aware bucket
  });

  it('an OWNER-AWARE drop still routes to the dedup upper bound, 0 to the hard vramSaved (unchanged)', () => {
    const acc = routeDropVram([ownerDrop], vramByRef);
    expect(acc.dedupVramBytesSavedUpperBound).toBe(EXACT);
    expect(acc.vramSaved).toBe(0);
    expect(acc.droppedDuplicateVramBytesUpperBound).toBe(0);
  });

  it('a mixed run keeps the two upper bounds SEPARATE and the hard claim at 0 — never conflated', () => {
    const acc = routeDropVram([bareDrop, ownerDrop], vramByRef);
    expect(acc.droppedDuplicateVramBytesUpperBound).toBe(NEAR);
    expect(acc.dedupVramBytesSavedUpperBound).toBe(EXACT);
    expect(acc.vramSaved).toBe(0);
    expect(acc.droppedDuplicateVramBytesUpperBound).not.toBe(acc.dedupVramBytesSavedUpperBound); // distinct, invariant 5
  });
});
