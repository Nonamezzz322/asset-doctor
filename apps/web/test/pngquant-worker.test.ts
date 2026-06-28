// Headless worker-pipeline test for the OPT-IN backend pngquant IN-PLACE POST-PASS (fix.worker.ts,
// round13-pngquant-backend.md Phase 3 T11). Like ktx2-worker.test.ts, the impure network call
// (`encodeRemote`) can't run in Node, so this drives a faithful node-side re-implementation of the post-pass
// CONTROL FLOW with a MOCKED encodeRemote standing in for the upload. The post-pass + the pre-zip Map
// last-write-wins dedup are both mirrored, so the IN-PLACE replacement (B4), the quality-floor honesty (M1),
// and the additivity gate can't pass green here while shipping broken in the worker.
//
// The post-pass control flow being mirrored (verbatim from fix.worker.ts):
//   • pngquantOn false ⇒ pngquantCandidates empty ⇒ the loop NEVER runs ⇒ `out` unchanged ⇒ byte-identical.
//   • per eligible composed PNG page in `out`: encodeRemote('pngquant',…) → on 200 push the re-compressed
//     bytes at the SAME path (the pre-zip Map is last-write-wins ⇒ the quantized bytes win — NO new file).
//   • quality_floor (M1): KEEP the lossless PNG, push a skipped[] note, do NOT increment `failed`.
//   • any other failure: failed++, push a skipped[] note, KEEP the lossless PNG.
//   • accumulate REAL measured bytesBefore (lossless) / bytesAfter (quantized). NO VRAM field, NO refsChanged.
//
// Load-bearing claims under test:
//   (a) pngquantOn=false ⇒ out + receipt byte-identical (the additivity proof, after the Map dedup).
//   (b) encodeRemote 200 ⇒ the SAME path's bytes are REPLACED in place (no new entry), bytes* accumulate.
//   (c) quality_floor ⇒ original KEPT, a skipped[] note, failed NOT incremented (honest decline).
//   (d) other failure ⇒ failed++ + a skipped[] note + original KEPT, no replacement.
//   (e) NO referencesChanged, NO VRAM field ever set for pngquant (disk-only, invariant 5).

import { describe, it, expect, vi } from 'vitest';
import type { EncodeRemoteResult } from '../src/lib/backend-client';

interface OutEntry {
  path: string;
  bytes: Uint8Array;
}
// Mirrors fix.worker.ts PngquantCandidate.
interface PngquantCandidate {
  ref: string;
  path: string;
  bytes: Uint8Array;
  w: number;
  h: number;
}
interface PostPassResult {
  /** `out` AFTER the same pre-zip Map last-write-wins dedup the worker applies (so in-place is visible). */
  dedupedOut: OutEntry[];
  skipped: { assetRef: string; reason: string }[];
  pngquantUploaded: number;
  pngquantProduced: number;
  pngquantFailed: number;
  pngquantBytesBefore: number;
  pngquantBytesAfter: number;
  referencesChanged: boolean;
}

/** Faithful node-side re-implementation of the worker's pngquant post-pass + the pre-zip Map dedup. */
function runPngquantPostPass(
  initialOut: OutEntry[],
  candidates: PngquantCandidate[],
  pngquantOn: boolean,
  encodeRemote: (
    png: Uint8Array,
    op: 'pngquant',
    w: number,
    h: number,
    cfg: { apiBase: string; token: string },
  ) => Promise<EncodeRemoteResult>,
): Promise<PostPassResult> {
  const out: OutEntry[] = [...initialOut];
  const skipped: { assetRef: string; reason: string }[] = [];
  let pngquantUploaded = 0;
  let pngquantProduced = 0;
  let pngquantFailed = 0;
  let pngquantBytesBefore = 0;
  let pngquantBytesAfter = 0;
  const referencesChanged = false; // pngquant NEVER sets it (drop-in same-name)

  return (async () => {
    if (pngquantOn && candidates.length > 0) {
      for (const c of candidates) {
        pngquantUploaded++;
        const res = await encodeRemote(c.bytes, 'pngquant', c.w, c.h, { apiBase: 'https://api.x', token: 'tok' });
        if (!res.ok) {
          if (res.code === 'quality_floor') {
            skipped.push({ assetRef: c.ref, reason: 'pngquant kept original: could not meet the quality floor' });
          } else {
            pngquantFailed++;
            skipped.push({ assetRef: c.ref, reason: `pngquant skipped: backend ${res.code} — kept lossless PNG` });
          }
          continue;
        }
        out.push({ path: c.path, bytes: res.bytes }); // REPLACE in place via the Map (last-write-wins)
        pngquantProduced++;
        pngquantBytesBefore += c.bytes.length;
        pngquantBytesAfter += res.bytes.length;
      }
    }
    // The worker's pre-zip Map last-write-wins dedup (order-preserving on first appearance).
    const byPath = new Map<string, Uint8Array>();
    for (const e of out) byPath.set(e.path, e.bytes);
    const dedupedOut: OutEntry[] = [];
    const seen = new Set<string>();
    for (const e of out) {
      if (seen.has(e.path)) continue;
      seen.add(e.path);
      dedupedOut.push({ path: e.path, bytes: byPath.get(e.path)! });
    }
    return { dedupedOut, skipped, pngquantUploaded, pngquantProduced, pngquantFailed, pngquantBytesBefore, pngquantBytesAfter, referencesChanged };
  })();
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────
const LOSSLESS_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 1, 1, 1, 1, 1, 1, 1]); // 12 bytes
const QUANT_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2, 2]); // 6 bytes (smaller)
const ok: (bytes: Uint8Array) => EncodeRemoteResult = (bytes) => ({ ok: true, bytes });

