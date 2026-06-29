// PURE scale-tier helpers (design docs/scale-tiers-design.md §1/§2/§3b). NO pixels, NO canvas, NO IO,
// NO Date.now / Math.random — integer-only, deterministic geometry so the worker (and any future caller)
// resolves EXACTLY the same tier geometry/names for given inputs. Golden-testable.
//
// This is the loose-image analogue of scaleAtlas (repack.ts): scaleAtlas stays the ATLAS geometry
// primitive (untouched); scaleLoose is the same 1px-floor downscale for a standalone image. The TIER
// LOOP (apps/web worker) owns oversize clamping and stamps `.scale` on tiered atlases — neither of those
// belongs here. We NEVER upscale (scale >= 1 ⇒ identity), matching scaleAtlas + the builder ladder.

import type { ExportProfile, FormatTarget, ImageMime, ProfileOverride, ResolutionTier, ScaleTier, Size } from '@asset-doctor/core';
import { EXT } from './dedup-exec';

/**
 * Default tier ladder — a verbatim port of the builder's DEFAULT_SCALES (config.ts:7), high→low.
 * scale 1 is the source/top tier (NEVER upscaled); every suffix is a RESOLUTION_TOKEN so the generated
 * tiers round-trip back into one variant cluster on re-ingest. Defaults reproduce today when scaleTiers
 * is empty/absent — this ladder only takes effect when a caller opts in.
 */
export const DEFAULT_SCALE_TIERS: readonly ScaleTier[] = [
  { scale: 1, suffix: '_1080p' },
  { scale: 0.75, suffix: '_720p' },
  { scale: 0.5, suffix: '_540p' },
];

/**
 * Resolution-only suffix token set groupVariants recognizes — the RESOLUTION subset of variants.ts
 * TOKEN, EXCLUDING the format tokens (png|webp|avif|jpeg). A `_webp` suffix would mis-stem and collide
 * with the format-variant logic, so it is rejected. Leading separator is `_` or `-`; the body is a
 * pixel-height token (`720p`), a density token (`@2x`/`2x`), or `hd`/`sd`. Case-insensitive.
 */
export const RESOLUTION_TOKEN = /^[_-](\d{2,4}p|@?\d+x|hd|sd)$/i;

/**
 * A filesystem-safe, build-safe FREE-FORM tier suffix: a leading separator (`_` or `-`), then a leading
 * body char from [A-Za-z0-9] (so `__` / `-_` are rejected), then 0..23 more chars from the SAFE charset
 * [A-Za-z0-9_-] (24-char body cap keeps it a sane filename fragment). NO dot (would fake an extension in
 * variantManifestName), NO slash (would inject a directory into the emitted path), NO `@` (density `@2x`
 * stays the RESOLUTION_TOKEN's job). Charset-safe for tieredName/variantManifestName verbatim injection.
 */
