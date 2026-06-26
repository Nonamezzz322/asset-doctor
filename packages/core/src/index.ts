// @asset-doctor/core — shared contracts between parsers, analysis, probe and the UI.
// Single source of truth for the inter-package data model. Changing a shape here is a
// coordinated change across every consumer — do not drift package-local copies.

/* ── Geometry ─────────────────────────────────────────────────────────── */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ── Atlas model (output of @asset-doctor/parsers) ─────────────────────────
 * Fidelity rules: `frame` is the packed rect AS PLACED in the atlas image
 * (width/height swapped when `rotated`). `trimmed` / `sourceSize` /
 * `spriteSourceSize` must survive parsing — occupancy and the grid coverage map
 * depend on them. Absent source fields stay `undefined`, never fabricated. */

export type AtlasSourceKind = 'texturepacker-hash' | 'texturepacker-array' | 'pixi' | 'spine';

/* ── Sprite mesh (Phase 2 polygon mode — additive, TexturePacker-compatible) ──────────────
 * A tight outline + triangulation an engine MAY consume to cut overdraw, AND the clip geometry
 * the fix worker uses to compose interlocked sprites without corrupting neighbors. The rectangle
 * `frame` + metadata remain the authoritative default render path. Absent ⇒ a pure rectangle
 * sprite (today's behavior). All coordinates are INTEGER pixels (no float ever enters here). */
export interface SpriteMesh {
  /** Outline in TRIMMED-SPRITE-LOCAL pixel space: origin = top-left of the frame region, Y-DOWN,
   *  positive (CCW under the Y-down shoelace convention, see Determinism §). Repack-INVARIANT —
   *  copied verbatim on re-placement. Length >= 3; no two consecutive coincident; no collinear triple. */
  vertices: Vec2[];
  /** Same points in PACKED-ATLAS pixel space (NOT normalized). For an unrotated frame:
   *  verticesUV[i] = vertices[i] + (frame.x, frame.y). RECOMPUTED on every re-placement from the
   *  FINAL per-bin frame.xy — never carried from the source. Same length & order as `vertices`. */
  verticesUV: Vec2[];
  /** Index triplets into BOTH vertices and verticesUV (same ordering). Each length 3. Positive
   *  (CCW) winding, emitted in triangulation order. Length === 3*(vertices.length - 2). */
  triangles: number[][];
}

export interface Sprite {
  name: string;
  /** Packed rectangle in the atlas image, as placed (w/h swapped if rotated). */
  frame: Rect;
  /** 90° rotation in the atlas (TexturePacker convention). */
  rotated: boolean;
  trimmed: boolean;
  /** Original, untrimmed sprite size. */
  sourceSize: Size;
  /** Trimmed-region offset/size within the source (present when trimmed). */
  spriteSourceSize?: Rect;
  pivot?: Vec2;
  /** Optional tight mesh (polygon mode). Additive; absent ⇒ rectangle-only sprite. */
  mesh?: SpriteMesh;
}

export interface Atlas {
  name: string;
  /** Relative path / handle key to the image file. Never fabricated. */
  imageRef: string;
  size: Size;
  /** e.g. 'RGBA8888' from meta.format, when present. */
  format?: string;
  scale?: number;
  sprites: Sprite[];
  source: { kind: AtlasSourceKind };
}

export type ImageMime = 'image/png' | 'image/webp' | 'image/jpeg' | 'image/avif';

export interface ImageAsset {
  name: string;
  imageRef: string;
  size: Size;
  mime: ImageMime;
  /** On-disk byte size. */
  byteSize: number;
}

export type Asset =
  | { kind: 'atlas'; atlas: Atlas; image: ImageAsset }
  | { kind: 'image'; image: ImageAsset };

/* ── Analysis model (output of @asset-doctor/analysis, input of the UI) ──── */

export type Severity = 'crit' | 'warn' | 'ok' | 'info';

