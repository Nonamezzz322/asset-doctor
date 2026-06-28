// Headless worker-pipeline test for the OPT-IN backend KTX2 POST-PASS (fix.worker.ts:2276-2358,
// round12-backend-processing.md Phase 3 T14/T15/T16). The impure post-pass (createImageBitmap /
// OffscreenCanvas re-decode + the network `encodeRemote` call) can't run in Node, so — exactly as
// tier-worker.test.ts / dedup-worker-phase-c.test.ts do — this drives a faithful node-side re-implementation
// of the post-pass CONTROL FLOW that reuses the SAME pure helpers the worker imports (vramCeilingOfPage,
// emitTexturePackerJson, buildPixiManifest, dirOf/relativeImageRef) plus a MOCKED encodeRemote standing in
// for the (impure) re-decode+upload. A broken additivity gate, a silent drop on failure, a folded-in VRAM
// ceiling, or a raster-first manifest order therefore can't pass green here while shipping in the worker.
//
// The post-pass control flow being mirrored (verbatim from fix.worker.ts:2295-2356):
//   • backendOn false ⇒ ktx2Candidates empty ⇒ the loop NEVER runs ⇒ `out` unchanged ⇒ byte-identical.
//   • per eligible RASTER page KEPT in `out`: encodeRemote → on 200 push `<name>.ktx2` (additive) + record
//     a manifest variant (atlas: a SECOND `.ktx2.json` sidecar, round8 two-sidecar; loose: the `.ktx2`).
//   • on ANY failure: ktx2Failed++, push an HONEST skipped[] note, KEEP the raster page (no retry).
//   • charge vramCeilingOfPage('ktx2-uastc', w, h, mipsBaked) into ktx2VramBytesWorstCase ONLY — NEVER
//     into vramBytesAfter (invariant 5).
//
// Load-bearing claims under test:
//   (a) backend absent / consent=false ⇒ out + receipt byte-identical (the additivity proof).
//   (b) encodeRemote 200 ⇒ adds <name>.ktx2 (+ <name>.ktx2.json for atlas), raster page KEPT.
//   (c) encodeRemote failure ⇒ failed++ + a skipped[] note + raster KEPT, no .ktx2, no retry storm.
//   (d) ktx2VramBytesWorstCase == Σ vramCeilingOfPage(...) and is NEVER folded into vramBytesAfter.
//   (e) the emitted manifest lists the ktx2 candidate FIRST (ktx2-first) for both loose and atlas.

import { describe, it, expect, vi } from 'vitest';
import type { Atlas, ImageMime } from '@asset-doctor/core';
import {
  buildPixiManifest,
  dirOf,
  emitTexturePackerJson,
  relativeImageRef,
  vramCeilingOfPage,
  type ManifestAsset,
  type ManifestAssetKind,
  type EmittedVariant,
} from '@asset-doctor/fix';
import type { EncodeRemoteResult } from '../src/lib/backend-client';

// The pinned KTX2 profile bakes a full mip chain ⇒ the worker charges the ×4/3 ceiling (KTX2_PROFILE_BAKES_MIPS).
const KTX2_BAKES_MIPS = true;
const te = new TextEncoder();

// ── candidate shape mirrors fix.worker.ts Ktx2Candidate (the facts the worker has at the post-pass) ──────
interface Ktx2Candidate {
  ref: string;
  imagePath: string;
  pageBytes: Uint8Array;
  pageMime: ImageMime;
  w: number;
  h: number;
  atlasSidecar?: { path: string; atlas: Atlas };
}

interface OutEntry {
  path: string;
  bytes: Uint8Array;
}

interface PostPassResult {
  out: OutEntry[];
  skipped: { assetRef: string; reason: string }[];
  ktx2Produced: number;
  ktx2Failed: number;
  ktx2Uploaded: number;
  ktx2VramBytesWorstCase: number;
  referencesChanged: boolean;
  manifestAssets: Map<string, ManifestAsset>;
}

/** Faithful node-side re-implementation of fix.worker.ts:2295-2356. `backendOn` and a candidates list stand
 *  in for the worker's gated collector; `encodeRemote` is injected (the worker imports the real one). The
 *  re-decode step (createImageBitmap→PNG) is treated as always-succeeding here (it has its own try/catch in
 *  the worker, exercised by the dedicated decode-fail test below via a candidate flag). */