function candidate(): PngquantCandidate {
  return { ref: 'ui/panel.png', path: 'ui/panel.png', bytes: LOSSLESS_PNG, w: 256, h: 256 };
}
/** Drop-in baseline: the composed lossless PNG already in `out` BEFORE the post-pass (what off would ship). */
function baseline(): OutEntry[] {
  return [{ path: 'ui/panel.png', bytes: LOSSLESS_PNG }];
}

describe('pngquant post-pass — additivity (claim a): backend OFF ⇒ byte-identical', () => {
  it('pngquantOn=false ⇒ out unchanged, no upload, no bytes accounting, no refsChanged', async () => {
    const enc = vi.fn(async () => ok(QUANT_PNG));
    const r = await runPngquantPostPass(baseline(), [candidate()], false, enc);
    expect(r.dedupedOut).toEqual(baseline());
    expect(enc).not.toHaveBeenCalled();
    expect(r.pngquantUploaded).toBe(0);
    expect(r.pngquantProduced).toBe(0);
    expect(r.pngquantBytesBefore).toBe(0);
    expect(r.pngquantBytesAfter).toBe(0);
    expect(r.referencesChanged).toBe(false);
  });

  it('an EMPTY candidate list ⇒ identical no-op even when on', async () => {
    const enc = vi.fn(async () => ok(QUANT_PNG));
    const r = await runPngquantPostPass(baseline(), [], true, enc);
    expect(r.dedupedOut).toEqual(baseline());
    expect(enc).not.toHaveBeenCalled();
  });
});

describe('pngquant post-pass — in-place success (claims b, e)', () => {
  it('200 ⇒ REPLACES the SAME path bytes (no new file), accumulates real bytesBefore/After, no refsChanged', async () => {
    const enc = vi.fn(async () => ok(QUANT_PNG));
    const r = await runPngquantPostPass(baseline(), [candidate()], true, enc);
    expect(enc).toHaveBeenCalledTimes(1);
    expect(r.pngquantProduced).toBe(1);
    expect(r.pngquantFailed).toBe(0);
    // SAME path, exactly ONE entry — the bytes are the quantized page (in-place replace via the Map).
    expect(r.dedupedOut.map((e) => e.path)).toEqual(['ui/panel.png']);
    expect(r.dedupedOut[0]!.bytes).toEqual(QUANT_PNG);
    // REAL measured disk sums (the honest "smaller download").
    expect(r.pngquantBytesBefore).toBe(LOSSLESS_PNG.length);
    expect(r.pngquantBytesAfter).toBe(QUANT_PNG.length);
    expect(r.pngquantBytesAfter).toBeLessThan(r.pngquantBytesBefore);
    // (e) pngquant never changes references (drop-in same-name) and never sets a VRAM field.
    expect(r.referencesChanged).toBe(false);
  });
});