export type Rule =
  // per-asset
  | 'occupancy'
  | 'wasted-regions'
  | 'format'
  | 'dimensions-npot'
  | 'dimensions-oversize'
  // whole-folder (scope: 'folder')
  | 'duplicate-exact'
  | 'duplicate-similar'
  | 'should-atlas'
  | 'atlas-merge'
  | 'integrity-missing-image'
  | 'variants';

/** Highlight zones drawn on the film-viewer snapshot, in atlas pixel coords. */
export interface OverlayZone {
  kind: 'empty' | 'transparent' | 'bleeding';
  rects: Rect[];
}

export interface FindingEstimate {
  diskBytesSaved?: number;
  vramBytesSaved?: number;
  occupancyPct?: number;
}

/** Raw interpolation values for localized rendering of a finding (numbers stay raw — the presentation
 *  layer formats bytes/percentages per locale). Strings (filenames, joined refs) are passed verbatim. */
export type FindingParams = Record<string, string | number>;

export interface Finding {
  id: string;
  rule: Rule;
  severity: Severity;
  /** 'asset' (default) for a single-asset finding, 'folder' for a whole-folder one. */
  scope?: 'asset' | 'folder';
  /** Asset this finding refers to (Atlas.name / ImageAsset.name); the primary one for folder findings. */
  assetRef: string;
  /** All assets a folder finding spans (duplicate group, merge candidates, …). */
  relatedRefs?: string[];
  /** Verdict, readout style. The baked English string — also the i18n fallback. */
  title: string;
  /** Explanation plus the proof (numbers). The baked English string. */
  detail: string;
  /** Suggested action. */
  fix?: string;
  /** Stable i18n key for this finding's template family (e.g. 'occupancy', 'should-atlas'). When set
   *  with `params`, the presentation layer renders title/detail/fix per locale; English is identical
   *  to the baked strings above. Absent → render the baked English. */
  messageKey?: string;
  /** Raw interpolation values for the localized templates. */
  params?: FindingParams;
  /** Quantified effect — only defensible numbers; leave sparse when uncertain. */
  estimate?: FindingEstimate;
  overlay?: OverlayZone[];
}

/** Per-image features computed by the host (worker) and fed to analysis for folder-level checks. */
export interface ImageFeatures {
  assetRef: string;
  /** Hex digest of the raw file bytes — exact-duplicate detection. */
  contentHash: string;
  /** 64-bit perceptual hash as 16 hex chars — near-duplicate detection. Absent if decode failed. */
  dHash?: string;
}

export interface AssetMetrics {
  assetRef: string;
  diskBytes: number;
  /** GPU footprint: Σ w×h×4 (RGBA8888). Disk weight ≠ VRAM. */
  vramBytes: number;
  /** 0..1, atlases only. */
  occupancy?: number;
}

/** Calibrated audit thresholds. Lives in config, never hardcoded inside rules. */
export interface ThresholdConfig {
  occupancy: { warn: number; crit: number };
  oversizePx: { warn: number; crit: number };
  formatSaving: { warn: number };
  /** Fraction of the POT-padded area wasted before flagging an NPOT info finding. */
  npotPadding: { warn: number };
  /** Folder-level checks. */
  duplicates: { similarHammingMax: number };
  shouldAtlas: { minLooseImages: number; maxSpriteEdgePx: number };
  atlasMerge: { occupancyBelow: number; minAtlases: number };
}

export interface AnalysisReport {
  assets: AssetMetrics[];
  findings: Finding[];
  totals: {
    diskBytes: number;
    /** Σ w×h×4 over every asset (variants summed — the naive footprint). */
    vramBytes: number;
    /** Realistic upper bound: one variant per logical asset (format-deduped, highest resolution tier). */
    loadedVramBytes: number;
    potentialDiskSaved: number;
  };
  /** The thresholds actually applied (for transparency in the UI). */
  thresholds: ThresholdConfig;
}

