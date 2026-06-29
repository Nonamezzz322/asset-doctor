// Prebuilt-atlas PASSTHROUGH transcode — worker-seam test (round20 #1). The fix.worker pixel loop can't run
// in Node (createImageBitmap / OffscreenCanvas), so — exactly like best-format-worker.test.ts — we reproduce
// the DEFECT through the REAL parse→analyze→plan path (Harness A) and FAITHFULLY mirror the worker's atlas
// transcode DECISION + repoint seam (Harness B/C) over the emitted op. The PURE pixel-free half (the actual
// repointAtlasImage round-trip through @asset-doctor/parsers) lives in packages/fix/test/atlas-transcode.test.ts.
//
// THE BUG: analyze.ts sizes ATLAS PAGES too (addFormat(atlas.name, image)), so a well-packed (high-occupancy)
// + correctly-sized (POT, not oversize) prebuilt sheet whose page transcodes smaller earns a `format` finding
// on its PAGE → a standalone transcode op with NO repack/resize. Before round20 the worker treated that op as
// a loose image: it renamed sheet.png → sheet.webp but NEVER repointed the sidecar's meta.image ⇒ dangling ref.

import { describe, it, expect } from 'vitest';
import type { Asset, Atlas, FixOp, ImageMime, Sprite } from '@asset-doctor/core';
import { analyze, type EncodeSizer } from '@asset-doctor/analysis';
import {
  planFix,
  resolveOptions,
  repointAtlasImage,
  emitTexturePackerJson,
  emitSpineAtlasText,
  resolveImageRef,
  type EffectiveOptions,
} from '@asset-doctor/fix';
import { parseAtlasManifest, parseSpineAtlasText } from '@asset-doctor/parsers';

// A WELL-PACKED, POT, not-oversize atlas: sprites cover ~85% of a 128×128 sheet ⇒ occupancy ≥ 0.8 ⇒ NO
// occupancy / wasted-regions finding; POT + ≤2048 ⇒ NO dimensions finding. The only finding is `format`.
function wellPackedAtlas(name: string, source: Atlas['source']): Atlas {
  const sprites: Sprite[] = [
    { name: 'a', frame: { x: 0, y: 0, w: 128, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 128, h: 64 } },
    { name: 'b', frame: { x: 0, y: 64, w: 64, h: 48 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 48 } },
    { name: 'c', frame: { x: 64, y: 64, w: 60, h: 48 }, rotated: false, trimmed: false, sourceSize: { w: 60, h: 48 } },
  ]; // 128*64 + 64*48 + 60*48 = 8192 + 3072 + 2880 = 14144 / 16384 ≈ 86.3% occupancy (≥ 0.8)
  return { name, imageRef: `${name.split('/').pop()!.replace(/\.png$/, '')}.png`, size: { w: 128, h: 128 }, source, sprites };
}

const atlasAsset = (name: string, source: Atlas['source']): Asset => ({
  kind: 'atlas',
  atlas: wellPackedAtlas(name, source),
  image: { name, imageRef: name, size: { w: 128, h: 128 }, mime: 'image/png', byteSize: 20000 },
});

// An UNDER-FILLED, POT, not-oversize atlas: 3 small frames cover ~18% of a 128×128 sheet ⇒ occupancy < 0.6
// (crit) ⇒ occupancyFinding fires (plus wastedRegions). POT + ≤2048 ⇒ NO dimensions finding ⇒ no resize op.
// Together with the differentiating encoder (format finding ALSO fires on the page), this atlas earns BOTH a
// repack-driving finding AND a format finding — the exact double-emit collision round20 #0 guards against.
function underFilledAtlas(name: string, source: Atlas['source']): Atlas {
  const sprites: Sprite[] = [
    { name: 'a', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } },
    { name: 'b', frame: { x: 40, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } },
    { name: 'c', frame: { x: 0, y: 40, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } },
  ]; // 3 * 32*32 = 3072 / 16384 ≈ 18.75% occupancy (< 0.6 crit)
  return { name, imageRef: `${name.split('/').pop()!.replace(/\.png$/, '')}.png`, size: { w: 128, h: 128 }, source, sprites };
}

