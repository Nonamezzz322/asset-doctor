// Host side of MEASURE-REAL-KTX2-VRAM (docs/improvements/round15-probe-the-produced-ktx2-measure-real-gpu.md).
// The fix worker produces the `.ktx2` pages but has NO WebGL, so it transfers each page + its raster source
// on `fix-done` (Ktx2ProbeInput[]). Here, on the MAIN thread, we transcode each `.ktx2` through a real
// offscreen-WebGL render (probeKtx2) and read the ACTUAL resident compressed bytes — turning the one
// ESTIMATED GPU-VRAM headline (ktx2VramBytesWorstCase) into a MEASURED fact, shown BESIDE the ceiling.
//
// INVARIANTS this file upholds:
//  - DEVICE-LOCAL honesty (inv. 3 & 5): the measured number is "on YOUR GPU this run" — the GPU's chosen
//    transcode target AND whether the transcoder loaded both move it. It is attached as the SEPARATE
//    `probedKtx2*` fields, NEVER folded into vramBytesAfter nor asserted across devices.
//  - Additive & non-destructive: no inputs / no WebGL / abort ⇒ the SAME receipt reference is returned
//    unchanged (byte-identical to today). The probe is NEVER load-bearing — a per-page failure is swallowed.
//  - NO NETWORK (inv. 1, CORRECTION-1): probeKtx2 is pointed at the SELF-HOSTED transcoder (libktx.js/.wasm
//    copied into public/transcoders/ktx/ by scripts/copy-ktx-transcoder.mjs) via same-origin URLs resolved
//    against import.meta.env.BASE_URL — so the Pixi KTX2 loader NEVER hits its jsdelivr default.
//  - Browser-only & feature-detected: reuses webglAvailable() (probe-run.ts); bails silently when missing.

import type { FixReceipt } from '../worker/fix-protocol';
import type { Ktx2ProbeInput } from '../worker/fix-protocol';
import type { Ktx2TranscoderPaths } from '@asset-doctor/probe';
import { probeKtx2 } from '@asset-doctor/probe';
import { webglAvailable } from './probe-run';

/** Same-origin URLs of the self-hosted Pixi KTX2 transcoder (T4a / CORRECTION-1). Resolved against the
 *  Vite base (`/` in dev, `./`-derived under the GitHub Pages subpath) so the loader fetches them from THIS
 *  origin, never jsdelivr. The files are placed by scripts/copy-ktx-transcoder.mjs (predev/prebuild). */
function localTranscoderPaths(): Ktx2TranscoderPaths {
  // BASE_URL ends with '/'; for the build base './' new URL() resolves it relative to the document.
  const base = import.meta.env.BASE_URL ?? '/';
  const abs = (p: string): string => new URL(`${base}transcoders/ktx/${p}`, document.baseURI).href;
  return { jsUrl: abs('libktx.js'), wasmUrl: abs('libktx.wasm') };
}

/**
 * Probe the produced `.ktx2` pages and return a NEW receipt carrying the measured `probedKtx2*` fields.
 * Returns the SAME receipt reference (no change) when there are no inputs, WebGL is unavailable, or the
 * caller aborted — keeping the off path byte-identical to today.
 *
 * @param receipt the worker's receipt (untouched on the no-op paths).
 * @param inputs  the transferred `.ktx2` + raster pages (empty ⇒ same-reference return).
 * @param signal  optional abort: a fresh fix run can cancel a stale probe (the worker is also terminated).
 */
export async function attachKtx2Probe(
  receipt: FixReceipt,
  inputs: Ktx2ProbeInput[],
  signal?: AbortSignal,
): Promise<FixReceipt> {
  if (inputs.length === 0 || !webglAvailable() || signal?.aborted) return receipt;

  const transcoder = localTranscoderPaths();
  let compressedBytes = 0;
  let rasterBaselineBytes = 0;
  let fallback = false;
  let probed = 0;

  // Sequential (await-in-loop) on purpose: each probeKtx2 destroys its Pixi app, freeing the GL context
  // between runs (same live-context-cap reasoning as attachProbeReadings).
  for (const input of inputs) {
    if (signal?.aborted) break;
    let bmp: ImageBitmap | undefined;
    try {
      bmp = await createImageBitmap(new Blob([input.rasterBytes], { type: input.rasterMime }));
      const reading = await probeKtx2(input.ktx2Bytes, bmp, transcoder, signal);
      compressedBytes += reading.compressedBytes;
      rasterBaselineBytes += reading.rasterBaselineBytes;
      fallback = fallback || reading.fallback;
      probed++;
    } catch {
      // A per-page probe/decode failure is swallowed — the probe is NEVER load-bearing. The remaining
      // pages still contribute, and on zero successes we fall through to the same-reference return.
    } finally {
      bmp?.close();
    }
  }

  if (probed === 0 || signal?.aborted) return receipt;

  // Build a NEW receipt: the three MEASURED, DEVICE-LOCAL fields attached BESIDE the existing ceiling.
  // Pure integer sums (commutative — iteration order is not load-bearing).
  return {
    ...receipt,
    probedKtx2VramBytes: compressedBytes,
    probedKtx2RasterBaselineBytes: rasterBaselineBytes,
    probedKtx2Fallback: fallback,
  };
}
