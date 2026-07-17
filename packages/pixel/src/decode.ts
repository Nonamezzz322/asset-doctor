// Shared canvas-decode → image-features step. The impure half of the pixel layer: it needs
// createImageBitmap + OffscreenCanvas (available in a Web Worker AND in a page/extension MAIN world, absent
// in Node). Extracted from apps/web's analyze.worker so the extension overlay decodes + assembles features
// IDENTICALLY to the web app — the folder audit surfaces the SAME feature-gated findings in both hosts.
//
// Split in two: `decodeImageFeatures` (the canvas decode + pure measurements) and the PURE, Node-testable
// `featureFromDecode` (the additive, omit-when-absent ImageFeatures assembly — the honesty-critical half:
// a field is set ONLY when its measurement is present, so a host that computes nothing stays byte-identical).

import type { ContentClass, ImageFeatures } from '@asset-doctor/core';
import { pageExceedsScanBudget } from './budget';
import {
  alphaFullyOpaque,
  alphaShape,
  classifyContent,
  dHashFromGray,
  isFlat,
  isSolidColor,
  blockUpscaleDepth,
  isSolidFullRes,
  luma,
  meanColorFromSample,
  premultipliedEdgeShape,
  type AlphaShapeResult,
  type PremultEdgeResult,
} from './perceptual';

/** The raw per-image measurements one decode yields — before the additive ImageFeatures assembly. `w`/`h`
 *  are the decoded dimensions (0 when never decoded) so the caller can build an oversize-skip reason. */
export interface DecodedImageFeatures {
  dHash: string | null;
  contentClass: ContentClass;
  solid: boolean;
  opaque: boolean;
  meanColor: { r: number; g: number; b: number } | null;
  scanSkipped: boolean;
  upscaleDepth: number;
  premult: PremultEdgeResult | null;
  shape: AlphaShapeResult | null;
  w: number;
  h: number;
}

const EMPTY = (w: number, h: number): DecodedImageFeatures => ({
  dHash: null,
  contentClass: 'unknown',
  solid: false,
  opaque: false,
  meanColor: null,
  scanSkipped: false,
  upscaleDepth: 0,
  premult: null,
  shape: null,
  w,
  h,
});

/** ONE 9×8 decode → BOTH the dHash (near-dup detection) AND the content class (format verdict). The
 *  9×8 RGBA sample is read once with getImageData; `dHash` is null for featureless fills (they collapse
 *  to one hash → false near-dup matches), `contentClass` is the lossy-vs-lossless hint (Inv 4: NO
 *  encode here — the class is pure math over the already-decoded sample). The 9×8 sample also yields the
 *  `solid` CANDIDATE (single-color / fully transparent — drives the loose-only solid-fill finding), which
 *  is then CONFIRMED at full resolution (`isSolidFullRes`) before being reported — a sub-cell feature can
 *  box-average away in the 72-px sample, so an unconfirmed candidate would fabricate a VRAM saving on a
 *  not-actually-solid image (invariant 3). When `scanAlpha` (a loose PNG/WebP) OR the 9×8 flagged a solid
 *  candidate, the SAME decoded bitmap is drawn ONCE at FULL resolution and read once for the opaque scan
 *  (`opaque`), the solid confirmation, the upscale-depth proof, the premultiplied-edge scan, and the
 *  alpha-shape scan — all off ONE full-res buffer (zero extra decode). The full-frame scan is GATED by
 *  the shared pageExceedsScanBudget (ANALYZE_PAGE_MAX_PX ≈25.2 MP per-page cap that bounds the transient
 *  w·h·4 getImageData read ≤10s) — an oversize page sets `scanSkipped` so the CALLER can surface it
 *  honestly in unparsed[]. 'unknown' / false / null on any decode failure or when OffscreenCanvas is
 *  unavailable (Node / an environment without a canvas). */
