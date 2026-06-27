// Headless worker-pipeline test for the owner-aware dedup execution (design §10.7–10.10). The impure
// Phase-C in apps/web/src/worker/fix.worker.ts (createImageBitmap / OffscreenCanvas) can't run in Node,
// so — exactly as docs/asset-builder-port-design.md's test plan prescribes and mirroring the headless
// dir-aware-loose.test.ts approach — we drive the REAL pure pipeline (groupFiles → parseAtlas →
// buildDedupGroups → planFix) over the raw-multifolder-dupes fixture and a faithful node-side
// re-implementation of the worker's Phase-C control flow, asserting the fixture's authored worker block:
//   • extra/sheet.json's emitted meta.image relative-resolves back to main_game/sheet.png THROUGH parseAtlas
//   • loose/orphan_copy.png lands in looseRepathSkipped (KEPT, never deleted)
//   • the spine pair animations/a|b/frame.png is kept (no silent .atlas page delete)
//   • referencesRewritten / dedupDiskBytesSaved match the fixture
//   • §10.8: a transcoded owner whose final name diverges → consumer KEPT (looseRepathSkipped++)
// Phase-C reuses the SAME pure path helpers the worker imports (relativeImageRef / resolveImageRef /
// emitTexturePackerJson) so a broken repoint can't pass green here while shipping in the worker.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import type { Asset, Atlas, ImageFeatures } from '@asset-doctor/core';
import { groupFiles, keyOf, type RawFile } from '@asset-doctor/ingest';
import { parseAtlas, parseAtlasManifest, parseSpinePage, type SpinePage } from '@asset-doctor/parsers';
import { buildDedupGroups } from '@asset-doctor/analysis';
import {
  planFix,
  emitTexturePackerJson,
  relativeImageRef,
  resolveImageRef,
  dirOf,
  normalize,
  // The SAME pure two-phase helpers the worker imports — driving them here makes this a single-source-of-
  // truth round-trip (a broken Phase-A prediction or owner-aware-drop filter can't pass green in the test
  // while shipping in fix.worker.ts).
  predictOwnerFinalNames,
  isOwnerAwareDrop,
} from '@asset-doctor/fix';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/sample-projects/raw-multifolder-dupes');

interface ExpectedJson {
  marking: Record<string, 'eager' | 'lazy' | 'isolated'>;
  skinGuard: Record<string, string>;
  worker: {
    repointManifest: { consumerImage: string; consumerManifest: string; ownerImage: string }[];
    looseRepathSkipped: string[];
  };
}
const expected = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8')) as ExpectedJson;

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
const sha256Hex = (b: ArrayBuffer): string => createHash('sha256').update(Buffer.from(b)).digest('hex');