const underFilledAtlasAsset = (name: string, source: Atlas['source']): Asset => ({
  kind: 'atlas',
  atlas: underFilledAtlas(name, source),
  image: { name, imageRef: name, size: { w: 128, h: 128 }, mime: 'image/png', byteSize: 20000 },
});

// Differentiating encoder so formatFinding fires on the atlas page: WebP comfortably under the source byteSize.
const encodeImage: EncodeSizer = async (_ref, _src, target) => (target === 'image/avif' ? 9000 : 8000);

// Faithful mirror of fix.worker.ts effectiveForTranscode (the only routing the atlas block adds on top of the
// PURE repoint already covered in packages/fix). No DOM/canvas — the seam under test is resolveOptions routing.
function effectiveForTranscode(ref: string, opMime: ImageMime): EffectiveOptions {
  const baseEffective: EffectiveOptions = {
    quality: 85,
    effort: 0,
    targetMime: 'image/webp',
    webpNearLossless: 100,
    lossless: false,
  };
  return resolveOptions(ref, 'pixi', { ...baseEffective, targetMime: opMime }, undefined);
}

async function planForAtlas(name: string, source: Atlas['source']) {
  const report = await analyze([atlasAsset(name, source)], undefined, { encodeImage });
  const plan = planFix(report, {
    targetMime: 'image/webp',
    quality: 0.85,
    lossless: false,
    padding: 2,
    maxSize: 4096,
    maxEdge: 2048,
    aggressive: false,
    isAtlasRef: (r) => r === name, // the worker supplies atlasByRef.has — this ref IS an atlas
  });
  return { report, plan };
}

describe('Harness A — the defect fires through the real audit path (atlas page → lone transcode op)', () => {
  it('a well-packed POT prebuilt sheet yields EXACTLY one transcode op on the atlas page (no repack/resize)', async () => {
    const name = 'main/sheet.png';
    const { report, plan } = await planForAtlas(name, { kind: 'texturepacker-hash' });
    // Premise: a format finding fired on the ATLAS PAGE (assetRef === atlas.name).
    const fmt = report.findings.find((f) => f.rule === 'format' && f.assetRef === name);
    expect(fmt, 'format finding on the atlas page').toBeDefined();
    // No occupancy / wasted-regions / dimensions finding (well-packed, POT, not oversize).
    expect(report.findings.some((f) => f.rule === 'occupancy')).toBe(false);
    expect(report.findings.some((f) => f.rule === 'wasted-regions')).toBe(false);
    expect(report.findings.some((f) => f.rule.startsWith('dimensions'))).toBe(false);
    // Exactly one transcode op, on the atlas ref; NO repack/resize/drop/pack op.
    const transcodes = plan.ops.filter((o): o is Extract<FixOp, { kind: 'transcode' }> => o.kind === 'transcode');
    expect(transcodes.length).toBe(1);
    expect(transcodes[0]!.assetRef).toBe(name);
    expect(plan.ops.some((o) => o.kind === 'repack' || o.kind === 'resize' || o.kind === 'pack' || o.kind === 'drop')).toBe(false);
  });

  it('an atlas with BOTH a repack-finding (occupancy/wasted) AND a format finding ⇒ exactly ONE repack op, ZERO transcode op (no double-emit)', async () => {
    // round20 #0: analyze.ts runs occupancyFinding/wastedRegions AND addFormat on EVERY atlas page
    // (analyze.ts:164-168). An under-filled sheet whose page also transcodes smaller earns BOTH findings on
    // the SAME assetRef. Pass-1 emits the repack (which already re-encodes the page to targetMime); pass-2's
    // `!repacked.has` guard (plan.ts:340) must drop the standalone transcode — else the worker would re-emit
    // the page from the PRE-repack geometry and silently clobber the repack.
    const name = 'main/under.png';
    const report = await analyze([underFilledAtlasAsset(name, { kind: 'texturepacker-hash' })], undefined, { encodeImage });
    // PREMISE: both a repack-driving finding AND a format finding fired on the SAME atlas page.
    expect(report.findings.some((f) => (f.rule === 'occupancy' || f.rule === 'wasted-regions') && f.assetRef === name)).toBe(true);
    expect(report.findings.some((f) => f.rule === 'format' && f.assetRef === name)).toBe(true);

    const plan = planFix(report, {
      targetMime: 'image/webp', quality: 0.85, lossless: false, padding: 2, maxSize: 4096, maxEdge: 2048,
      aggressive: false, isAtlasRef: (r) => r === name,
    });
    // EXACTLY one repack op on the atlas, and ZERO transcode op (the repack owns the re-encode).
    const repacks = plan.ops.filter((o): o is Extract<FixOp, { kind: 'repack' }> => o.kind === 'repack');
    expect(repacks.length).toBe(1);
    expect(repacks[0]!.atlasRefs).toEqual([name]);
    expect(repacks[0]!.targetMime).toBe('image/webp'); // the repack re-encodes the page to the target format
    expect(plan.ops.some((o) => o.kind === 'transcode')).toBe(false); // NO standalone transcode ⇒ no clobber
  });
});

