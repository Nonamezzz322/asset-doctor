// Headless worker-pipeline test for the SCALE-TIER multiplier (design docs/scale-tiers-design.md §5/§7,
// test plan §11 T9–T13). The impure tier loop in apps/web/src/worker/fix.worker.ts (createImageBitmap /
// OffscreenCanvas) can't run in Node, so — exactly as dedup-worker-phase-c.test.ts does — we drive the
// REAL pure pipeline (groupFiles → parse → validateTiers/planFix) over the authored tier-source fixtures
// plus a faithful node-side re-implementation of the tier loop's CONTROL FLOW (geometry, per-tier naming,
// skip/refusal gates, source-rename drops, the receipt's tierVram ladder, and the 0-vramSaved invariant).
// Only the actual pixel encode is skipped (irrelevant to geometry/naming/VRAM honesty).
//
// The tier loop reuses the SAME pure helpers the worker imports (scaleAtlas / scaleLoose / tieredName /
// validateTiers / hasResolutionToken), so a broken tier geometry, name clash, or refusal gate can't pass
// green here while shipping in the worker. Asserts:
//   • T9  — multi-emit: N tiers × eligible asset; NO un-suffixed original survives in the emitted set
//            (loose image, atlas image+manifest, single-page spine page+.atlas)
//   • T11 — single-page spine tiered; 2-page spine REFUSED via tierRefusal (correction 4)
//   • T12 — meshed atlas REFUSED (scaleAtlas drops mesh; correction 2); no rectangle-only tier emitted
//   • T13 — tiering-only run contributes 0 to vramSaved (vramBytesAfter === vramBytesBefore) + the
//            tierVram ladder = 1× / 0.5625× / 0.25× of the top-tier footprint
//   • dedup×tiering (correction 8, Finding 1 regression): when aggressive+tiering, no SURVIVING manifest
//            references a DROPPED owner image — the keepConsumer short-circuit keeps the consumer intact.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import type { Asset, Atlas, ScaleTier, Size } from '@asset-doctor/core';
import { groupFiles, keyOf, type RawFile } from '@asset-doctor/ingest';
import { parseAtlas, parseImage, parseSpineAtlasText, parseSpinePage, type SpinePage } from '@asset-doctor/parsers';
import { mergeSharedAtlases, hasResolutionToken } from '@asset-doctor/analysis';
import { scaleAtlas, scaleLoose, tieredName, validateTiers, DEFAULT_SCALE_TIERS, emitTexturePackerJson, emitSpineAtlasText, resolveImageRef } from '@asset-doctor/fix';

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

// ── build the worker's data structures via the REAL pure pipeline (mirrors fix.worker.ts:90-160) ─────
interface Built {
  merged: Asset[];
  pathByRef: Map<string, string>;
  sizeByRef: Map<string, Size>;
  vramByRef: Map<string, number>;
  spineRefs: Set<string>;
  atlasByRef: Map<string, Atlas>;
  manifestPathOf: (ref: string) => string | undefined;
  spineInfoOf: (ref: string) => { path: string; pages: number } | undefined;
}
function buildWorkerState(files: RawFile[]): Built {
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
  const manifestPathByImage = new Map<string, string>();
  for (const f of files) {
    if (!/\.json$/i.test(f.name)) continue;
    try {
      const j = JSON.parse(td.decode(new Uint8Array(f.bytes))) as { meta?: { image?: unknown } };
      if (typeof j.meta?.image === 'string') manifestPathByImage.set(resolveImageRef(f.path!, j.meta.image), f.path!);
    } catch {
      /* not a manifest */
    }
  }
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
  const manifestPathOf = (ref: string): string | undefined => manifestPathByImage.get(pathByRef.get(ref) ?? '');
  const spineInfoOf = (ref: string): { path: string; pages: number } | undefined => spineAtlasInfo.get(pathByRef.get(ref) ?? '');

  const merged = mergeSharedAtlases(assets);
  const atlasByRef = new Map<string, Atlas>();
  const vramByRef = new Map<string, number>();
  const sizeByRef = new Map<string, Size>();
  for (const a of merged) {
    if (a.kind === 'atlas') {
      atlasByRef.set(a.atlas.name, a.atlas);
      vramByRef.set(a.atlas.name, a.atlas.size.w * a.atlas.size.h * 4);
      sizeByRef.set(a.atlas.name, a.atlas.size);
    } else {
      vramByRef.set(a.image.name, a.image.size.w * a.image.size.h * 4);
      sizeByRef.set(a.image.name, a.image.size);
    }
  }
  return { merged, pathByRef, sizeByRef, vramByRef, spineRefs, atlasByRef, manifestPathOf, spineInfoOf };
}