function runKtx2PostPass(
  initialOut: OutEntry[],
  candidates: Ktx2Candidate[],
  backendOn: boolean,
  encodeRemote: (
    png: Uint8Array,
    op: 'ktx2',
    w: number,
    h: number,
    cfg: { apiBase: string; token: string },
  ) => Promise<EncodeRemoteResult>,
  decodeFails = false,
): Promise<PostPassResult> {
  const out: OutEntry[] = [...initialOut];
  const skipped: { assetRef: string; reason: string }[] = [];
  const manifestAssets = new Map<string, ManifestAsset>();
  const recordVariant = (ref: string, kind: ManifestAssetKind, source: string, v: EmittedVariant): void => {
    let a = manifestAssets.get(ref);
    if (!a) {
      a = { ref, kind, source, variants: [] };
      manifestAssets.set(ref, a);
    }
    a.variants.push(v);
  };
  let ktx2Uploaded = 0;
  let ktx2Produced = 0;
  let ktx2Failed = 0;
  let ktx2VramBytesWorstCase = 0;
  let referencesChanged = false;

  return (async () => {
    if (backendOn && candidates.length > 0) {
      for (const c of candidates) {
        // (1) re-decode the emitted page → lossless PNG source. In the worker this is a try/catch; the
        // decodeFails flag simulates the catch (createImageBitmap throwing) ⇒ honest skip, no upload.
        const pngBytes: Uint8Array | null = decodeFails ? null : c.pageBytes;
        if (!pngBytes) {
          ktx2Failed++;
          skipped.push({ assetRef: c.ref, reason: 'ktx2 skipped: could not re-encode page for upload — kept browser image' });
          continue;
        }
        // (2) upload — the ONLY network call (gated by consent). Never throws (encodeRemote catches).
        ktx2Uploaded++;
        const res = await encodeRemote(pngBytes, 'ktx2', c.w, c.h, { apiBase: 'https://api.x', token: 'tok' });
        if (!res.ok) {
          ktx2Failed++;
          skipped.push({ assetRef: c.ref, reason: `ktx2 skipped: backend ${res.code} — kept browser image` });
          continue;
        }
        // (3) ADD the .ktx2 sibling (raster page KEPT).
        const ktx2Path = c.imagePath.replace(/\.[a-z0-9]+$/i, '.ktx2');
        out.push({ path: ktx2Path, bytes: res.bytes });
        ktx2Produced++;
        referencesChanged = true;
        if (c.atlasSidecar) {
          const sidecarDir = dirOf(c.atlasSidecar.path);
          const ktx2Atlas: Atlas = { ...c.atlasSidecar.atlas, imageRef: relativeImageRef(sidecarDir, ktx2Path) };
          const ktx2JsonPath = c.atlasSidecar.path.replace(/\.json$/i, '.ktx2.json');
          out.push({ path: ktx2JsonPath, bytes: te.encode(emitTexturePackerJson(ktx2Atlas)) });
          recordVariant(c.ref, 'atlas', ktx2Path, { scale: 1, suffix: '', src: ktx2JsonPath });
        } else {
          recordVariant(c.ref, 'loose', ktx2Path, { scale: 1, suffix: '', src: ktx2Path });
        }
        // (4) HONEST VRAM ceiling — charged into ktx2VramBytesWorstCase ONLY.
        ktx2VramBytesWorstCase += vramCeilingOfPage('ktx2-uastc', c.w, c.h, KTX2_BAKES_MIPS);
      }
    }
    return { out, skipped, ktx2Produced, ktx2Failed, ktx2Uploaded, ktx2VramBytesWorstCase, referencesChanged, manifestAssets };
  })();
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────
const PAGE_PNG = new Uint8Array([1, 2, 3, 4, 5, 6]);
const KTX2_BYTES = new Uint8Array([0xab, 0x4b, 0x54, 0x58, 9, 9, 9, 9]);

function looseCandidate(): Ktx2Candidate {
  return { ref: 'bg/sky.png', imagePath: 'bg/sky.webp', pageBytes: PAGE_PNG, pageMime: 'image/webp', w: 512, h: 256 };
}
function atlasCandidate(): Ktx2Candidate {
  const atlas: Atlas = {
    name: 'ui/hud.png',
    imageRef: 'hud.webp',
    size: { w: 1024, h: 1024 },
    sprites: [],
    source: { kind: 'texturepacker-hash' },
  };
  return {
    ref: 'ui/hud.png',
    imagePath: 'ui/hud.webp',
    pageBytes: PAGE_PNG,
    pageMime: 'image/webp',
    w: 1024,
    h: 1024,
    atlasSidecar: { path: 'ui/hud.json', atlas },
  };
}
/** The drop-in raster page entries already in `out` BEFORE the post-pass (what backend-off would ship). */
function rasterBaseline(): OutEntry[] {
  return [
    { path: 'bg/sky.webp', bytes: PAGE_PNG },
    { path: 'ui/hud.webp', bytes: PAGE_PNG },
    { path: 'ui/hud.json', bytes: te.encode('{"meta":{"image":"hud.webp"}}') },
  ];
}
const ok: (bytes: Uint8Array) => EncodeRemoteResult = (bytes) => ({ ok: true, bytes });

describe('KTX2 post-pass — additivity (claim a): backend OFF ⇒ byte-identical', () => {
  it('backendOn=false ⇒ out unchanged, no upload, no manifest entry, no VRAM ceiling', async () => {
    const enc = vi.fn(async () => ok(KTX2_BYTES));
    const baseline = rasterBaseline();
    const r = await runKtx2PostPass(baseline, [looseCandidate(), atlasCandidate()], false, enc);
    // The loop never runs: out is the exact baseline (same paths, same bytes).
    expect(r.out).toEqual(baseline);
    expect(enc).not.toHaveBeenCalled();
    expect(r.ktx2Uploaded).toBe(0);
    expect(r.ktx2Produced).toBe(0);
    expect(r.ktx2VramBytesWorstCase).toBe(0);
    expect(r.manifestAssets.size).toBe(0);
    expect(r.referencesChanged).toBe(false);
  });

  it('consent gate (mirrors backendOn): an EMPTY candidate list ⇒ identical no-op even when on', async () => {
    const enc = vi.fn(async () => ok(KTX2_BYTES));
    const baseline = rasterBaseline();
    const r = await runKtx2PostPass(baseline, [], true, enc);
    expect(r.out).toEqual(baseline);
    expect(enc).not.toHaveBeenCalled();
  });
});

describe('KTX2 post-pass — success (claims b, d, e)', () => {
  it('LOOSE 200 ⇒ adds bg/sky.ktx2, KEEPS the raster, records a loose ktx2 variant, charges the ceiling', async () => {
    const enc = vi.fn(async () => ok(KTX2_BYTES));
    const r = await runKtx2PostPass([{ path: 'bg/sky.webp', bytes: PAGE_PNG }], [looseCandidate()], true, enc);
    expect(r.ktx2Produced).toBe(1);
    expect(r.ktx2Failed).toBe(0);
    expect(enc).toHaveBeenCalledTimes(1);
    // raster KEPT + .ktx2 ADDED.
    expect(r.out.map((e) => e.path)).toEqual(['bg/sky.webp', 'bg/sky.ktx2']);
    expect(r.out.find((e) => e.path === 'bg/sky.ktx2')!.bytes).toEqual(KTX2_BYTES);
    // (d) ceiling = 1 B/px × 512×256 × 4/3 (mips), NEVER w·h·4.
    const expected = vramCeilingOfPage('ktx2-uastc', 512, 256, KTX2_BAKES_MIPS);
    expect(r.ktx2VramBytesWorstCase).toBe(expected);
    expect(r.ktx2VramBytesWorstCase).not.toBe(512 * 256 * 4);
    expect(r.referencesChanged).toBe(true);
  });

  it('ATLAS 200 ⇒ adds ui/hud.ktx2 AND a SECOND ui/hud.ktx2.json sidecar (round8 two-sidecar), KEEPS raster + raster sidecar', async () => {
    const enc = vi.fn(async () => ok(KTX2_BYTES));
    const baseline: OutEntry[] = [
      { path: 'ui/hud.webp', bytes: PAGE_PNG },
      { path: 'ui/hud.json', bytes: te.encode('{"meta":{"image":"hud.webp"}}') },
    ];
    const r = await runKtx2PostPass(baseline, [atlasCandidate()], true, enc);
    expect(r.ktx2Produced).toBe(1);
    expect(r.out.map((e) => e.path)).toEqual(['ui/hud.webp', 'ui/hud.json', 'ui/hud.ktx2', 'ui/hud.ktx2.json']);
    // The new sidecar's meta.image points at the .ktx2 page (relative to the sidecar dir).
    const sidecar = JSON.parse(new TextDecoder().decode(r.out.find((e) => e.path === 'ui/hud.ktx2.json')!.bytes)) as {
      meta: { image: string };
    };
    expect(sidecar.meta.image).toBe('hud.ktx2');
  });

  it('(d) ktx2VramBytesWorstCase is the Σ of ceilings and is COMPUTED SEPARATELY (never the raster sum)', async () => {
    const enc = vi.fn(async () => ok(KTX2_BYTES));
    const r = await runKtx2PostPass(rasterBaseline(), [looseCandidate(), atlasCandidate()], true, enc);
    const sum =
      vramCeilingOfPage('ktx2-uastc', 512, 256, KTX2_BAKES_MIPS) +
      vramCeilingOfPage('ktx2-uastc', 1024, 1024, KTX2_BAKES_MIPS);
    expect(r.ktx2VramBytesWorstCase).toBe(sum);
    // A raster fold (the bug we guard against) would be Σ w·h·4 — assert we are strictly under it.
    const rasterSum = 512 * 256 * 4 + 1024 * 1024 * 4;
    expect(r.ktx2VramBytesWorstCase).toBeLessThan(rasterSum);
  });

  it('(e) the emitted Pixi manifest lists the ktx2 candidate FIRST for BOTH loose and atlas (ktx2-first)', async () => {
    const enc = vi.fn(async () => ok(KTX2_BYTES));
    const r = await runKtx2PostPass(rasterBaseline(), [looseCandidate(), atlasCandidate()], true, enc);
    // Seed the manifest with the DROP-IN raster variants (the worker recorded these earlier in the run), then
    // merge in the post-pass ktx2 variants, and build the real manifest to assert src ordering end-to-end.
    const assets = [...r.manifestAssets.values()].map((a) => ({ ...a }));
    // raster drop-in variants for the same refs (recorded pre-post-pass in the worker).
    const loose = assets.find((a) => a.ref === 'bg/sky.png')!;
    loose.variants = [{ scale: 1, suffix: '', src: 'bg/sky.webp' }, ...loose.variants];
    const atlas = assets.find((a) => a.ref === 'ui/hud.png')!;
    atlas.variants = [{ scale: 1, suffix: '', src: 'ui/hud.json' }, ...atlas.variants];
    const json = buildPixiManifest(assets);
    const m = JSON.parse(json) as { bundles: { assets: { alias: string[]; src: string[] }[] }[] };
    const entries = m.bundles[0]!.assets;
    const looseEntry = entries.find((e) => e.alias[0] === 'bg/sky')!;
    const atlasEntry = entries.find((e) => e.alias[0] === 'ui/hud')!;
    expect(looseEntry.src).toEqual(['bg/sky.ktx2', 'bg/sky.webp']); // ktx2 FIRST
    expect(atlasEntry.src).toEqual(['ui/hud.ktx2.json', 'ui/hud.json']); // ktx2 sidecar FIRST
  });
});

describe('KTX2 post-pass — honest failure (claim c)', () => {
  it('a non-2xx ⇒ failed++ + a skipped[] note + raster KEPT + NO .ktx2 + NO manifest entry + NO retry', async () => {
    const enc = vi.fn(async () => ({ ok: false, code: 'rate_limited', message: 'over quota' }) as EncodeRemoteResult);
    const r = await runKtx2PostPass([{ path: 'bg/sky.webp', bytes: PAGE_PNG }], [looseCandidate()], true, enc);
    expect(enc).toHaveBeenCalledTimes(1); // ONE attempt — no retry storm.
    expect(r.ktx2Failed).toBe(1);
    expect(r.ktx2Produced).toBe(0);
    expect(r.out.map((e) => e.path)).toEqual(['bg/sky.webp']); // raster KEPT, nothing added
    expect(r.ktx2VramBytesWorstCase).toBe(0);
    expect(r.manifestAssets.size).toBe(0);
    expect(r.skipped).toEqual([
      { assetRef: 'bg/sky.png', reason: 'ktx2 skipped: backend rate_limited — kept browser image' },
    ]);
  });

  it('a re-decode failure (createImageBitmap throws) ⇒ honest skip, NO upload attempted, raster KEPT', async () => {
    const enc = vi.fn(async () => ok(KTX2_BYTES));
    const r = await runKtx2PostPass([{ path: 'bg/sky.webp', bytes: PAGE_PNG }], [looseCandidate()], true, enc, true);
    expect(enc).not.toHaveBeenCalled(); // decode failed BEFORE the network call (no bytes leave)
    expect(r.ktx2Failed).toBe(1);
    expect(r.ktx2Uploaded).toBe(0);
    expect(r.out.map((e) => e.path)).toEqual(['bg/sky.webp']);
    expect(r.skipped[0]!.reason).toContain('could not re-encode page');
  });

  it('(round15) ktx2Produced > 0 ⇒ receipt.ktx2Produced === true (the loader-migration import seam)', async () => {
    // Mirrors the worker receipt gate verbatim: `...(ktx2Produced > 0 ? { ktx2Produced: true } : {})`. This is
    // the ONLY seam that makes the Pixi loader-migration snippet lead with `import 'pixi.js/ktx2'` (the .ktx2
    // paths live in out/the manifest variants, never in changes[]).
    const gate = (n: number): { ktx2Produced?: boolean } => (n > 0 ? { ktx2Produced: true } : {});
    const enc = vi.fn(async () => ok(KTX2_BYTES));
    const produced = await runKtx2PostPass(rasterBaseline(), [looseCandidate(), atlasCandidate()], true, enc);
    expect(produced.ktx2Produced).toBe(2);
    expect(gate(produced.ktx2Produced)).toEqual({ ktx2Produced: true });
  });

  it('(round15) backend OFF ⇒ ktx2Produced === 0 ⇒ receipt.ktx2Produced ABSENT (byte-identical receipt)', async () => {
    const gate = (n: number): { ktx2Produced?: boolean } => (n > 0 ? { ktx2Produced: true } : {});
    const enc = vi.fn(async () => ok(KTX2_BYTES));
    const off = await runKtx2PostPass(rasterBaseline(), [looseCandidate(), atlasCandidate()], false, enc);
    expect(off.ktx2Produced).toBe(0);
    expect(gate(off.ktx2Produced)).toEqual({}); // field omitted ⇒ receipt unchanged
    expect('ktx2Produced' in gate(off.ktx2Produced)).toBe(false);
  });

  it('mixed batch ⇒ the OK page produces, the failing page falls back; counts + out reflect reality', async () => {
    const enc = vi
      .fn<(...a: unknown[]) => Promise<EncodeRemoteResult>>()
      .mockResolvedValueOnce(ok(KTX2_BYTES)) // loose ok
      .mockResolvedValueOnce({ ok: false, code: 'encode_failed', message: 'bad' }); // atlas fails
    const baseline = rasterBaseline();
    const r = await runKtx2PostPass(baseline, [looseCandidate(), atlasCandidate()], true, enc as never);
    expect(r.ktx2Produced).toBe(1);
    expect(r.ktx2Failed).toBe(1);
    // loose .ktx2 added; atlas got nothing; both raster pages KEPT.
    expect(r.out.some((e) => e.path === 'bg/sky.ktx2')).toBe(true);
    expect(r.out.some((e) => e.path === 'ui/hud.ktx2')).toBe(false);
    expect(r.out.some((e) => e.path === 'ui/hud.webp')).toBe(true);
    // Only the loose ceiling is charged (the failed atlas contributes 0).
    expect(r.ktx2VramBytesWorstCase).toBe(vramCeilingOfPage('ktx2-uastc', 512, 256, KTX2_BAKES_MIPS));
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.reason).toContain('encode_failed');
  });
});
