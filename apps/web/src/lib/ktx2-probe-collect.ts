// Pure, Node-importable extraction of the fix worker's GPU-VRAM probe COLLECTION (round15 #0). The worker
// produces `.ktx2` pages but has no WebGL, so it retains a CAPPED set of produced page + raster pairs as
// FRESH slices (so the zip/`out` buffers stay intact — same discipline as captureSheetDiff) and transfers
// them on `fix-done` for the main-thread probe. The gate (KTX2_PROBE_MAX cap) and the fresh-slice copy are
// the load-bearing bits; pulling them here makes them unit-testable in Node (the worker has none of the
// OffscreenCanvas/WebGL/network it needs to run headless), so the cap + the copy-not-alias guarantee cannot
// silently regress. The worker imports BOTH of these so there is one source of truth.

import type { Ktx2ProbeInput } from '../worker/fix-protocol';

/** Cap on retained probe pairs (mirrors SHEET_DIFF_MAX) to bound the zero-copy transfer. The pages past the
 *  cap still contribute their worst-case VRAM ceiling — only the MEASURED probe is "N of M". */
export const KTX2_PROBE_MAX = 6;

/** Decide whether another probe pair fits under the cap. Pure predicate so the gate is testable. */
export function ktx2ProbeHasRoom(collected: number, max = KTX2_PROBE_MAX): boolean {
  return collected < max;
}

/** Build one probe pair from the produced `.ktx2` bytes + its raster source. CRITICAL: both buffers are
 *  FRESH SLICES (`.slice()`) so the copies the worker keeps in `out`/the zip stay intact when these are
 *  transferred zero-copy on `fix-done`. Aliasing the originals would detach the shipped page bytes. */
export function buildKtx2ProbeInput(ktx2Bytes: Uint8Array, rasterBytes: Uint8Array, rasterMime: string): Ktx2ProbeInput {
  return {
    ktx2Bytes: ktx2Bytes.slice().buffer,
    rasterBytes: rasterBytes.slice().buffer,
    rasterMime,
  };
}

/** Append a probe pair to `collected` IFF the cap allows it (no-op past the cap), returning whether it was
 *  added. Mutates `collected` in place — the worker holds the live array. Centralizes the gate + the
 *  fresh-slice build so neither can drift from the cap. */
export function collectKtx2Probe(
  collected: Ktx2ProbeInput[],
  ktx2Bytes: Uint8Array,
  rasterBytes: Uint8Array,
  rasterMime: string,
  max = KTX2_PROBE_MAX,
): boolean {
  if (!ktx2ProbeHasRoom(collected.length, max)) return false;
  collected.push(buildKtx2ProbeInput(ktx2Bytes, rasterBytes, rasterMime));
  return true;
}