/* ── Fix model (Phase 2 — output of @asset-doctor/fix + the fix worker) ─────────────────────
 * The paid fix. A FixPlan is a PURE, structured-cloneable translation of MEASURED findings (never
 * invented) and NEVER carries pixel bytes. The pure packages/fix computes geometry (RepackResult +
 * Blits); the impure worker reads/writes pixels per the Blit contract and emits FixedFiles. */

/** A single optimization operation, derived mechanically from the diagnosis. */
export type FixOp =
  | { kind: 'repack'; atlasRefs: string[]; targetMime: ImageMime; pot: boolean; allowRotation: boolean; padding: number; maxSize: number }
  | { kind: 'transcode'; assetRef: string; targetMime: ImageMime; quality: number; lossless: boolean }
  | { kind: 'resize'; assetRef: string; to: Size; targetMime: ImageMime; quality: number }
  | { kind: 'drop'; assetRef: string; reason: 'duplicate-exact' | 'duplicate-similar' };

export interface FixPlan {
  ops: FixOp[];
  thresholds: ThresholdConfig;
}

/** Where a sprite's pixels come from and where they land in the new sheet — the pure→impure compose
 *  contract. `rotate90` is reserved for packer-introduced rotation (v1 preserves source orientation). */
export interface Blit {
  name: string;
  from: { atlasRef: string; rect: Rect; rotated: boolean };
  to: Rect;
  rotate90: boolean;
  /** OPTIONAL clip polygon in DESTINATION atlas pixel space (= the new sprite's verticesUV). When
   *  present the worker MUST clip the drawImage to this polygon so an interlocked neighbor's
   *  bounding box can overlap this one's transparent margin without overwriting opaque pixels.
   *  Absent ⇒ full-rect blit (today's behavior, unchanged). */
  clip?: Vec2[];
}

/** Geometry-only repack result (no pixels). `atlases` is plural to model maxSize/POT bin spill. */
export interface RepackResult {
  atlases: Atlas[];
  blits: Blit[];
  occupancyBefore: number;
  occupancyAfter: number;
  vramBytesBefore: number;
  vramBytesAfter: number;
}

/** One emitted file in the optimized download. `originalPath` drives the zip tree; `bytes` is the new
 *  content; `newName` rewrites the basename (e.g. btn.png → btn.webp). */
export interface FixedFile {
  originalPath: string;
  newName?: string;
  bytes: ArrayBuffer;
  /** Audit trail of ops applied to this file (e.g. ['repack', 'transcode webp']). */
  operations: string[];
}

/** The receipt for a whole fix run + the files to zip. disk AND vram both carried (POT-rounding can
 *  shrink one while the other moves — invariant 5); after-numbers are measured, not estimated. */
export interface FixReport {
  files: FixedFile[];
  diskBytesBefore: number;
  diskBytesAfter: number;
  vramBytesBefore: number;
  vramBytesAfter: number;
  /** Every fix the browser couldn't perform (e.g. AVIF unsupported) — surfaced, never silent. */
  skipped: { assetRef: string; reason: string }[];
}

/* ── Entitlement model (Slice B — the only thing the thin backend signs) ───────────────────────
 * The web client verifies an Entitlement OFFLINE with an embedded ed25519 public key. The token wire
 * form is `base64url(payloadJSON) + "." + base64url(sig)`; the SIGNED message is the literal first
 * segment, so there is no canonical-JSON requirement. `dev` is a client-generated random id (NOT a
 * fingerprint). Kept here so apps/web and apps/api (Go) share one source of truth for the claim shape. */
export const ENTITLEMENT_VERSION = 1;

export interface Entitlement {
  /** token version (must equal ENTITLEMENT_VERSION) */
  v: number;
  /** license key */
  lic: string;
  /** device id (opaque, client-generated random) */
  dev: string;
  /** plan, e.g. "pro" */
  plan: string;
  /** issued-at (unix seconds) */
  iat: number;
  /** expiry (unix seconds) */
  exp: number;
}
