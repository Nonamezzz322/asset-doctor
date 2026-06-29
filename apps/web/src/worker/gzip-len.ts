// PURE, Node-testable helper for the fix worker's gzip file-size mode (round23 #2, includeFileSizes='gzip').
// The worker can't run in Node (it references `self`/OffscreenCanvas), so this primitive is factored OUT here
// and imported verbatim by fix.worker.ts — the same discipline as transcode-guard.ts / sheet-diff.ts.
// CompressionStream is a standard Worker AND Node-20 global, so this is directly unit-testable (real API, not
// mocked).

/** Gzip-compressed byte length of `bytes` via the standard CompressionStream API (round23 #2). NO network, NO
 *  native lib, NO backend — a browser/Worker primitive (invariant 1). Returns the REAL compressed length (the
 *  manifest's progressSize = this /1024), matching an HTTP gzip transport. Pure size, no IO. The gzip stream
 *  length is platform-stable for identical input (fixed zlib level/dictionary); golden tests assert raw exactly
 *  and gzip only as a bound (≤ raw for compressible input, >0).
 *
 *  Round 24: empty input ⇒ 0, the SAME class as the manifest's missing⇒0 rule — an empty file has no
 *  transported bytes, so reporting the ~20-byte gzip frame overhead would overstate it. Guard runs BEFORE the
 *  stream so an empty `bytes` can't surface the framing as a phantom size. */
export async function gzipLen(bytes: Uint8Array): Promise<number> {
  if (bytes.length === 0) return 0; // honest 0, not the gzip frame overhead (same class as missing⇒0)
  // Copy into a fresh ArrayBuffer-backed view so the Blob/Response sees plain bytes (no SharedArrayBuffer issue).
  const cs = new CompressionStream('gzip');
  const compressed = await new Response(new Response(bytes.slice()).body!.pipeThrough(cs)).arrayBuffer();
  return compressed.byteLength;
}
