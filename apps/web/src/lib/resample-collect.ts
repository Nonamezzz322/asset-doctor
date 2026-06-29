// Pure, Node-importable gate + candidate builder for the OPT-IN libvips lanczos3 resample tier post-pass
// (round24-libvips-lanczos3-resample-op-sidecar.md). The worker has no Node runtime (it needs
// OffscreenCanvas/createImageBitmap/fetch), so the LOAD-BEARING control-flow predicate is extracted here and
// unit-tested directly in Node — exactly the discipline of ktx2-probe-collect.ts. The worker imports
// `resampleOn` so the gate can't silently regress.
//
// SAFETY (load-bearing, invariants 1 & 2): the resample path is LIVE only when the user configured a backend
// AND ticked per-run consent AND opted the `resample` op in AND a host+token exist — the SAME opt-in shape as
// the KTX2/pngquant gates. Off/declined ⇒ `resampleOn` is false ⇒ no candidate is ever collected ⇒ the tier
// post-pass never runs ⇒ the existing OffscreenCanvas tier downscale's output is BYTE-IDENTICAL to today.
//
// B1 CACHE-BUSTING INTEGRITY (load-bearing, the central skeptic blocker): when `hashFilenames` is ON, the
// per-tier image filename embeds shortHash(browserDownscaledBytes) and every referrer (manifest meta.image /
// Pixi recordVariant src / loader-migration rows) points at THAT hashed name. Replacing the tile bytes
// in-place would leave the hash describing the OLD (browser) bytes — a content/hash mismatch that defeats
// round9 cache-busting. v1 takes the SIMPLER approach the design accepts: GATE resample OFF when
// hashFilenames is on (with an honest skip note surfaced in the worker), rather than re-thread the
// cache-bust chain through a post-pass. So `resampleOn` is FALSE when hashFilenames is on — captured in this
// pure predicate so the interaction is unit-tested and can't drift.

/** The fields of FixOptions the resample gate reads. A structural subtype so this stays Node-pure (no
 *  worker/DOM imports) and the predicate is testable with a plain object. */
export interface ResampleGateOptions {
  backend?: {
    apiBase: string;
    token: string;
    ops: readonly string[];
    consent: boolean;
  };
  /** B1: content-hash cache-busting. When TRUE the resample post-pass is GATED OFF in v1 (see header). */
  hashFilenames?: boolean;
}

/** TRUE iff the resample tier post-pass may run this run. Mirrors the KTX2/pngquant gate shape (backend
 *  present + consent + op opted-in + host/token non-empty) AND additionally requires `hashFilenames` to be
 *  OFF (B1 — an in-place tile replace under content-hash names would break round9; v1 gates off rather than
 *  re-hashing). Pure + total so the worker's `resampleOn` can't drift from the documented gate. */
export function resampleOn(opts: ResampleGateOptions): boolean {
  const b = opts.backend;
  if (b == null) return false;
  if (b.consent !== true) return false;
  if (!b.ops.includes('resample')) return false;
  if (b.apiBase.trim() === '') return false;
  if (b.token.trim() === '') return false;
  // B1: content-hash cache-busting interaction — gate OFF (honest skip in the worker), never in-place replace.
  if (opts.hashFilenames === true) return false;
  return true;
}

/** TRUE iff resample WOULD be eligible by the backend opt-in but is being SUPPRESSED solely by the
 *  `hashFilenames` interaction (B1). The worker uses this to surface ONE honest skipped[] note ("resample
 *  skipped: not yet supported with content-hash cache-busting") instead of a silent no-op (invariant 3). */
export function resampleSkippedByHashFilenames(opts: ResampleGateOptions): boolean {
  if (opts.hashFilenames !== true) return false;
  const b = opts.backend;
  return (
    b != null &&
    b.consent === true &&
    b.ops.includes('resample') &&
    b.apiBase.trim() !== '' &&
    b.token.trim() !== ''
  );
}