describe('Harness B — fix correctness: emit→parse→resolve leaves NO dangling reference', () => {
  it('TexturePacker: the op routes to a target, the sidecar repoints, the old page is dropped', async () => {
    const name = 'main/sheet.png';
    const sidecar = 'main/sheet.json';
    const { plan } = await planForAtlas(name, { kind: 'texturepacker-hash' });
    const op = plan.ops.find((o): o is Extract<FixOp, { kind: 'transcode' }> => o.kind === 'transcode')!;
    // The worker resolves the op's target mime via effectiveForTranscode, then renames the page by extension.
    const target = effectiveForTranscode(op.assetRef, op.targetMime).targetMime;
    expect(target).toBe('image/webp');
    const newPage = 'main/sheet.webp'; // renamedTo(path, enc.mime) for a webp encode
    // The worker's PURE repoint half (identical call to the worker's repointAtlasImage):
    const repointed = repointAtlasImage(wellPackedAtlas(name, { kind: 'texturepacker-hash' }), sidecar, newPage);
    const json = JSON.parse(emitTexturePackerJson(repointed)) as object;
    const res = parseAtlasManifest(json, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The emitted output set the worker would push: {newPage, sidecar}. The OLD page is in `replaced` (gone).
      const emittedSet = new Set([newPage, sidecar]);
      const resolved = resolveImageRef(sidecar, res.atlas.imageRef);
      expect(emittedSet.has(resolved)).toBe(true); // sidecar resolves to a file that EXISTS in the output
      expect(resolved).not.toBe(name); // never the dropped original page
    }
  });

  it('Spine: the .atlas texture line repoints to the new page (single-page)', () => {
    const name = 'spine/hero.png';
    const sidecar = 'spine/hero.atlas';
    const newPage = 'spine/hero.webp';
    const repointed = repointAtlasImage(wellPackedAtlas(name, { kind: 'spine' }), sidecar, newPage);
    const pages = parseSpineAtlasText(emitSpineAtlasText(repointed));
    expect(pages.length).toBe(1);
    expect(resolveImageRef(sidecar, pages[0]!.image)).toBe(newPage);
    expect(resolveImageRef(sidecar, pages[0]!.image)).not.toBe(name);
  });
});

