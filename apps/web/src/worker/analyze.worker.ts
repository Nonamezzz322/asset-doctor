/// <reference lib="webworker" />
// Runs parsing + analysis off the main thread. Two impure bits live here (injected into the
// pure analysis core): per-image features (SHA-256 content hash + perceptual dHash) for
// folder-level duplicate detection, and format sizing (OffscreenCanvas → WebP/AVIF).

import type { Asset, AtlasFrameHashes, AtlasFrameTrims, ImageFeatures, ImageMime, Sprite, TrimRect } from '@asset-doctor/core';
import { parseAtlas, parseImage, parseSpinePage, parseFntPage, type FntPage, type MalformedFrame, type ParseResult, type SpinePage } from '@asset-doctor/parsers';
import { analyze, mergeSharedAtlases, type EncodeSizer, type OpaqueEncodeSizer } from '@asset-doctor/analysis';
import { alphaBBox } from '@asset-doctor/fix';
import { pageExceedsScanBudget, scanSkipReason } from '../lib/bitmap-budget';
import { groupFiles, keyOf, type RawFile } from '../lib/group';
import {
  alphaFullyOpaque,
  alphaShape,
  classifyContent,
  dHashFromGray,
  extractFrameRegions,
  FRAME_HASH_MAX_SPRITES,
  isFlat,
  isSolidColor,
  blockUpscaleDepth,
  isSolidFullRes,
  luma,
  meanColorFromSample,
  premultipliedEdgeShape,
  type AlphaShapeResult,
  type PremultEdgeResult,
} from '../lib/perceptual';
import type { ContentClass } from '@asset-doctor/core';
import type { WorkerRequest, WorkerResponse } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: WorkerResponse): void => ctx.postMessage(m);

// round18-abortable-workers: cooperative cancel. Set on {type:'cancel'}; checked at the top of each
// per-asset loop + before the terminal `done` post, so a superseded run stops doing heavy work in the
// microtask gap before terminate() lands and never posts a `done` that races the terminate. ADDITIVE:
// a non-aborted run never sees a cancel ⇒ this stays false ⇒ every guard is a dead `if`.
let cancelled = false;