// ── build the worker's data structures via the REAL pure pipeline ───────────────────────────────────
interface Built {
  bytesByRef: Map<string, ArrayBuffer>;
  pathByRef: Map<string, string>;
  vramByRef: Map<string, number>;
  spineRefs: Set<string>;
  atlasByRef: Map<string, Atlas>;
  manifestPathOf: (ref: string) => string | undefined;
  spineInfoOf: (ref: string) => { path: string } | undefined;
  features: ImageFeatures[];
  files: RawFile[];
}
async function buildWorkerState(files: RawFile[]): Promise<Built> {
  const raw: RawFile[] = files.map((f) => ({ name: f.name, path: f.path, bytes: f.bytes }));
  const grouped = groupFiles(raw);
  const assets: Asset[] = [];
  const bytesByRef = new Map<string, ArrayBuffer>();
  const pathByRef = new Map<string, string>();
  const spineRefs = new Set<string>();
  for (const a of grouped.atlases) {
    const image = { ref: a.name, bytes: new Uint8Array(a.image.bytes) };
    const res = a.kind === 'spine' ? parseSpinePage(a.manifest as SpinePage, image, { name: a.name }) : parseAtlas(a.manifest, image, { name: a.name });
    if (res.ok && res.asset.kind === 'atlas') {
      assets.push(res.asset);
      bytesByRef.set(res.asset.atlas.name, a.image.bytes);
      pathByRef.set(res.asset.atlas.name, a.image.path ?? a.image.name);
      if (a.kind === 'spine') spineRefs.add(res.asset.atlas.name);
    }
  }
  const { parseImage, parseSpineAtlasText } = await import('@asset-doctor/parsers');
  for (const im of grouped.images) {
    const ref = keyOf(im);
    bytesByRef.set(ref, im.bytes);
    pathByRef.set(ref, im.path ?? im.name);
    const r = parseImage(ref, new Uint8Array(im.bytes));
    if (r.ok && r.asset.kind === 'image') assets.push(r.asset);
  }
  // manifest path keyed by RESOLVED image path (dir-aware), exactly like the worker.
  const td = new TextDecoder();
  const manifestPathByImage = new Map<string, string>();
  for (const f of files) {
    if (!/\.json$/i.test(f.name)) continue;
    try {
      const j = JSON.parse(td.decode(f.bytes)) as { meta?: { image?: unknown } };
      if (typeof j.meta?.image === 'string') manifestPathByImage.set(resolveImageRef(f.path!, j.meta.image), f.path!);
    } catch {
      /* not a manifest */
    }
  }
  const spineAtlasInfo = new Map<string, { path: string }>();
  for (const f of files) {
    if (!/\.atlas$/i.test(f.name)) continue;
    try {
      for (const pg of parseSpineAtlasText(td.decode(f.bytes))) spineAtlasInfo.set(resolveImageRef(f.path!, pg.image), { path: f.path! });
    } catch {
      /* not a spine atlas */
    }
  }
  const manifestPathOf = (ref: string): string | undefined => manifestPathByImage.get(pathByRef.get(ref) ?? '');
  const spineInfoOf = (ref: string): { path: string } | undefined => spineAtlasInfo.get(pathByRef.get(ref) ?? '');

  const atlasByRef = new Map<string, Atlas>();
  const vramByRef = new Map<string, number>();
  for (const a of assets) {
    if (a.kind === 'atlas') {
      atlasByRef.set(a.atlas.name, a.atlas);
      vramByRef.set(a.atlas.name, a.atlas.size.w * a.atlas.size.h * 4);
    } else {
      vramByRef.set(a.image.name, a.image.size.w * a.image.size.h * 4);
    }
  }
  const features: ImageFeatures[] = [];
  for (const [ref, bytes] of bytesByRef) features.push({ assetRef: ref, contentHash: sha256Hex(bytes) });
  features.sort((a, b) => (a.assetRef < b.assetRef ? -1 : a.assetRef > b.assetRef ? 1 : 0));

  return { bytesByRef, pathByRef, vramByRef, spineRefs, atlasByRef, manifestPathOf, spineInfoOf, features, files };
}