export const SUFFIX_TOKEN = /^[_-][A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;

/** Format-token bodies a free-form suffix must NOT equal (compared case-insensitively against the suffix
 *  BODY, after the leading separator). A `_png` suffix would collide with the multi-format token (EXT) and
 *  be mis-peeled as a FORMAT token by stemOf — so it is rejected even though it matches SUFFIX_TOKEN. */
const FORMAT_TOKEN_BODY = new Set(['png', 'webp', 'avif', 'jpg', 'jpeg']);

/**
 * Is `s` a valid tier suffix? SUPERSET of RESOLUTION_TOKEN — every currently-valid resolution suffix
 * (`_720p`/`@2x`/`_hd`/`_sd`) stays valid (zero regression), AND a safe free-form suffix (`_mobile`/`_lq`/
 * `_hidpi`/`_x2`) is now accepted. A free-form suffix is accepted iff it matches SUFFIX_TOKEN and its body
 * is NOT a format name (png/webp/avif/jpg/jpeg, case-insensitive). Pure; deterministic (regex + Set).
 *
 * HONEST RE-INGEST TRADE: resolution-shaped suffixes (`_720p`/`@2x`/`_hd`) still cluster as today via
 * variants.ts (one loaded-VRAM count per device). A CUSTOM non-resolution tier (e.g. `_mobile`) is NOT
 * recognized as a tier-variant if the built output is later re-analyzed — its tiers show as SEPARATE
 * assets. That is a CONSERVATIVE over-count of the advisory `variants` WARN (never a fabricated cluster,
 * never affecting the hard VRAM gate). We deliberately do NOT widen variants.ts clustering: doing so would
 * falsely cluster genuinely-different files (icon_blue/icon_red). See docs/improvements/ab-r4-suffix-policy.md.
 */
export function isSafeSuffix(s: string): boolean {
  if (RESOLUTION_TOKEN.test(s)) return true;
  return SUFFIX_TOKEN.test(s) && !FORMAT_TOKEN_BODY.has(s.slice(1).toLowerCase());
}

/**
 * Scaled size for a loose image — the loose-image analogue of scaleAtlas geometry: the SAME
 * `Math.max(1, Math.round(n * scale))` 1px floor (no zero-pixel dimension), integer-only, deterministic.
 * scale >= 1 ⇒ identity (NEVER upscale; a fresh copy so callers can't alias the input). Pure.
 */
export function scaleLoose(size: Size, scale: number): Size {
  const px = (n: number): number => Math.max(1, Math.round(n * scale));
  return scale >= 1 ? { w: size.w, h: size.h } : { w: px(size.w), h: px(size.h) };
}

/**
 * Insert a tier suffix before the extension, optionally swapping the extension for a transcoded mime.
 *   tieredName("ui/btn.png", "_720p")              → "ui/btn_720p.png"
 *   tieredName("ui/btn.png", "_720p", "image/webp") → "ui/btn_720p.webp"
 *   tieredName("ui/atlas.json", "_540p")           → "ui/atlas_540p.json"  (manifest ext kept)
 * The top tier (scale 1, e.g. "_1080p") is STILL suffixed so every tier shares one resolution stem and
 * the set round-trips into a single variant cluster. Pure string math, deterministic.
 */
export function tieredName(path: string, suffix: string, mime?: ImageMime): string {
  const ext = mime ? EXT[mime] : path.slice(path.lastIndexOf('.'));
  const stem = path.replace(/\.[a-z0-9]+$/i, '');
  return `${stem}${suffix}${ext}`;
}

/** Outcome of validateTiers: a fail-closed normalized ladder, or the list of reasons it was rejected. */
export type TierValidation =
  | { ok: true; tiers: ScaleTier[] }
  | { ok: false; errors: string[] };

/**
 * Fail-closed validation of a tier ladder (design §3b). Returns the normalized, deduped, high→low-sorted
 * ladder on success, or the structured list of rejection reasons. The caller (worker) turns each rejection
 * into a skipped[] honesty entry rather than silently emitting a bad export. Rejects:
 *   - empty input (nothing to emit);
 *   - any non-finite scale, scale <= 0, or scale > 1 (UPSCALE forbidden);
 *   - empty suffix, or a suffix rejected by isSafeSuffix (free-form allowed, but no dot/slash/@, no
 *     overlong body, and never a format-name body that would collide with multi-format naming);
 *   - duplicate suffixes (case-insensitive — they would clobber each other's emitted names);
 *   - a ladder with NO scale === 1 top tier (must include/handle the full-source top tier).
 * Pure and deterministic: same input ⇒ same result (stable high→low sort, ties broken by suffix).
 */
export function validateTiers(tiers: ScaleTier[]): TierValidation {
  const errors: string[] = [];
  if (tiers.length === 0) errors.push('empty: no tiers given');

  const seen = new Set<string>();
  let hasTopTier = false;
  for (const t of tiers) {
    const s = t.scale;
    if (!Number.isFinite(s) || s <= 0) errors.push(`badScale: ${String(s)} (must be in (0,1])`);
    else if (s > 1) errors.push(`upscale: ${String(s)} (scale must be <= 1; never upscale)`);
    else if (s === 1) hasTopTier = true;

    const suffix = t.suffix;
    if (!suffix) errors.push('badSuffix: empty suffix');
    else if (!isSafeSuffix(suffix)) errors.push(`badSuffix: "${suffix}" is not a safe tier suffix (use [A-Za-z0-9_-], not a format name)`);
    else {
      const key = suffix.toLowerCase();
      if (seen.has(key)) errors.push(`dupSuffix: "${suffix}"`);
      else seen.add(key);
    }
  }
  if (tiers.length > 0 && !hasTopTier) errors.push('noTopTier: ladder must include a scale=1 top tier');

  if (errors.length > 0) return { ok: false, errors };

  // Normalize: stable high→low by scale, suffix as the deterministic tiebreaker.
  const sorted = [...tiers].sort((a, b) => b.scale - a.scale || a.suffix.localeCompare(b.suffix));
  return { ok: true, tiers: sorted };
}

/* ── Config-driven export profile helpers (round7-export-profile.md §4a) ───────────────────────────
 * PURE string/validation helpers for the v1 export profile. The resolution axis reuses validateTiers
 * UNCHANGED; this module adds: the ResolutionTier→ScaleTier strip, fail-closed profile validation that
 * delegates the tier axis to validateTiers, and the format-token naming math (single-format ⇒ empty
 * token ⇒ byte-identical legacy names; multi-format ⇒ the format token disambiguates). Deterministic. */

/** Strip a ResolutionTier[] down to ScaleTier[] (drop `label`). Order-preserving; fresh objects so the
 *  caller can't alias the input. Pure. */
export function tiersOf(tiers: ResolutionTier[]): ScaleTier[] {
  return tiers.map((t) => ({ scale: t.scale, suffix: t.suffix }));
}

/** Outcome of validateProfile: the validated formats (given order) + normalized high→low tier ladder +
 *  the validated overrides (given order; [] when absent/empty), or the structured list of rejection
 *  reasons (the worker turns each into a skipped[] honesty entry). The worker reads `overrides` from
 *  here, never the raw exportProfile.overrides, so an invalid override fails the whole profile closed. */
export type ProfileValidation =
  | { ok: true; formats: FormatTarget[]; tiers: ScaleTier[]; overrides: ProfileOverride[] }
  | { ok: false; errors: string[] };

/** The honest browser-encodable format set (mirrors core ExportFormat). */
const EXPORT_FORMATS = new Set<string>(['image/png', 'image/webp', 'image/avif']);

/**
 * Validate ONE format list (the profile's own or an override's), pushing every violation into `errors`
 * with `label` as the source prefix (so e.g. `override[0].formats: losslessAvif` names the failing rule).
 * Factored out of validateProfile so the format-axis rules — empty / bad-format / lossless-avif /
 * bad-quality / bad-near / duplicate-target — are applied to BOTH p.formats and each override.formats and
 * CANNOT drift. Pure; deterministic. (Errors mirror the legacy unprefixed strings when label === '' so the
 * profile's own rejections keep their exact wire shape.)
 */
function validateFormatList(formats: FormatTarget[], label: string, errors: string[]): void {
  const pre = label === '' ? '' : `${label}: `;
  if (formats.length === 0) errors.push(`${pre}emptyFormats: no formats given`);
  const seen = new Set<string>();
  for (const f of formats) {
    if (!EXPORT_FORMATS.has(f.format)) {
      errors.push(`${pre}badFormat: "${f.format}" (must be image/png|image/webp|image/avif)`);
      continue; // a bad format can't meaningfully dup-check or lossless-check
    }
    if (f.lossless && f.format === 'image/avif') {
      errors.push(`${pre}losslessAvif: AVIF has no honest in-browser lossless path`);
    }
    if (f.quality !== undefined && (!Number.isFinite(f.quality) || f.quality < 0 || f.quality > 100)) {
      errors.push(`${pre}badQuality: ${String(f.quality)} (must be in [0,100])`);
    }
    if (f.near !== undefined && (!Number.isFinite(f.near) || f.near < 0 || f.near > 100)) {
      errors.push(`${pre}badNear: ${String(f.near)} (must be in [0,100])`);
    }
    // round13 B2: `pngLossy` is PNG-ONLY (it routes the page through the pngquant backend). On any non-png
    // target it is meaningless — fail the profile closed rather than silently ignore it (invariant 3).
    if (f.pngLossy && f.format !== 'image/png') {
      errors.push(`${pre}pngLossyNonPng: pngLossy is only valid on image/png (got "${f.format}")`);
    }
    // Duplicate-target key: two targets that resolve to the SAME emitted bytes clobber each other. Key on
    // the EFFECTIVE encode, not the raw fields, so e.g. {quality:undefined} and {quality:85} (the default,
    // DEFAULT_FORMAT_QUALITY) are caught as the same emit. PNG is always native-lossless (quality/near/
    // lossless irrelevant ⇒ any two PLAIN PNG targets clobber); lossless ignores quality/near; near is
    // WebP-only. round13 B2: a `pngLossy` PNG (pngquant-routed) emits DIFFERENT bytes than a plain lossless
    // PNG, so its dup-key MUST split (`image/png|lossy` vs `image/png`) — else a lossless+lossy PNG pair is a
    // false dupTarget and the whole profile fails closed.
    let key: string;
    if (f.format === 'image/png') key = f.pngLossy ? 'image/png|lossy' : 'image/png';
    else if (f.lossless) key = `${f.format}|L`;
    else key = `${f.format}|q${f.quality ?? 85}${f.format === 'image/webp' ? `|n${f.near ?? 'off'}` : ''}`;
    if (seen.has(key)) errors.push(`${pre}dupTarget: ${f.format}${f.pngLossy ? ' lossy' : f.lossless ? ' lossless' : ''}`);
    else seen.add(key);
  }
}

/** Valid AVIF chroma subsample integers (the @jsquash/aom set): 0=4:2:0, 1=4:2:2, 2=4:4:0, 3=4:4:4. A
 *  value outside this set is rejected fail-closed (it would reach the codec uncontrolled). */
const AVIF_SUBSAMPLE_SET = new Set([0, 1, 2, 3]);

/**
 * Fail-closed validation of the PROFILE-GLOBAL encode knobs (round7-export-profile.md §4d). These are the
 * profile-level twins of the override-level numeric guards in the override loop below — without this, a bad
 * GLOBAL effort/subsample/png-level/quality-alpha would slip straight to the codec (the App.tsx memo + the
 * worker read them off the top-level profile, not an override). Bounds + error-string style mirror the
 * override guards EXACTLY so the two paths can't drift:
 *   - effort:           [0,6] (matches override badEffort);
 *   - pngRecompressLevel:[0,6] (the @jsquash/oxipng level range);
 *   - avifSubsample:    an integer AND in AVIF_SUBSAMPLE_SET (matches override badSubsample, tighter on set);
 *   - avifQualityAlpha: -1 (the @jsquash "track quality" sentinel) or [0,100].
 * Pure; deterministic. Each violation is pushed into `errors` (no early return — surface them all at once).
 */
function validateGlobals(p: ExportProfile, errors: string[]): void {
  if (p.effort !== undefined && (!Number.isFinite(p.effort) || p.effort < 0 || p.effort > 6)) {
    errors.push(`badEffort: ${String(p.effort)} (must be in [0,6])`);
  }
  if (p.pngRecompressLevel !== undefined && (!Number.isFinite(p.pngRecompressLevel) || p.pngRecompressLevel < 0 || p.pngRecompressLevel > 6)) {
    errors.push(`badPngRecompressLevel: ${String(p.pngRecompressLevel)} (must be in [0,6])`);
  }
  if (p.avifSubsample !== undefined && (!Number.isInteger(p.avifSubsample) || !AVIF_SUBSAMPLE_SET.has(p.avifSubsample))) {
    errors.push(`badSubsample: ${String(p.avifSubsample)} (must be an integer in {0,1,2,3})`);
  }
  if (p.avifQualityAlpha !== undefined && (!Number.isFinite(p.avifQualityAlpha) || p.avifQualityAlpha < -1 || p.avifQualityAlpha > 100)) {
    errors.push(`badQualityAlpha: ${String(p.avifQualityAlpha)} (must be -1 or in [0,100])`);
  }
}

/**
 * Fail-closed validation of an export profile (design §4a). On success returns the formats in GIVEN
 * order plus the normalized (high→low, validateTiers) tier ladder; on failure the structured reason
 * list. The tier axis is delegated to validateTiers VERBATIM (so its errors are reused, never
 * duplicated). Rejects:
 *   - empty formats (nothing to emit);
 *   - a format outside png/webp/avif;
 *   - lossless:true on avif (no honest @jsquash lossless-avif path — never a faked-lossless);
 *   - quality outside [0,100] (when present);
 *   - near outside [0,100] (when present);
 *   - DUPLICATE targets — same (format, lossless, quality, near) — which would clobber each other;
 *   - a bad PROFILE-GLOBAL knob (effort/pngRecompressLevel/avifSubsample/avifQualityAlpha — validateGlobals);
 *   - every validateTiers rejection (delegated, errors prefixed so the source is clear).
 * Deterministic: formats kept in given order, tiers via validateTiers' stable high→low sort. Pure.
 */
export function validateProfile(p: ExportProfile): ProfileValidation {
  const errors: string[] = [];

  // ── Format axis (factored — shared with each override.formats so the rules can't drift) ──
  validateFormatList(p.formats, '', errors);

  // ── Profile-global encode knobs (fail-closed twins of the override numeric guards below) ──
  validateGlobals(p, errors);

  // ── Resolution axis (delegated to validateTiers — its errors are reused verbatim) ──
  const tv = validateTiers(tiersOf(p.tiers));
  if (!tv.ok) for (const e of tv.errors) errors.push(`tier ${e}`);

  // ── Override axis (round10-profile-overrides.md §4) — validated in the SAME pass so an invalid
  // override fails the WHOLE profile closed (the worker turns each reason into a `(profile)` skip). ──
  const overrides = p.overrides ?? [];
  overrides.forEach((o, i) => {
    const label = `override[${i}]`;
    if (o.match.trim() === '') errors.push(`${label}: emptyMatch (a blank match must never silently match)`);
    if (o.formats) validateFormatList(o.formats, `${label}.formats`, errors);
    if (o.quality !== undefined && (!Number.isFinite(o.quality) || o.quality < 0 || o.quality > 100)) {
      errors.push(`${label}: badQuality: ${String(o.quality)} (must be in [0,100])`);
    }
    if (o.near !== undefined && (!Number.isFinite(o.near) || o.near < 0 || o.near > 100)) {
      errors.push(`${label}: badNear: ${String(o.near)} (must be in [0,100])`);
    }
    if (o.effort !== undefined && (!Number.isFinite(o.effort) || o.effort < 0 || o.effort > 6)) {
      errors.push(`${label}: badEffort: ${String(o.effort)} (must be in [0,6])`);
    }
    if (o.avifSubsample !== undefined && !Number.isInteger(o.avifSubsample)) {
      errors.push(`${label}: badSubsample: ${String(o.avifSubsample)} (must be an integer)`);
    }
    // `lossless` needs no extra rule: overlayFormat drops it on avif (honesty preserved structurally) and
    // validateFormatList above already forbids lossless-avif inside o.formats.
  });

  if (errors.length > 0) return { ok: false, errors };
  // tv.ok is guaranteed here (any failure pushed into errors above).
  return { ok: true, formats: [...p.formats], tiers: tv.ok ? tv.tiers : [], overrides: [...overrides] };
}

/** Format token for multi-format fan-out naming. Empty when NOT multi (single-format ⇒ byte-identical
 *  legacy names — additivity load-bearing); otherwise the bare format extension ('.png'/'.webp'/'.avif')
 *  WITHOUT a leading dot stripped (it is a token inserted into a name, see variantManifestName). Pure. */
export function formatToken(mime: ImageMime, multi: boolean): string {
  return multi ? EXT[mime] : '';
}

/** Variant manifest / skeleton / `.atlas` name for a profile emit: insert the resolution suffix and (when
 *  multi-format) the format token BEFORE the manifest's own extension:
 *    variantManifestName('ui/btn.json', '_720p', 'image/webp', false) → 'ui/btn_720p.json'        (single)
 *    variantManifestName('ui/btn.json', '_720p', 'image/webp', true)  → 'ui/btn_720p.webp.json'   (multi)
 *  Single-format (multi=false) ⇒ legacy `_720p.json` name (byte-identical). Pure string math; the
 *  manifest's own extension (.json/.atlas) is preserved — only the format token (e.g. '.webp') is
 *  injected before it, never an image ext swap. Deterministic. */
export function variantManifestName(manifestPath: string, suffix: string, mime: ImageMime, multi: boolean): string {
  const dot = manifestPath.lastIndexOf('.');
  const ext = dot < 0 ? '' : manifestPath.slice(dot); // includes the leading dot, e.g. '.json'
  const stem = dot < 0 ? manifestPath : manifestPath.slice(0, dot);
  return `${stem}${suffix}${formatToken(mime, multi)}${ext}`;
}