ctx.onmessage = async (e: MessageEvent<WorkerRequest>): Promise<void> => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (msg.type !== 'analyze') return;
  cancelled = false; // defensive reset (clients build a fresh worker per run today, so this is normally moot)
  try {
    const files: RawFile[] = msg.files.map((f) => ({ name: f.name, path: f.path, bytes: f.bytes }));
    const grouped = groupFiles(files);
    const assets: Asset[] = [];
    const imageBytes = new Map<string, ArrayBuffer>();
    // mime of each LOOSE image, keyed by assetRef — gates the full-frame opaque scan to alpha-bearing
    // formats (PNG/WebP) only; atlases are never keyed here (the wasted-alpha rule is loose-only).
    const looseMime = new Map<string, ImageMime>();
    const total = grouped.atlases.length + grouped.images.length;
    let done = 0;
    // Honest unparsed surface: ingest's "looks like a manifest but unusable" skip-points + the worker's
    // own parse failures (atlas/spine threw or image header unrecognized) + per-region Spine recovery.
    // Sorted by ref before handing to analyze (which passes it through verbatim).
    const unparsed = [...grouped.unparsed];
    // Per-bmfont-page font metadata (face + kerning count) read off the parsed FntPage, keyed by atlas.name
    // — drives the font-glyph-page readout. Absent ⇒ never fires (additive, gated like frameHashes).
    const fontPages: { atlasRef: string; faceName?: string; kerningCount: number }[] = [];

    for (const a of grouped.atlases) {
      if (cancelled) return; // superseded — stop before the next parse (terminate() will land shortly)
      const image = { ref: a.name, bytes: new Uint8Array(a.image.bytes) };
      // a.name is the dir-aware key from ingest — pass it as the asset name so two atlases sharing a
      // meta.image basename across folders stay distinct (atlas.name defaults to the bare imageRef).
      // Annotated with the parseAtlas intersection so the optional malformedFrames slot survives the union
      // collapse (parseSpinePage's plain ParseResult is assignable; it never sets the field ⇒ `?? []` empty).
      const res: ParseResult & { malformedFrames?: MalformedFrame[] } =
        a.kind === 'spine'
          ? parseSpinePage(a.manifest as SpinePage, image, { name: a.name })
          : a.kind === 'bmfont'
            ? parseFntPage(a.manifest as FntPage, image, { name: a.name })
            : parseAtlas(a.manifest, image, { name: a.name });
      post({ type: 'progress', done: ++done, total, label: a.name });
      if (res.ok && res.asset.kind === 'atlas') {
        assets.push(res.asset);
        imageBytes.set(res.asset.atlas.name, a.image.bytes);
        // Per-frame TexturePacker/Pixi recovery (round21 #1): the sheet kept its good sprites; surface each
        // dropped frame individually via the same `<atlas>#<frame>` ref the Spine recovery uses. Only the
        // non-spine parseAtlas result carries malformedFrames; parseSpinePage's result never does (?? []).
        for (const mf of res.malformedFrames ?? []) {
          unparsed.push({ ref: `${a.name}#${mf.name}`, reason: mf.reason });
        }
      } else if (!res.ok) {
        unparsed.push({ ref: a.name, reason: res.error });
      }
      // Per-region Spine recovery: the page kept its good sprites; surface the bad regions individually.
      if (a.kind === 'spine') {
        for (const mr of (a.manifest as SpinePage).malformedRegions ?? []) {
          unparsed.push({ ref: `${a.name}#${mr.name}`, reason: mr.reason });
        }
      }
      // Per-glyph BMFont recovery + the font-glyph-page metadata. The page kept its good glyphs; surface the
      // dropped ones via the same `<page>#<id>` ref convention spine/TP use. fontPages drives the readout.
      if (a.kind === 'bmfont') {
        const fp = a.manifest as FntPage;
        for (const mg of fp.malformedGlyphs ?? []) {
          unparsed.push({ ref: `${a.name}#${mg.id}`, reason: mg.reason });
        }
        // bmfont pages are never shared-page-merged (a single-image glyph page keeps its name), so a.name
        // here === the merged atlas name analyze sees → the fontByRef lookup keys match.
        if (res.ok && res.asset.kind === 'atlas') {
          fontPages.push({ atlasRef: a.name, faceName: fp.face, kerningCount: fp.kerningCount });
        }
      }
    }
    for (const im of grouped.images) {
      if (cancelled) return; // superseded — stop before the next parse
      // Key loose images by the dir-aware path (keyOf) so same-basename files in different folders are
      // two distinct assets instead of silently overwriting each other in the bytes map + features.
      const ref = keyOf(im);
      const res = parseImage(ref, new Uint8Array(im.bytes));
      post({ type: 'progress', done: ++done, total, label: ref });
      if (res.ok && res.asset.kind === 'image') {
        assets.push(res.asset);
        imageBytes.set(res.asset.image.name, im.bytes);
        looseMime.set(res.asset.image.name, res.asset.image.mime);
      } else if (!res.ok) {
        unparsed.push({ ref, reason: res.error });
      }
    }
    // NB (Round 21 #2): the unparsed.sort() is HOISTED to AFTER the frame-hash loop below — the feature loop
    // and the frame-hash loop both push NEW size-skip entries, so sorting here would leave those unsorted.
    // Sorting once after every push keeps the order deterministic regardless of which pages busted the cap.

    // Per-image features for folder-level duplicate detection + the content-class format verdict.
    // ONE decode per image yields both the dHash AND the content class (zero extra getImageData).
    const features: ImageFeatures[] = [];
    for (const [assetRef, bytes] of imageBytes) {
      if (cancelled) return; // superseded — stop before the next (heavy) decode/hash
      const contentHash = await sha256Hex(bytes);
      // Only a LOOSE alpha-bearing image (PNG/WebP) needs the full-frame opaque scan — gate it so atlases
      // and JPEG/AVIF loose images never pay the full-resolution decode (instant-wow: most files skip it).
      const m = looseMime.get(assetRef);
      const scanAlpha = m === 'image/png' || m === 'image/webp';
      const { dHash, contentClass, solid, opaque, meanColor, scanSkipped, upscaleDepth, premult, shape, w, h } = await decodeFeatures(bytes, scanAlpha);
      const feat: ImageFeatures = { assetRef, contentHash };
      if (dHash) feat.dHash = dHash;
      if (contentClass !== 'unknown') feat.contentClass = contentClass;
      if (solid) feat.solid = true; // additive: only ever set when true
      if (upscaleDepth >= 1) feat.blockUpscaleDepth = upscaleDepth; // additive: only ever set for a proven upscale
      if (opaque) feat.opaque = true; // additive: only ever set when true (full-frame alpha === 255)
      // Additive, omit-when-absent: attached ONLY when the scan ran AND found ≥1 qualifying edge pixel —
      // absent ⇒ the premultiplied-alpha folder disclosure can never fire (byte-identical to today).
      if (premult && premult.edgePixels > 0) feat.premultipliedEdge = premult;
      // Additive, omit-when-absent: attached ONLY when the alpha-shape scan ran and found ≥1 pixel with
      // alpha > 0 (alphaShape returns null for a fully-transparent image / short buffer) — absent ⇒ the
      // interior-transparency + binary-alpha disclosures can never fire (byte-identical to today).
      if (shape) feat.alphaShape = shape;
      // Attach whenever measured (non-null): the duplicate-similar mean-color guard consumes it; features
      // that never enter perceptual matching (dHash-null) are filtered out downstream, so it's inert there.
      if (meanColor) feat.meanColor = meanColor;
      features.push(feat);
      // Round 21 #2: the alpha scan was GATED OFF for an oversize loose page — surface that honestly in
      // unparsed[] (it was a SILENT skip before). Only when scanAlpha was wanted AND the page busted the cap;
      // a non-alpha format or an under-cap page pushes nothing ⇒ additive (no entry, no number change).
      if (scanSkipped) unparsed.push({ ref: assetRef, reason: scanSkipReason(w, h) });
    }

    // Hoisted so the frame-redundancy hashing runs on the POST-MERGE sprite list (mergeSharedAtlases unions
    // shared-page regions by name into the first atlas; the index alignment + atlasRef keying must match the
    // list analyze() sees). imageBytes is keyed by atlas.name === merged atlas.name (the shared-page case).
    const merged = mergeSharedAtlases(assets);

    // Per-atlas sprite-region hashes for the within-atlas frame-redundancy check. ONE full-resolution decode
    // per atlas page (a NEW decode — owned cost, same magnitude as the main-thread FilmViewer decode), then
    // each sprite region is read off that single bitmap. Bounded by a size cap (very large pages skipped
    // honestly). Absent (no OffscreenCanvas / skipped) ⇒ the rule never fires (additive, gated like dHash).
    const frameHashes: AtlasFrameHashes[] = [];
    const frameTrims: AtlasFrameTrims[] = []; // computed in the SAME decode pass — no extra page decode
    for (const a of merged) {
      if (cancelled) return; // superseded — stop before the next (heavy) page decode
      if (a.kind !== 'atlas' || a.atlas.sprites.length === 0) continue;
      const bytes = imageBytes.get(a.atlas.name);
      if (!bytes) continue;
      const res = await hashAtlasFrames(bytes, a.atlas.sprites);
      if (res.kind === 'ok') {
        frameHashes.push({ atlasRef: a.atlas.name, frameHashes: res.hashes });
        frameTrims.push({ atlasRef: a.atlas.name, bboxes: res.bboxes });
      } else if (res.kind === 'sizeskip') {
        // Round 21 #2: the WHOLE page busted the px cap — surface that honestly (was a SILENT skip before).
        unparsed.push({ ref: a.atlas.name, reason: scanSkipReason(res.w, res.h) });
      } else if (res.kind === 'spriteskip') {
        // The page has more sprites than the frame-redundancy cap — a DISTINCT reason from the px cap.
        unparsed.push({
          ref: a.atlas.name,
          reason: `skipped for size: ${res.n} sprites exceeds ${FRAME_HASH_MAX_SPRITES} sprite scan cap`,
        });
      }
      // res.kind === 'fail' (no OffscreenCanvas / decode / ctx failure / degenerate page) ⇒ no entry,
      // exactly as before this change (those were never surfaced and are not honesty regressions here).
    }
    // Round 21 #2: sort once, AFTER both loops above have pushed every size-skip entry, so the unparsed
    // order is deterministic regardless of WHICH pages busted the cap (analyze passes it through verbatim).
    unparsed.sort((a, b) => a.ref.localeCompare(b.ref));

    const report = await analyze(merged, undefined, {
      encodeImage: makeEncoder(imageBytes),
      encodeOpaque: makeOpaqueEncoder(imageBytes),
      features,
      missingImages: grouped.missing,
      ...(frameHashes.length ? { frameHashes } : {}),
      ...(frameTrims.length ? { frameTrims } : {}),
      ...(unparsed.length ? { unparsed } : {}),
      ...(fontPages.length ? { fontPages } : {}),
    });
    if (cancelled) return; // superseded — suppress a `done` that would race the terminate
    post({ type: 'done', report });
  } catch (err) {
    post({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** ONE 9×8 decode → BOTH the dHash (near-dup detection) AND the content class (format verdict). The
 *  9×8 RGBA sample is read once with getImageData; `dHash` is null for featureless fills (they collapse
 *  to one hash → false near-dup matches), `contentClass` is the lossy-vs-lossless hint (Inv 4: NO
 *  encode here — the class is pure math over the already-decoded sample). The 9×8 sample also yields the
 *  `solid` CANDIDATE (single-color / fully transparent — drives the loose-only solid-fill finding), which
 *  is then CONFIRMED at full resolution (`isSolidFullRes`) before being reported — a sub-cell feature can
 *  box-average away in the 72-px sample, so an unconfirmed candidate would fabricate a VRAM saving on a
 *  not-actually-solid image (invariant 3). When `scanAlpha` (a loose PNG/WebP) OR the 9×8 flagged a solid
 *  candidate, the SAME decoded bitmap is drawn ONCE at FULL resolution and read once for BOTH the opaque
 *  scan (`opaque` — alpha === 255 on every pixel; short-circuits on the first non-opaque pixel, so most
 *  images bail instantly) AND the solid confirmation (PNG/WebP already pay this read for the opaque scan;
 *  a rare solid-candidate JPEG/AVIF pays a bounded on-demand read; an over-budget candidate ⇒ solid stays
 *  false, an honest conservative miss). The full-frame scan is GATED by the shared
 *  pageExceedsScanBudget (Round 21 #2: ANALYZE_PAGE_MAX_PX, the single-sourced ≈25.2 MP per-page cap that
 *  bounds this transient w·h·4 getImageData read ≤10s) — an oversize page sets `scanSkipped` so the CALLER
 *  can surface it honestly in unparsed[] (it was a SILENT skip before). 'unknown' / solid:false /
 *  opaque:false / scanSkipped:false on any decode failure or when OffscreenCanvas is unavailable. `w`/`h`
 *  are the decoded dimensions (0 when never decoded) so the caller can build the skip reason after the
 *  bitmap is closed. */
async function decodeFeatures(
  bytes: ArrayBuffer,
  scanAlpha: boolean,
): Promise<{
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
}> {
  if (typeof OffscreenCanvas === 'undefined')
    return { dHash: null, contentClass: 'unknown', solid: false, opaque: false, meanColor: null, scanSkipped: false, upscaleDepth: 0, premult: null, shape: null, w: 0, h: 0 };
  try {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const { width, height } = bmp; // capture before close() so the caller's skip reason has the dimensions
    const canvas = new OffscreenCanvas(9, 8);
    const c2d = canvas.getContext('2d');
    if (!c2d) {
      bmp.close();
      return { dHash: null, contentClass: 'unknown', solid: false, opaque: false, meanColor: null, scanSkipped: false, upscaleDepth: 0, premult: null, shape: null, w: width, h: height };
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
    // candidate — and the page fits the px budget. ONE decode+read serves BOTH measurements: PNG/WebP already
    // pay this read for the opaque scan, so the solid confirmation is nearly free there; only a RARE
    // solid-candidate JPEG/AVIF pays a bounded on-demand read here. An over-budget solid candidate is left
    // UNconfirmed ⇒ solid stays false (a conservative miss within ≤10s, never a guess — invariant 3).
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
        // The first pass short-circuits on the first non-constant block, so a real detailed image costs ~O(N).
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
    return { dHash: null, contentClass: 'unknown', solid: false, opaque: false, meanColor: null, scanSkipped: false, upscaleDepth: 0, premult: null, shape: null, w: 0, h: 0 };
  }
}

/** Discriminated result of hashAtlasFrames (Round 21 #2). `ok` carries the index-aligned hashes + bboxes;
 *  `sizeskip`/`spriteskip` are the two DISTINCT whole-page skip reasons the worker surfaces in unparsed[]
 *  (the px cap vs the sprite-count cap — `extractFrameRegions` returns null for BOTH, so they're separated
 *  here by re-checking the caps the worker already knows); `fail` is a non-honesty bail (no OffscreenCanvas,
 *  decode/ctx failure, or a degenerate page) — surfaced as nothing, exactly as before this change. */
type FrameHashResult =
  | { kind: 'ok'; hashes: (string | null)[]; bboxes: (TrimRect | null)[] }
  | { kind: 'sizeskip'; w: number; h: number }
  | { kind: 'spriteskip'; n: number }
  | { kind: 'fail' };

/** Hash each sprite's PIXEL REGION off the atlas page (within-atlas frame-redundancy) AND compute each
 *  UNtrimmed sprite's OPAQUE bounding box (within-atlas trim-margin) — BOTH off ONE shared decode. ONE
 *  `createImageBitmap` + ONE full-resolution `getImageData` per page (a NEW decode — owned cost, same
 *  magnitude as the main-thread FilmViewer decode); the trim bboxes piggyback on that SAME `page` buffer, so
 *  the trim feature adds ZERO extra decode (instant-wow ≤10s). The PURE `extractFrameRegions` does the
 *  load-bearing redundancy work canvas-free (caps / bounds / region extraction / box-averaged 9×8 flat-guard);
 *  the pure `alphaBBox` reads the SAME buffer for the trim bbox. Each surviving region's RGBA bytes are
 *  SHA-256'd here (crypto.subtle is async). Both arrays are index-aligned to `sprites`. A bbox is computed ONLY
 *  for an UNtrimmed sprite (`!sp.trimmed`) — an already-trimmed sprite is `null` (skipped; the rule re-gates on
 *  Sprite.trimmed anyway); a fully-transparent untrimmed frame is `null` too (alphaBBox finds no opaque pixel —
 *  the rule reads that as a whole-frame margin). Reuses the SAME caps as before via the shared
 *  pageExceedsScanBudget (Round 21 #2 — the px cap is single-sourced now); a busted cap skips the WHOLE page
 *  for BOTH halves and is surfaced HONESTLY (the two cap reasons disambiguated for unparsed[]) instead of
 *  silently. Deterministic. */
async function hashAtlasFrames(pageBytes: ArrayBuffer, sprites: Sprite[]): Promise<FrameHashResult> {
  if (typeof OffscreenCanvas === 'undefined') return { kind: 'fail' };
  // Sprite-count cap: known WITHOUT a decode. extractFrameRegions checks this first internally; we mirror it
  // here so the whole-page skip is surfaced as the DISTINCT sprite reason (not conflated with the px cap).
  if (sprites.length > FRAME_HASH_MAX_SPRITES) return { kind: 'spriteskip', n: sprites.length };
  try {
    const bmp = await createImageBitmap(new Blob([pageBytes]));
    const { width, height } = bmp;
    if (width <= 0 || height <= 0) {
      bmp.close();
      return { kind: 'fail' }; // degenerate page — not an honest "too big" skip, just unhashable
    }
    // Px cap: the page is too large to read at full resolution. Surface honestly (was silent before). Check
    // BEFORE allocating the full-resolution canvas/getImageData so the oversize page never pays the read.
    if (pageExceedsScanBudget(width, height)) {
      bmp.close();
      return { kind: 'sizeskip', w: width, h: height };
    }
    const canvas = new OffscreenCanvas(width, height);
    const c2d = canvas.getContext('2d', { willReadFrequently: true });
    if (!c2d) {
      bmp.close();
      return { kind: 'fail' };
    }
    c2d.drawImage(bmp, 0, 0);
    bmp.close();
    const page = c2d.getImageData(0, 0, width, height).data; // one full-res read; both halves read this buffer
    const regions = extractFrameRegions(
      page,
      width,
      height,
      sprites.map((sp) => sp.frame),
    );
    // Both caps were re-checked above, so a null here would be a defensive guard only — treat as a non-honesty
    // fail (no unparsed entry) rather than fabricate a reason. In practice unreachable after the cap checks.
    if (!regions) return { kind: 'fail' };
    const hashes: (string | null)[] = [];
    for (const region of regions) hashes.push(region === null ? null : await sha256Hex(region.buffer as ArrayBuffer));
    // Trim bboxes off the SAME page buffer (no second decode). Only for UNtrimmed sprites; alphaBBox returns a
    // bbox RELATIVE to the frame top-left (exactly what trimMarginFinding expects), or null for a fully
    // transparent frame. `regions` already cleared the caps, so this loop is bounded by the same ceilings.
    const src = { data: page, width };
    const bboxes: (TrimRect | null)[] = sprites.map((sp) =>
      sp.trimmed ? null : alphaBBox(src, { x: sp.frame.x, y: sp.frame.y, w: sp.frame.w, h: sp.frame.h }),
    );
    return { kind: 'ok', hashes, bboxes };
  } catch {
    return { kind: 'fail' };
  }
}

function makeEncoder(imageBytes: Map<string, ArrayBuffer>): EncodeSizer {
  return async (assetRef: string, _sourceMime: ImageMime, targetMime: ImageMime) => {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const bytes = imageBytes.get(assetRef);
    if (!bytes) return null;
    try {
      const bmp = await createImageBitmap(new Blob([bytes]));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const c2d = canvas.getContext('2d');
      if (!c2d) return null;
      c2d.drawImage(bmp, 0, 0);
      bmp.close();
      const blob = await canvas.convertToBlob({ type: targetMime, quality: 0.9 });
      // convertToBlob falls back to PNG where the target codec is unavailable — don't count that.
      return blob.type === targetMime ? blob.size : null;
    } catch {
      return null;
    }
  };
}

/** MEASURE the disk size of an asset re-encoded OPAQUE (alpha channel dropped) to its SAME format. Used
 *  only to size the wasted-alpha finding's realizable opaque re-encode saving (byteSize − this; the delta
 *  bundles the dropped channel with this encoder's recompression, and the finding's copy attributes it to
 *  the RE-ENCODE, never to the channel alone) — it sizes, it never emits a file (invariant 3). Composes onto an `{alpha:false}` OffscreenCanvas (a genuinely opaque surface —
 *  the strongest signal that the encoder may omit the channel), then convertToBlob to the source mime.
 *  Returns null when OffscreenCanvas is unavailable, the bytes are missing, or convertToBlob falls back to
 *  a different codec (so the size is never miscounted). */
function makeOpaqueEncoder(imageBytes: Map<string, ArrayBuffer>): OpaqueEncodeSizer {
  return async (assetRef: string, mime: ImageMime) => {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const bytes = imageBytes.get(assetRef);
    if (!bytes) return null;
    try {
      const bmp = await createImageBitmap(new Blob([bytes]));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const c2d = canvas.getContext('2d', { alpha: false }); // genuinely opaque surface → drop the channel
      if (!c2d) {
        bmp.close();
        return null;
      }
      c2d.drawImage(bmp, 0, 0);
      bmp.close();
      const blob = await canvas.convertToBlob({ type: mime, quality: 0.9 });
      return blob.type === mime ? blob.size : null;
    } catch {
      return null;
    }
  };
}