export async function decodeImageFeatures(bytes: ArrayBuffer, scanAlpha: boolean): Promise<DecodedImageFeatures> {
  if (typeof OffscreenCanvas === 'undefined') return EMPTY(0, 0);
  try {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const { width, height } = bmp; // capture before close() so the caller's skip reason has the dimensions
    const canvas = new OffscreenCanvas(9, 8);
    const c2d = canvas.getContext('2d');
    if (!c2d) {
      bmp.close();
      return EMPTY(width, height);
    }
    c2d.drawImage(bmp, 0, 0, 9, 8);
    const data = c2d.getImageData(0, 0, 9, 8).data;
    // Alpha-weighted mean color over the SAME 9×8 sample (zero extra decode) — feeds the duplicate-similar
    // mean-color guard (dHash is luma-sign-only ⇒ color-blind). null when Σα === 0 (nothing to measure).
    const meanColor = meanColorFromSample(data);
    const gray: number[] = [];
    for (let p = 0; p < 9 * 8; p++) gray.push(luma(data, p * 4));
    const dHash = isFlat(gray) ? null : dHashFromGray(gray); // featureless → skip perceptual matching
    const contentClass = classifyContent(gray, data);
    // The 9×8 `solid` CANDIDATE (cheap pre-filter). It rules out virtually every real image instantly, but a
    // sub-cell feature can box-average away in the 72-px sample, so a candidate MUST be confirmed at full
    // resolution before we claim solid (invariant 3 — otherwise a sparse-but-not-solid image fabricates a
    // ~w·h·4 VRAM saving). Confirmed below; `solid` stays false unless BOTH agree.
    const solidCandidate = isSolidColor(gray, data);
    // `scanSkipped` is true ONLY when the OPAQUE scan was WANTED (scanAlpha) but the page busted the cap — a
    // non-alpha format never wanted it ⇒ never "skipped" ⇒ no unparsed entry. (Unchanged semantics.)
    const overBudget = pageExceedsScanBudget(width, height);
    const scanSkipped = scanAlpha && overBudget;
    // Full-resolution buffer needed iff the opaque scan wants it (loose PNG/WebP) OR the 9×8 flagged a solid
    // candidate — and the page fits the px budget. ONE decode+read serves EVERY full-res measurement.
    let opaque = false;
    let solid = false;
    let upscaleDepth = 0;
    let premult: PremultEdgeResult | null = null;
    let shape: AlphaShapeResult | null = null;
    if ((scanAlpha || solidCandidate) && !overBudget) {
      const full = new OffscreenCanvas(width, height);
      const fctx = full.getContext('2d', { willReadFrequently: true });
      if (fctx) {
        fctx.drawImage(bmp, 0, 0); // 1:1 draw — no canvas resampler, so the confirmation is resampler-independent
        const fullData = fctx.getImageData(0, 0, width, height).data;
        opaque = scanAlpha ? alphaFullyOpaque(fullData) : false; // unchanged
        solid = solidCandidate ? isSolidFullRes(fullData) : false; // full-res CONFIRMATION of the 9×8 candidate
        // PROVABLE nearest-2× upscale depth (upscaled-source finding) — reuses this same full-res buffer, zero
        // extra decode. Skip on a confirmed solid (solid-fill owns it; a solid descends fully for nothing).
        if (!solid) upscaleDepth = blockUpscaleDepth(fullData, width, height);
        // Premultiplied-shaped edge scan (premultiplied-alpha folder disclosure) — reuses this SAME fullData
        // buffer (zero extra decode), gated to the alpha-bearing formats the opaque scan already targets.
        if (scanAlpha) premult = premultipliedEdgeShape(fullData, width, height);
        // Alpha-shape scan (interior-transparency + binary-alpha disclosures) — ONE call off this SAME
        // fullData buffer (zero extra decode), same alpha-format gate. null (fully transparent / degenerate)
        // ⇒ the caller omits the feature and neither disclosure can ever fire.
        if (scanAlpha) shape = alphaShape(fullData, width, height);
      }
    }
    bmp.close();
    return { dHash, contentClass, solid, opaque, meanColor, scanSkipped, upscaleDepth, premult, shape, w: width, h: height };
  } catch {
    return EMPTY(0, 0);
  }
}

/** Assemble the ADDITIVE, omit-when-absent ImageFeatures from a decode result + the host-computed content
 *  hash. PURE (Node-testable). Each optional field is set ONLY when its measurement is present — a host that
 *  decoded nothing (no canvas) yields `{ assetRef, contentHash }` and every feature-gated folder rule stays
 *  silent, byte-identical to a headless CLI run. This is the honesty contract: the extension overlay and the
 *  web worker BOTH route through here, so neither can surface a finding the other wouldn't. */
export function featureFromDecode(assetRef: string, contentHash: string, d: DecodedImageFeatures): ImageFeatures {
  const feat: ImageFeatures = { assetRef, contentHash };
  if (d.dHash) feat.dHash = d.dHash;
  if (d.contentClass !== 'unknown') feat.contentClass = d.contentClass;
  if (d.solid) feat.solid = true; // additive: only ever set when true
  if (d.upscaleDepth >= 1) feat.blockUpscaleDepth = d.upscaleDepth; // additive: only ever set for a proven upscale
  if (d.opaque) feat.opaque = true; // additive: only ever set when true (full-frame alpha === 255)
  // Attached ONLY when the scan ran AND found ≥1 qualifying edge pixel — absent ⇒ the premultiplied-alpha
  // folder disclosure can never fire (byte-identical to a host that never scanned).
  if (d.premult && d.premult.edgePixels > 0) feat.premultipliedEdge = d.premult;
  // Attached ONLY when the alpha-shape scan found ≥1 pixel with alpha > 0 (null for a fully-transparent
  // image / short buffer) — absent ⇒ interior-transparency + binary-alpha disclosures can never fire.
  if (d.shape) feat.alphaShape = d.shape;
  // Attached whenever measured (non-null): the duplicate-similar mean-color guard consumes it; features that
  // never enter perceptual matching (dHash-null) are filtered downstream, so it's inert there.
  if (d.meanColor) feat.meanColor = d.meanColor;
  return feat;
}