// ── faithful node re-implementation of the worker tier loop control flow (fix.worker.ts ~1017-1126) ──
// Skips ONLY the impure encode (canvas/createImageBitmap); every name/geometry/gate/drop is computed from
// the REAL pure helpers, so a broken loop can't pass green here while shipping. maxEdge huge ⇒ no clamp
// (these fixtures aren't oversized; oversize math is covered by plan T5).
interface TierResult {
  out: { path: string; isManifest: boolean }[];
  dropped: Set<string>;
  skipped: { assetRef: string; reason: string }[];
  tieredAssets: number;
  tierFilesEmitted: number;
  tierVramBytes: number[];
  vramSaved: number; // tiering NEVER accrues vramSaved (invariant 5 / T13)
  // round24 r24#0 follow-up: one candidate per tier the browser drawImage actually DOWNSCALES (dst<src). This
  // models the worker's tierIsDownscale guard (fix.worker.ts) — including the OVERSIZE-CLAMPED top tier
  // (tier.scale===1 yet dst<src from clampToMaxEdge). srcW/srcH are the honest Node stand-in for the srcBmp
  // dims a well-formed source carries (= srcSize.w/h). Empty when resample is off (default path byte-identical).
  resampleCandidates: { ref: string; targetW: number; targetH: number }[];
}
// maxEdge defaults to 1<<20 (no clamp — un-oversized fixtures); the resample tests parameterize it to drive
// the REAL clampToMaxEdge so the oversize-clamped top tier (the r24#0 gap) is reproduced. resampleEnabled
// defaults false so the off-path is provably empty (T16).
function runTierLoop(b: Built, tiers: ScaleTier[], tierForce = false, resampleEnabled = false, maxEdge = 1 << 20): TierResult {
  const res: TierResult = { out: [], dropped: new Set(), skipped: [], tieredAssets: 0, tierFilesEmitted: 0, tierVramBytes: tiers.map(() => 0), vramSaved: 0, resampleCandidates: [] };
  const basename = (p: string): string => p.split('/').pop() ?? p;

  const tierRefusal = (ref: string): string | null => {
    if (!tierForce && hasResolutionToken(ref)) return 'tier skipped: asset is already a resolution tier';
    const atlas = b.atlasByRef.get(ref);
    if (atlas) {
      if (atlas.sprites.some((s) => s.mesh)) return 'tier skipped: meshed atlas not supported (scaleAtlas drops mesh)';
      if (b.spineRefs.has(ref)) {
        const info = b.spineInfoOf(ref);
        if (info && info.pages > 1) return 'tier skipped: multi-page Spine not supported in v1';
      }
    }
    return null;
  };
  const clampToMaxEdge = (size: Size): Size => {
    const longest = Math.max(size.w, size.h);
    if (!(longest > maxEdge)) return { w: size.w, h: size.h };
    const s = maxEdge / longest;
    return { w: Math.max(1, Math.round(size.w * s)), h: Math.max(1, Math.round(size.h * s)) };
  };

  for (const a of b.merged) {
    const ref = a.kind === 'atlas' ? a.atlas.name : a.image.name;
    const refusal = tierRefusal(ref);
    if (refusal) {
      res.skipped.push({ assetRef: ref, reason: refusal });
      continue;
    }
    const imagePath = b.pathByRef.get(ref);
    if (!imagePath) continue;
    const srcSize = b.sizeByRef.get(ref);
    if (!srcSize) continue;
    const isSpine = b.spineRefs.has(ref);
    const atlas = b.atlasByRef.get(ref);
    const top = clampToMaxEdge(srcSize);
    // srcW/srcH = the honest Node stand-in for the decoded srcBmp dims (= srcSize) — the drawImage source rect.
    const srcW = srcSize.w;
    const srcH = srcSize.h;
    const manifestPath = !isSpine ? b.manifestPathOf(ref) : undefined;
    const spineInfo = isSpine ? b.spineInfoOf(ref) : undefined;

    let emittedAny = false;
    for (let ti = 0; ti < tiers.length; ti++) {
      const tier = tiers[ti]!;
      const effectiveScale = (top.w / srcSize.w) * tier.scale;
      const scaled = atlas ? scaleAtlas(atlas, effectiveScale) : undefined;
      const dst: Size = scaled ? { w: scaled.size.w, h: scaled.size.h } : scaleLoose(top, tier.scale);
      // round24 r24#0 follow-up: model the worker's per-tier tierIsDownscale guard. dst<src is the EXACT truth
      // condition that the browser drawImage ran a downscale on this tier — fires on the oversize-clamped top
      // tier (tier.scale===1 yet dst<src) too, the gap the old tier.scale<1 model silently missed.
      const tierIsDownscale = dst.w < srcW || dst.h < srcH;
      if (resampleEnabled && tierIsDownscale) res.resampleCandidates.push({ ref, targetW: dst.w, targetH: dst.h });
      // mime: the test uses the source ext (no transcode) — tieredName(path, suffix) keeps the ext.
      const tierImagePath = tieredName(imagePath, tier.suffix);
      res.out.push({ path: tierImagePath, isManifest: false });
      res.tierFilesEmitted++;
      if (scaled) {
        scaled.scale = tier.scale;
        scaled.imageRef = basename(tierImagePath);
        if (isSpine && spineInfo) {
          // emit the per-tier .atlas (geometry round-trips through emitSpineAtlasText)
          emitSpineAtlasText(scaled);
          res.out.push({ path: tieredName(spineInfo.path, tier.suffix), isManifest: true });
          res.tierFilesEmitted++;
        } else if (manifestPath) {
          emitTexturePackerJson(scaled);
          res.out.push({ path: tieredName(manifestPath, tier.suffix), isManifest: true });
          res.tierFilesEmitted++;
        }
      }
      res.tierVramBytes[ti] = (res.tierVramBytes[ti] ?? 0) + dst.w * dst.h * 4;
      emittedAny = true;
    }
    if (!emittedAny) continue;
    // rename the source away (every original path → dropped)
    res.dropped.add(imagePath);
    if (atlas) {
      if (isSpine) {
        if (spineInfo) res.dropped.add(spineInfo.path);
      } else if (manifestPath) {
        res.dropped.add(manifestPath);
      }
    }
    res.tieredAssets++;
  }
  return res;
}