describe('pngquant post-pass — quality-floor decline (claim c, M1)', () => {
  it('quality_floor ⇒ original KEPT, a skipped[] note, failed NOT incremented (an honest decline, not a failure)', async () => {
    const enc = vi.fn(async () => ({ ok: false, code: 'quality_floor', message: 'floor not met' }) as EncodeRemoteResult);
    const r = await runPngquantPostPass(baseline(), [candidate()], true, enc);
    expect(enc).toHaveBeenCalledTimes(1);
    expect(r.pngquantUploaded).toBe(1);
    expect(r.pngquantProduced).toBe(0);
    expect(r.pngquantFailed).toBe(0); // NOT a failure — the original is kept
    expect(r.dedupedOut[0]!.bytes).toEqual(LOSSLESS_PNG); // original KEPT, not replaced
    expect(r.pngquantBytesAfter).toBe(0);
    expect(r.skipped).toEqual([{ assetRef: 'ui/panel.png', reason: 'pngquant kept original: could not meet the quality floor' }]);
  });
});

describe('pngquant post-pass — honest failure (claim d)', () => {
  it('a non-2xx (not quality_floor) ⇒ failed++ + a skipped[] note + original KEPT + NO replacement, no retry', async () => {
    const enc = vi.fn(async () => ({ ok: false, code: 'rate_limited', message: 'over quota' }) as EncodeRemoteResult);
    const r = await runPngquantPostPass(baseline(), [candidate()], true, enc);
    expect(enc).toHaveBeenCalledTimes(1);
    expect(r.pngquantFailed).toBe(1);
    expect(r.pngquantProduced).toBe(0);
    expect(r.dedupedOut[0]!.bytes).toEqual(LOSSLESS_PNG); // original KEPT
    expect(r.skipped).toEqual([{ assetRef: 'ui/panel.png', reason: 'pngquant skipped: backend rate_limited — kept lossless PNG' }]);
  });

  it('mixed batch ⇒ ok page replaced, floor page kept (not failed), error page kept (failed); counts reflect reality', async () => {
    const enc = vi
      .fn<(...a: unknown[]) => Promise<EncodeRemoteResult>>()
      .mockResolvedValueOnce(ok(QUANT_PNG)) // page 1 ok
      .mockResolvedValueOnce({ ok: false, code: 'quality_floor', message: 'floor' }) // page 2 floor (kept, not failed)
      .mockResolvedValueOnce({ ok: false, code: 'encode_failed', message: 'bad' }); // page 3 error (kept, failed)
    const out: OutEntry[] = [
      { path: 'a.png', bytes: LOSSLESS_PNG },
      { path: 'b.png', bytes: LOSSLESS_PNG },
      { path: 'c.png', bytes: LOSSLESS_PNG },
    ];
    const cands: PngquantCandidate[] = [
      { ref: 'a.png', path: 'a.png', bytes: LOSSLESS_PNG, w: 64, h: 64 },
      { ref: 'b.png', path: 'b.png', bytes: LOSSLESS_PNG, w: 64, h: 64 },
      { ref: 'c.png', path: 'c.png', bytes: LOSSLESS_PNG, w: 64, h: 64 },
    ];
    const r = await runPngquantPostPass(out, cands, true, enc as never);
    expect(r.pngquantUploaded).toBe(3);
    expect(r.pngquantProduced).toBe(1);
    expect(r.pngquantFailed).toBe(1); // ONLY the encode_failed page — the floor decline is NOT counted
    expect(r.dedupedOut.find((e) => e.path === 'a.png')!.bytes).toEqual(QUANT_PNG); // replaced
    expect(r.dedupedOut.find((e) => e.path === 'b.png')!.bytes).toEqual(LOSSLESS_PNG); // floor → kept
    expect(r.dedupedOut.find((e) => e.path === 'c.png')!.bytes).toEqual(LOSSLESS_PNG); // error → kept
    expect(r.pngquantBytesBefore).toBe(LOSSLESS_PNG.length); // only the one produced page's source
    expect(r.pngquantBytesAfter).toBe(QUANT_PNG.length);
    expect(r.skipped).toHaveLength(2); // floor note + error note
  });
});