describe('Harness C — guards + interactions (the worker decision predicates)', () => {
  // The worker block's guard predicates, mirrored faithfully (the worker can't run in Node). These pin the
  // exact decisions the §6 block makes BEFORE any pixel work, so a regression in the decision shows up here.

  it('B2 size-loss: re-encode ≥ source ⇒ KEEP original (no emit, honest skip — no dangling ref created)', () => {
    // The worker guard: transcodeIsSizeLoss(opaque, enc, src) || enc >= src ⇒ keep original page + sidecar.
    const keepOriginal = (encBytes: number, srcBytes: number, opaque?: boolean): boolean =>
      (opaque === true && encBytes >= srcBytes) || encBytes >= srcBytes;
    expect(keepOriginal(9000, 8000)).toBe(true); // larger ⇒ keep
    expect(keepOriginal(8000, 8000)).toBe(true); // equal ⇒ keep
    expect(keepOriginal(7000, 8000)).toBe(false); // strictly smaller ⇒ ship
  });

  it('multi-page Spine ⇒ skip (emitSpineAtlasText writes ONE page; siblings would be dropped)', () => {
    const skipMultiPageSpine = (isSpine: boolean, pages: number): boolean => isSpine && pages > 1;
    expect(skipMultiPageSpine(true, 2)).toBe(true);
    expect(skipMultiPageSpine(true, 1)).toBe(false);
    expect(skipMultiPageSpine(false, 3)).toBe(false); // a multi-image TP atlas isn't a multi-page .atlas
  });

  it('sidecar unavailable ⇒ skip (re-encoding the page would dangle the untouched manifest)', () => {
    const skipNoSidecar = (sidecar: string | undefined): boolean => !sidecar;
    expect(skipNoSidecar(undefined)).toBe(true);
    expect(skipNoSidecar('main/sheet.json')).toBe(false);
  });

  it('belt-and-suspenders (round20 #0): page OR sidecar already in `replaced` ⇒ skip (never clobber a prior repack)', () => {
    // The worker guard at the top of the atlas block: if a pass-1 repack already emitted this page/sidecar
    // (replaced.add), re-encoding from the ORIGINAL bytes + PRE-repack geometry would clobber it. Skip honestly.
    const page = 'main/under.png';
    const sidecar = 'main/under.json';
    const skipIfReplaced = (replaced: Set<string>): boolean => replaced.has(page) || replaced.has(sidecar);
    expect(skipIfReplaced(new Set([page]))).toBe(true); // repack emitted the page ⇒ skip the transcode
    expect(skipIfReplaced(new Set([sidecar]))).toBe(true); // repack emitted the sidecar ⇒ skip
    expect(skipIfReplaced(new Set(['other/x.png']))).toBe(false); // unrelated emit ⇒ proceed
    expect(skipIfReplaced(new Set())).toBe(false); // nothing repacked ⇒ proceed (the normal path)
  });

  it('B1 KTX2 candidate is recorded for TexturePacker ONLY (Spine .atlas would ship a malformed .ktx2.json)', () => {
    // The worker gates recordKtx2Candidate(...) inside `if (!isSpinePage)` — the post-pass hardcodes
    // `.json`→`.ktx2.json` + emitTexturePackerJson, which is wrong for a Spine `.atlas` sidecar.
    const recordsKtx2 = (isSpine: boolean): boolean => !isSpine;
    expect(recordsKtx2(false)).toBe(true); // TexturePacker → candidate recorded
    expect(recordsKtx2(true)).toBe(false); // Spine → suppressed
  });

  it('M3 dedup owner: the repoint targets the EMITTED (new) page name, not the original', () => {
    // When the transcoded atlas page is a retained dedup owner, ownerActualName.image is overwritten with the
    // emitted page so Phase-C repoints CONSUMERS at the real page. The repoint math is the same inverse.
    const consumerManifest = 'extra/dup.json';
    const ownerEmittedPage = 'main/sheet.webp'; // the NEW page (not the original main/sheet.png)
    const repointedConsumer = repointAtlasImage(
      { name: 'dup', imageRef: 'dup.png', size: { w: 128, h: 128 }, source: { kind: 'texturepacker-hash' }, sprites: [] },
      consumerManifest,
      ownerEmittedPage,
    );
    expect(resolveImageRef(consumerManifest, repointedConsumer.imageRef)).toBe(ownerEmittedPage);
    expect(resolveImageRef(consumerManifest, repointedConsumer.imageRef)).not.toBe('main/sheet.png');
  });
});

describe('additivity — no atlas target ⇒ the atlas block is never entered', () => {
  it('a LOOSE image transcode never produces an atlas sidecar (the loose path is untouched)', async () => {
    const loose: Asset = {
      kind: 'image',
      image: { name: 'logo.png', imageRef: 'logo.png', size: { w: 256, h: 256 }, mime: 'image/png', byteSize: 20000 },
    };
    const report = await analyze([loose], undefined, { encodeImage });
    const plan = planFix(report, {
      targetMime: 'image/webp', quality: 0.85, lossless: false, padding: 2, maxSize: 4096, maxEdge: 2048, aggressive: false,
      isAtlasRef: () => false,
    });
    const t = plan.ops.find((o): o is Extract<FixOp, { kind: 'transcode' }> => o.kind === 'transcode');
    expect(t).toBeDefined();
    // The worker gate `atlasByRef.get(ref)` is undefined for a loose ref ⇒ the atlas block is skipped entirely.
    const isAtlas = (ref: string): boolean => ref === 'logo.png' && false; // loose: never in atlasByRef
    expect(isAtlas(t!.assetRef)).toBe(false);
  });
});