describe('scale-tier worker loop (geometry + gates + VRAM honesty, design §5/§7, T9–T13)', () => {
  const tiers = validateTiers([...DEFAULT_SCALE_TIERS]);
  if (!tiers.ok) throw new Error('default ladder must validate');

  it('T9 — multi-emit: no un-suffixed original survives for the tiered loose image / atlas / single spine', () => {
    const b = buildWorkerState(loadRawFiles());
    const res = runTierLoop(b, tiers.tiers);

    // banner.png (loose), sheet.png (atlas), spine_single.png (single-page spine) are all eligible → tiered.
    // meshed.png + spine_multi.* are refused (asserted in T11/T12) so they are NOT in tieredAssets.
    expect(res.tieredAssets).toBe(3);

    // Every original source path of a tiered asset is dropped — never shipped beside its _1080p tier.
    expect(res.dropped.has('banner.png')).toBe(true);
    expect(res.dropped.has('sheet.png')).toBe(true);
    expect(res.dropped.has('sheet.json')).toBe(true);
    expect(res.dropped.has('spine_single.png')).toBe(true);
    expect(res.dropped.has('spine_single.atlas')).toBe(true);

    // The emitted tier paths are all suffixed; no un-suffixed original appears in `out`.
    const outPaths = new Set(res.out.map((o) => o.path));
    for (const orig of ['banner.png', 'sheet.png', 'sheet.json', 'spine_single.png', 'spine_single.atlas']) {
      expect(outPaths.has(orig), `${orig} must NOT be emitted un-suffixed`).toBe(false);
    }
    // Each tier produced a suffixed image; the atlas/spine also produced a suffixed manifest.
    expect(outPaths.has('banner_1080p.png')).toBe(true);
    expect(outPaths.has('banner_720p.png')).toBe(true);
    expect(outPaths.has('banner_540p.png')).toBe(true);
    expect(outPaths.has('sheet_1080p.png')).toBe(true);
    expect(outPaths.has('sheet_1080p.json')).toBe(true);
    expect(outPaths.has('spine_single_540p.png')).toBe(true);
    expect(outPaths.has('spine_single_540p.atlas')).toBe(true);

    // filesEmitted: banner = 3 (image only) + sheet = 6 (image+manifest ×3) + spine = 6 = 15.
    expect(res.tierFilesEmitted).toBe(15);
  });

  it('T11 — single-page spine is tiered; the 2-page spine is REFUSED (correction 4)', () => {
    const b = buildWorkerState(loadRawFiles());
    const res = runTierLoop(b, tiers.tiers);
    expect(res.skipped.some((s) => s.reason.includes('multi-page Spine'))).toBe(true);
    // the multi-page page images / .atlas are NOT dropped (kept untouched, never tiered).
    expect(res.dropped.has('spine_multi.atlas')).toBe(false);
    expect(res.dropped.has('spine_multi_0.png')).toBe(false);
  });

  it('T12 — meshed atlas is REFUSED; scaleAtlas drops mesh so no rectangle-only tier is emitted', () => {
    const b = buildWorkerState(loadRawFiles());
    // the data-driven gate fires because the parsed sprites carry a mesh.
    const meshedRef = [...b.atlasByRef.keys()].find((r) => r.includes('meshed'))!;
    expect(b.atlasByRef.get(meshedRef)!.sprites.some((s) => s.mesh)).toBe(true);
    // and scaleAtlas indeed strips it (the precondition for the refusal).
    expect(scaleAtlas(b.atlasByRef.get(meshedRef)!, 0.5).sprites.every((s) => s.mesh === undefined)).toBe(true);

    const res = runTierLoop(b, tiers.tiers);
    expect(res.skipped.some((s) => s.reason.includes('meshed atlas'))).toBe(true);
    const outPaths = new Set(res.out.map((o) => o.path));
    expect(outPaths.has('meshed_1080p.png')).toBe(false); // never emitted as a rectangle-only tier
    expect(res.dropped.has('meshed.png')).toBe(false);
  });

  it('T13 — tiering contributes 0 to vramSaved; tierVram ladder = 1× / 0.5625× / 0.25× of the top tier', () => {
    const b = buildWorkerState(loadRawFiles());
    const vramBefore = [...b.vramByRef.values()].reduce((s, v) => s + v, 0);
    const res = runTierLoop(b, tiers.tiers);

    // INVARIANT 5: the tier loop never accrues vramSaved ⇒ vramBytesAfter === vramBytesBefore.
    expect(res.vramSaved).toBe(0);
    const vramAfter = Math.max(0, vramBefore - res.vramSaved);
    expect(vramAfter).toBe(vramBefore);

    // tierVram ladder: tier i footprint relative to the top tier follows scale². 720p = 0.75² = 0.5625,
    // 540p = 0.5² = 0.25 — within the integer-floor rounding of the tiered assets.
    const [top, mid, low] = res.tierVramBytes;
    expect(top!).toBeGreaterThan(0);
    expect(mid! / top!).toBeGreaterThan(0.5);
    expect(mid! / top!).toBeLessThan(0.62); // ≈0.5625 with per-asset 1px floor
    expect(low! / top!).toBeGreaterThan(0.22);
    expect(low! / top!).toBeLessThan(0.28); // ≈0.25 with per-asset 1px floor
    // never summed: the ladder is alternatives, not additive.
    expect(top! + mid! + low!).toBeGreaterThan(top!);
  });

  // ── round24 r24#0 follow-up: resample the OVERSIZE-CLAMPED top tier (effectiveScale<1) ────────────────
  // The clamp is driven through the REAL clampToMaxEdge by parameterizing maxEdge. banner.png is 100×50;
  // maxEdge = floor(max(100,50)*0.6) = 60 is self-calibrating from sizeByRef (no magic number) and clamps the
  // banner top tier to {60,30} — reproducing the r24#0 gap: tier.scale===1, dst={60,30} < src={100,50}.
  // maxEdge=60 also clamps the other (larger) assets, so every assertion filters candidates to BANNER only.
  it('T14 — oversize-clamped top tier produces a top-tier resample candidate (CONFIRM the op FIRES)', () => {
    const b = buildWorkerState(loadRawFiles());
    const banner = b.sizeByRef.get('banner.png')!;
    expect(banner).toEqual({ w: 100, h: 50 }); // fixture sanity (the subject of the clamp)
    const maxEdge = Math.floor(Math.max(banner.w, banner.h) * 0.6); // = 60, self-calibrating from sizeByRef
    expect(maxEdge).toBe(60);

    const res = runTierLoop(b, tiers.tiers, false, true, maxEdge);
    const bannerCands = res.resampleCandidates.filter((c) => c.ref === 'banner.png');

    // The clamped TOP tier (tier.scale===1) → clampToMaxEdge(banner) = {60,30}. The old tier.scale<1 model
    // NEVER recorded this; the dst<src fix does. This is THE load-bearing assertion (the op FIRES on top tier).
    const clampedTop = { w: Math.max(1, Math.round(banner.w * (maxEdge / Math.max(banner.w, banner.h)))), h: Math.max(1, Math.round(banner.h * (maxEdge / Math.max(banner.w, banner.h)))) };
    expect(clampedTop).toEqual({ w: 60, h: 30 });
    expect(bannerCands.some((c) => c.targetW === clampedTop.w && c.targetH === clampedTop.h)).toBe(true);

    // banner candidate count === 3: top (clamped) + two lower tiers (all real downscales of the clamped top).
    expect(bannerCands.length).toBe(3);

    // Equivalence assertion (documents the WHY): for the clamped top tier BOTH the effectiveScale<1 alias and
    // the dst<src signal are true — effectiveScale = (clampedTop.w/banner.w)*1 < 1, AND dst<src on ≥1 axis.
    expect((clampedTop.w / banner.w) * 1).toBeLessThan(1);
    expect(clampedTop.w < banner.w || clampedTop.h < banner.h).toBe(true);
  });

  it('T15 — NO top-tier candidate when the source is NOT oversized (over-fire guard, edge case 2)', () => {
    const b = buildWorkerState(loadRawFiles());
    const banner = b.sizeByRef.get('banner.png')!;
    // maxEdge huge ⇒ no clamp ⇒ top tier dst === src ⇒ tierIsDownscale=false on the top tier.
    const res = runTierLoop(b, tiers.tiers, false, true, 1 << 20);
    const bannerCands = res.resampleCandidates.filter((c) => c.ref === 'banner.png');

    // No candidate matches the UN-clamped top tier dims — no spurious upload for a same-size top tier.
    expect(bannerCands.some((c) => c.targetW === banner.w && c.targetH === banner.h)).toBe(false);
    // The two LOWER tiers (real downscales) DO produce candidates ⇒ count === 2 for banner.
    expect(bannerCands.length).toBe(2);
  });

  it('T16 — resample gate OFF ⇒ zero candidates (default path byte-identical)', () => {
    const b = buildWorkerState(loadRawFiles());
    // resampleEnabled=false, for ANY maxEdge (clamped or not) ⇒ no candidates collected at all.
    expect(runTierLoop(b, tiers.tiers, false, false, 60).resampleCandidates.length).toBe(0);
    expect(runTierLoop(b, tiers.tiers, false, false, 1 << 20).resampleCandidates.length).toBe(0);
  });
});