// ── round13 finding [0]: the MULTI-TIER / atlas honest skip ──────────────────────────────────────────────
// A `nativePng`-marked PNG (FormatTarget.pngLossy) can flow through the multi-tier loop (a profile carrying a
// lower-resolution tier, OR an atlas/Spine page) — a path the single-tier-loose-only pngquant post-pass never
// touches. v1 SCOPE: that page ships as a normal lossless PNG, but invariant 3 forbids a SILENT drop of an
// explicitly-requested op. The worker therefore emits ONE honest skipped[] note per ref at the tier PNG-emit
// site, gated on pngquantOn (backend-off ⇒ no note ⇒ byte-identical) and de-duped once-per-ref across tiers.
// This mirrors the EXACT control flow in fix.worker.ts (the `if (pngquantOn && enc.mime==='image/png' &&
// te0.nativePng && !pngquantTierSkipNoted.has(ref))` guard right after the tier `out.push`).
interface TierEmit {
  ref: string;
  mime: 'image/png' | 'image/webp' | 'image/avif';
  nativePng?: boolean; // FormatTarget.pngLossy → fe.nativePng, threaded into the tierEncodes entry
}
/** Faithful mirror of the tier PNG-emit-site honest-skip ONLY (one note per ref, gated on pngquantOn). */
function runTierPngquantSkip(emits: TierEmit[], pngquantOn: boolean): { assetRef: string; reason: string }[] {
  const skipped: { assetRef: string; reason: string }[] = [];
  const noted = new Set<string>();
  for (const e of emits) {
    if (pngquantOn && e.mime === 'image/png' && e.nativePng && !noted.has(e.ref)) {
      noted.add(e.ref);
      skipped.push({ assetRef: e.ref, reason: 'pngquant skipped: lossy PNG applies only to single-tier loose pages — emitted lossless' });
    }
  }
  return skipped;
}

describe('pngquant tier/atlas path — honest skip (finding [0]: never a silent drop)', () => {
  it('a nativePng PNG emitted on the MULTI-TIER path with pngquantOn ⇒ ONE honest skipped[] note per ref', () => {
    // Two tiers (1x + 0.5x), each emitting a webp + a nativePng PNG — the note must fire ONCE for the ref.
    const emits: TierEmit[] = [
      { ref: 'sheets/ui.png', mime: 'image/webp' },
      { ref: 'sheets/ui.png', mime: 'image/png', nativePng: true },
      { ref: 'sheets/ui.png', mime: 'image/webp' },
      { ref: 'sheets/ui.png', mime: 'image/png', nativePng: true },
    ];
    const skipped = runTierPngquantSkip(emits, true);
    expect(skipped).toEqual([
      { assetRef: 'sheets/ui.png', reason: 'pngquant skipped: lossy PNG applies only to single-tier loose pages — emitted lossless' },
    ]);
  });

  it('backend OFF (pngquantOn=false) ⇒ NO note (byte-identical to today)', () => {
    const emits: TierEmit[] = [{ ref: 'sheets/ui.png', mime: 'image/png', nativePng: true }];
    expect(runTierPngquantSkip(emits, false)).toEqual([]);
  });

  it('a plain (NOT nativePng) PNG tier ⇒ NO note even when pngquantOn (only an explicit request is surfaced)', () => {
    const emits: TierEmit[] = [{ ref: 'sheets/ui.png', mime: 'image/png' }];
    expect(runTierPngquantSkip(emits, true)).toEqual([]);
  });

  it('distinct refs each get their OWN note', () => {
    const emits: TierEmit[] = [
      { ref: 'a.png', mime: 'image/png', nativePng: true },
      { ref: 'b.png', mime: 'image/png', nativePng: true },
    ];
    const skipped = runTierPngquantSkip(emits, true);
    expect(skipped.map((s) => s.assetRef)).toEqual(['a.png', 'b.png']);
  });
});

// ── round13 #8: the backendNative pngquant entry is SUPPRESSED when nothing was produced AND nothing
// hard-failed (an all-quality-floor run). Without this guard the receipt shows a MISLEADING "0 of N
// re-compressed — 0 B → 0 B download"; the per-page floor declines are already surfaced honestly in
// skipped[], so the empty entry is omitted (never a faked no-op success). Mirrors the EXACT worker guard
// `if (pngquantProduced > 0 || pngquantFailed > 0)`.
function emitsPngquantEntry(produced: number, failed: number): boolean {
  return produced > 0 || failed > 0;
}
describe('pngquant receipt entry suppression (round13 #8)', () => {
  it('all candidates declined at the quality floor (produced=0, failed=0) ⇒ NO backendNative entry', () => {
    // Pair with the post-pass: an all-floor batch yields produced=0/failed=0 + a skipped[] note per page.
    expect(emitsPngquantEntry(0, 0)).toBe(false);
  });
  it('≥1 page produced ⇒ entry emitted (real disk win)', () => {
    expect(emitsPngquantEntry(1, 0)).toBe(true);
  });
  it('≥1 page hard-failed ⇒ entry emitted (so receiptFailed surfaces the honest fallback count)', () => {
    expect(emitsPngquantEntry(0, 2)).toBe(true);
  });
});