// ── faithful node-side re-implementation of the worker's Phase-C control flow ────────────────────────
// Mirrors fix.worker.ts:617-697 (the impure half). The owner-name maps degenerate to identity here (no
// transforms run), EXCEPT the optional `transcodedOwners` set which simulates a divergent transcoded owner
// (the §10.8 keep-the-consumer case) by giving the owner a renamed actual image the prediction won't match.
interface PhaseCResult {
  emitted: { path: string; manifest: unknown }[];
  dropped: Set<string>;
  skipped: { assetRef: string; reason: string }[];
  referencesRewritten: number;
  looseRepathSkipped: number;
  dedupDiskBytesSaved: number;
  dedupVramBytesSavedUpperBound: number;
}
function runPhaseC(b: Built, transcodedOwners: Set<string> = new Set(), tiering = false): PhaseCResult {
  const isAtlasRef = (ref: string): boolean => b.atlasByRef.has(ref);
  const groups = buildDedupGroups(b.features, b.spineRefs, expected.marking, expected.skinGuard);
  // When tiering is on, plan.ts sets keepConsumer on owner-aware drops (the owner gets renamed) — the
  // exact composition Finding 1 exercises. validateTiers requires a scale-1 top tier in the ladder.
  const scaleTiers = tiering ? [{ scale: 1, suffix: '_1080p' }, { scale: 0.5, suffix: '_540p' }] : undefined;
  const plan = planFix(
    { assets: [], findings: [], totals: { diskBytes: 0, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 }, thresholds: {} as never },
    { targetMime: 'image/webp', quality: 0.9, lossless: true, padding: 2, maxSize: 4096, maxEdge: 2048, aggressive: true, isAtlasRef, ...(scaleTiers ? { scaleTiers } : {}) },
    groups,
  );
  // SAME owner-aware-drop filter the worker uses (the pure isOwnerAwareDrop type guard).
  const dedupDrops = plan.ops.filter(isOwnerAwareDrop);

  // Phase A — predicted owner final image, computed by the SAME pure predictOwnerFinalNames the worker
  // drives. A `transcodedOwners` member is modelled exactly as the worker models a transcoded owner: the
  // plan predicts the renamed (.webp) name. (No transcode ops exist in this harness's plan, so a non-
  // transcoded owner's prediction == its current path — the normal case.)
  const predictedFinal = predictOwnerFinalNames(groups, (ref) => ({
    imagePath: b.pathByRef.get(ref),
    manifestPath: b.manifestPathOf(ref),
    transcoded: transcodedOwners.has(ref),
    targetMime: 'image/webp',
  }));
  // Phase B — actual owner final image. A `transcodedOwners` member simulates the worker's §10.8 keep-the-
  // consumer case: the transcode FAILED, so the owner keeps its ORIGINAL image while the prediction still
  // says .webp ⇒ Phase C must detect the divergence and KEEP the consumer rather than dangle the reference.
  const ownerActualImage = new Map<string, string>();
  for (const [ref, fn] of predictedFinal) ownerActualImage.set(ref, transcodedOwners.has(ref) ? b.pathByRef.get(ref)! : fn.image);

  const res: PhaseCResult = { emitted: [], dropped: new Set(), skipped: [], referencesRewritten: 0, looseRepathSkipped: 0, dedupDiskBytesSaved: 0, dedupVramBytesSavedUpperBound: 0 };
  for (const op of dedupDrops) {
    const consumerRef = op.assetRef;
    const consumerPath = b.pathByRef.get(consumerRef);
    const ownerRef = op.ownerRef!;
    const predicted = predictedFinal.get(ownerRef)?.image;
    const actual = ownerActualImage.get(ownerRef);
    if (!consumerPath) continue;
    // keepConsumer (design correction 8 / Finding 1): scale tiering renames the owner away from its
    // predicted name, so the repoint is impossible — short-circuit to keep-the-consumer (drop NOTHING).
    // Mirrors fix.worker.ts; WITHOUT it an atlas consumer (repointManifest suppressed) would fall through
    // to the repoint branch and dangle once the tier loop renames+drops the owner.
    if (op.keepConsumer) {
      res.looseRepathSkipped++;
      res.skipped.push({ assetRef: consumerRef, reason: 'owner renamed by scale tiering — kept duplicate' });
      continue;
    }
    if (predicted == null || actual == null || actual !== predicted) {
      res.looseRepathSkipped++;
      res.skipped.push({ assetRef: consumerRef, reason: 'owner final name diverged — kept duplicate' });
      continue;
    }
    const consumerVram = b.vramByRef.get(consumerRef) ?? 0;
    const consumerDisk = b.bytesByRef.get(consumerRef)?.byteLength ?? 0;

    // Spine consumer: keep, never re-emit a .atlas page as TexturePacker JSON.
    if (b.spineRefs.has(consumerRef)) {
      res.looseRepathSkipped++;
      res.skipped.push({ assetRef: consumerRef, reason: 'Spine cross-page dedup not drop-in — kept duplicate' });
      continue;
    }
    if (op.repointManifest) {
      const consumerManifest = b.manifestPathOf(consumerRef);
      const consumerAtlas = b.atlasByRef.get(consumerRef);
      if (!consumerManifest || !consumerAtlas) {
        res.looseRepathSkipped++;
        res.skipped.push({ assetRef: consumerRef, reason: 'atlas consumer manifest unavailable — kept duplicate' });
        continue;
      }
      const repointed: Atlas = { ...consumerAtlas, imageRef: relativeImageRef(dirOf(consumerManifest), actual) };
      res.emitted.push({ path: consumerManifest, manifest: JSON.parse(emitTexturePackerJson(repointed)) });
      res.dropped.add(consumerPath); // drop only the redundant image; manifest kept (rewritten)
      res.referencesRewritten++;
      res.dedupDiskBytesSaved += consumerDisk;
      res.dedupVramBytesSavedUpperBound += consumerVram;
      continue;
    }
    // Whole-file (loose) consumer: rewrite ONLY where AD emits the referencing manifest; else KEEP.
    const referencingManifest = b.manifestPathOf(consumerRef);
    const referencingAtlas = b.atlasByRef.get(consumerRef);
    if (!referencingManifest || !referencingAtlas) {
      res.looseRepathSkipped++;
      res.skipped.push({ assetRef: consumerRef, reason: 'loose duplicate reference may live in game code — kept duplicate' });
      continue;
    }
    const repointed: Atlas = { ...referencingAtlas, imageRef: relativeImageRef(dirOf(referencingManifest), actual) };
    res.emitted.push({ path: referencingManifest, manifest: JSON.parse(emitTexturePackerJson(repointed)) });
    res.dropped.add(consumerPath);
    res.referencesRewritten++;
    res.dedupDiskBytesSaved += consumerDisk;
    res.dedupVramBytesSavedUpperBound += consumerVram;
  }
  return res;
}

describe('worker Phase-C owner-aware dedup execution (golden worker block)', () => {
  it('repoints extra/sheet.json meta.image back to main_game/sheet.png THROUGH parseAtlas (§10.7)', async () => {
    const b = await buildWorkerState(loadRawFiles());
    const res = runPhaseC(b);

    const want = expected.worker.repointManifest[0]!; // { consumerImage, consumerManifest, ownerImage }
    const emitted = res.emitted.find((e) => e.path === want.consumerManifest);
    expect(emitted, `expected a repointed manifest at ${want.consumerManifest}`).toBeDefined();

    // Round-trip THROUGH the real parser: re-parse the emitted manifest the way a loader would (meta.image
    // is the imageRef), then resolve it against the consumer manifest's dir → must equal the OWNER image.
    const parsed = parseAtlasManifest(emitted!.manifest, {});
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(resolveImageRef(want.consumerManifest, parsed.atlas.imageRef)).toBe(normalize(want.ownerImage));
    }
    // The redundant consumer IMAGE is dropped; the manifest is KEPT (it was re-emitted, not deleted).
    expect(res.dropped.has(want.consumerImage)).toBe(true);
    expect([...res.dropped]).not.toContain(want.consumerManifest);
  });

  it('keeps loose/orphan_copy.png in looseRepathSkipped — never deleted (§10.9)', async () => {
    const b = await buildWorkerState(loadRawFiles());
    const res = runPhaseC(b);
    for (const ref of expected.worker.looseRepathSkipped) {
      expect(res.skipped.some((s) => s.assetRef === ref), `${ref} should be surfaced as skipped`).toBe(true);
      expect(res.dropped.has(ref), `${ref} must NOT be deleted`).toBe(false);
    }
    expect(res.looseRepathSkipped).toBeGreaterThanOrEqual(expected.worker.looseRepathSkipped.length);
  });

  it('keeps the spine pair (animations/b/frame.png) — no silent .atlas page delete', async () => {
    const b = await buildWorkerState(loadRawFiles());
    const res = runPhaseC(b);
    // animations/a|b/frame.png are byte-identical in the spine pool; the consumer must be KEPT, surfaced.
    expect(res.dropped.has('animations/b/frame.png')).toBe(false);
    expect(res.skipped.some((s) => s.assetRef === 'animations/b/frame.png')).toBe(true);
  });

  it('counts referencesRewritten + dedup disk/VRAM only for the safe atlas repoint', async () => {
    const b = await buildWorkerState(loadRawFiles());
    const res = runPhaseC(b);
    // Exactly the one atlas repoint (extra/sheet.png → main_game/sheet.png) is rewritten; the loose dup,
    // the spine page, and the isolated/lazy pairs are all KEPT (no eager cross-bundle owner for them).
    expect(res.referencesRewritten).toBe(expected.worker.repointManifest.length);
    expect(res.dedupDiskBytesSaved).toBe(b.bytesByRef.get('extra/sheet.png')!.byteLength);
    expect(res.dedupVramBytesSavedUpperBound).toBe(b.vramByRef.get('extra/sheet.png'));
    // VRAM saving is tracked SEPARATELY from disk — both positive, neither folded into the other.
    expect(res.dedupDiskBytesSaved).toBeGreaterThan(0);
    expect(res.dedupVramBytesSavedUpperBound).toBeGreaterThan(0);
  });

  it('transcoded-owner divergence (§10.8): consumer KEPT when the owner final name diverges', async () => {
    const b = await buildWorkerState(loadRawFiles());
    // Simulate main_game/sheet.png being transcoded (→ .webp) so the owner's ACTUAL name diverges from the
    // Phase-A prediction. The worker keeps the consumer rather than dangle a reference at a missing name.
    const res = runPhaseC(b, new Set(['main_game/sheet.png']));
    expect(res.skipped.some((s) => s.assetRef === 'extra/sheet.png')).toBe(true);
    expect(res.dropped.has('extra/sheet.png')).toBe(false); // KEPT — not dropped against a diverged owner
    expect(res.referencesRewritten).toBe(0); // the only repoint was suppressed by the divergence guard
  });

  it('dedup × tiering (correction 8 / Finding 1): no surviving manifest references a DROPPED owner image', async () => {
    const b = await buildWorkerState(loadRawFiles());
    // aggressive + tiering ⇒ plan.ts sets keepConsumer on the owner-aware drops (the owner gets renamed by
    // the tier loop). Phase C MUST keep the atlas consumer (extra/sheet.json + extra/sheet.png) intact and
    // repoint NOTHING — otherwise it repoints extra/sheet.json's meta.image at main_game/sheet.png (the
    // owner's PRE-tier name), the tier loop then renames+drops that image, and the kept manifest dangles.
    const res = runPhaseC(b, new Set(), true);

    // The consumer is KEPT (its image NOT dropped) and surfaced — never repointed at the owner.
    expect(res.dropped.has('extra/sheet.png')).toBe(false);
    expect(res.skipped.some((s) => s.assetRef === 'extra/sheet.png')).toBe(true);
    expect(res.referencesRewritten).toBe(0); // owner-aware repoint disabled wholesale under tiering
    // No manifest was re-emitted to point at the owner image.
    expect(res.emitted.some((e) => e.path === 'extra/sheet.json')).toBe(false);

    // Now simulate the tier loop renaming + DROPPING the owner image (the source-rename step). Combined with
    // Phase C's drops, assert the invariant: no surviving (emitted-or-kept) manifest references a dropped
    // owner image. With keepConsumer the consumer manifest is untouched (still points at its OWN image), so
    // the only thing referencing main_game/sheet.png is the owner's own per-tier manifest (main_game/
    // sheet_1080p.json → main_game/sheet_1080p.png), which is self-consistent.
    const droppedOwnerImage = 'main_game/sheet.png';
    const tierDropped = new Set<string>([...res.dropped, droppedOwnerImage]);
    // The kept consumer manifest references extra/sheet.png (its own kept image), NOT the dropped owner.
    expect(tierDropped.has('extra/sheet.png')).toBe(false);
    // No Phase-C-emitted manifest references the dropped owner image (none were emitted at all here).
    for (const e of res.emitted) {
      const json = e.manifest as { meta?: { image?: string } };
      const img = json.meta?.image;
      if (img) {
        // resolve the manifest's meta.image to a folder-relative path and assert it isn't the dropped owner.
        expect(img.endsWith('sheet.png') && e.path.startsWith('extra/'), `${e.path} must not dangle at the dropped owner`).toBe(false);
      }
    }
  });
});
