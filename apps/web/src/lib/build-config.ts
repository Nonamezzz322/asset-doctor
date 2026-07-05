// AB-R5 (v1) + settings-page design §6 (v2) — Build-config import/export (PURE, Node-testable). The user
// dials in the FULL BuildSettings surface (formats/quality/subsampling/tiers/overrides + defaults/rules/
// packing/resize/output + encode globals) on the Settings page; this module is the SINGLE place that
// (a) maps the granular UI state → the core ExportProfile (buildProfileFromState — the exportProfile memo
// calls THIS, so save/validate and the live run share ONE mapping, no drift), and (b) serializes/parses a
// versioned, fail-closed JSON config file the user can save/share/reload.
//
// INVARIANT COMPLIANCE: the serialized config carries ZERO asset bytes — only the numbers/strings/booleans
// the user already chose (invariant 1). No backend (invariant 2). We serialize/restore settings only —
// nothing measured/generated (invariant 3). Browser-only, additive: absent a loaded config the settings
// stay at settingsDefaults() ⇒ the default path is byte-identical (this module is NEVER imported by the
// worker).
//
// We serialize the GRANULAR UI state, NOT the derived ExportProfile (reverse-mapping the lossy profile is
// impossible — the mapping collapses ProfileFormatState.near→near:60 and folds the encode globals in).
// But VALIDATION still runs the rebuilt profile through the existing validateProfile (the SAME gate the
// live run uses) so a bad/old config is rejected, never crashes. parseBuildConfig NEVER throws — every
// failure is a fail-closed { ok:false, reasonKey } i18n key. Deterministic: no Date.now / Math.random;
// stable key order (§6 — pinned byte-exact by build-config.test.ts).
//
// DELIBERATELY NOT PERSISTED (and NEVER restored — parse always returns settingsDefaults() values for
// them): backend-op toggles (ktx2/pngquant/resample) and backendConsent (consent must be per-run —
// persisting it would violate "consent never sticky"); marking/excludeKinds (folder-/plan-dependent
// per-run state, not settings). NO localStorage auto-persist — explicit download/load only (design §0.2).

import { DEFAULT_SCALE_TIERS, validateProfile } from '@asset-doctor/fix';
import type { ExportProfile, ExportFormat, FormatTarget, ProfileOverride, ResolutionTier } from '@asset-doctor/core';
import type { PackMode, StaticGranularity } from '@asset-doctor/ingest';
import { FORMAT_KEYS, type ProfileFormatState, type OverrideMode, type UiOverride } from './profile-ui-types';
import { settingsDefaults, type BuildSettings, type SpinePageFormat } from './build-settings';

/** Forward-compat gate. v2 adds the defaults/rules/packing/resize/output sections + the pngRecompress
 *  boolean→pngRecompressLevel migration. A FUTURE (greater) version is rejected fail-closed, never
 *  silently mis-parsed. An OLDER version (v1) is accepted + backfilled (migrate-by-default-fill). */
export const BUILD_CONFIG_VERSION = 2;

/** The canonical LOWER-tier suffix ladder the tier UI offers (the preset DEFAULT_SCALE_TIERS minus the
 *  implied scale-1 top). tierSuffixes are serialized/parsed as the INTERSECTION with this ladder, in this
 *  canonical high→low order — unknown suffixes are dropped (the UI only offers the preset ladder). */
const LOWER_TIER_SUFFIXES: readonly string[] = DEFAULT_SCALE_TIERS.filter((t) => t.scale < 1).map((t) => t.suffix);

/** The on-disk serialized shape (v2, design §6 — key order below IS the serialized order). References UI
 *  types, NOT wire contracts (nothing in @asset-doctor/core changes). `kind` is the discriminator that
 *  rejects arbitrary JSON; `version` is the forward-compat gate. Backend-op toggles/consent are
 *  structurally ABSENT — they cannot round-trip even by accident. */
export interface BuildConfigFile {
  kind: 'asset-doctor/build-config';
  version: number;
  profile: {
    enabled: boolean;
    formats: Record<ExportFormat, ProfileFormatState>;
    customTiers: ResolutionTier[];
    overrides: UiOverride[];
    avifSubsample?: number; // 0|1|3 (undefined ⇒ key omitted)
  };
  defaults: { target: ExportFormat; quality: number };
  globals: { effort: number; scaleAwareQuality: boolean; pngRecompressLevel: number; webpNearLossless: boolean };
  rules: {
    aggressive: boolean;
    opaqueAlpha: boolean;
    stripMetadata: boolean;
    bestFormatPerImage: boolean;
    frameRedundancy: boolean;
    trimMargin: boolean;
    overrides: { match: string; quality: number }[];
  };
  packing: {
    padding: number;
    maxSize: number;
    extrude: number;
    packLoose: boolean;
    packMode: PackMode;
    packGranularity: StaticGranularity;
    packTrim: boolean;
    polygon: boolean;
    spinePageFormat: SpinePageFormat;
  };
  resize: { maxEdge: number; tierEnable: boolean; tierSuffixes: string[] };
  output: { hashFilenames: boolean; emitPixiManifest: boolean; includeFileSizes: 'off' | 'raw' | 'gzip' };
}

/** TRANSITIONAL (v1 App.tsx shape — removed with the settings-page App wiring commit): the legacy
 *  8-field useState slice the pre-migration FixCard still constructs/applies. serializeBuildConfig and
 *  buildProfileFromState keep accepting it so App.tsx compiles unchanged until the wiring commit swaps it
 *  for BuildSettings; a legacy save upgrades through settingsDefaults() (today's hardcodes ARE those
 *  defaults, so the upgraded file is truthful). */
export interface BuildConfigState {
  profileEnable: boolean;
  profileFormats: Record<ExportFormat, ProfileFormatState>;
  customTiers: ResolutionTier[];
  profileOverrides: UiOverride[];
  profileAvifSubsample: number | undefined;
  effort: number;
  scaleAwareQ: boolean;
  pngRecompress: boolean;
}

/** What parseBuildConfig returns: a COMPLETE (Partial-free) BuildSettings — every missing/invalid field
 *  backfilled from settingsDefaults(), backend-op toggles ALWAYS at their defaults (never restored) —
 *  plus the TRANSITIONAL legacy `pngRecompress` boolean view (level > 0) so the pre-migration App.tsx
 *  applyBuildConfig still compiles; dropped with the App wiring commit. */
export type ParsedBuildSettings = BuildSettings & { pngRecompress: boolean };

export type ParseResult =
  | { ok: true; state: ParsedBuildSettings; version: number }
  | { ok: false; reasonKey: string; detail?: string }; // reasonKey is an i18n key

/** The profile-relevant slice buildProfileFromState reads. Structural, so BOTH shapes satisfy it:
 *  BuildSettings carries `pngRecompressLevel`; the TRANSITIONAL legacy BuildConfigState carries the
 *  `pngRecompress` boolean (true ≙ level 2). When both are present the level WINS (the migration rule).
 *  Extra fields (the rest of BuildSettings) are ignored. */
export interface ProfileStateInput {
  profileEnable: boolean;
  profileFormats: Record<ExportFormat, ProfileFormatState>;
  customTiers: ResolutionTier[];
  profileOverrides: UiOverride[];
  profileAvifSubsample: number | undefined;
  effort: number;
  scaleAwareQ: boolean;
  /** v2 knob (BuildSettings): oxipng level 0..6, 0 = off. WINS over the legacy boolean when present. */
  pngRecompressLevel?: number;
  /** TRANSITIONAL legacy v1 boolean (true ≙ level 2) — pre-migration App.tsx compat only. */
  pngRecompress?: boolean;
}

// ── 1. buildProfileFromState — the SINGLE mapping UI state → core ExportProfile ──────────────────────
// VERBATIM port of the exportProfile memo body (App.tsx). The memo calls this (one source of truth ⇒ no
// save/run drift — "exactly what will be applied"). Returns the SAME ExportProfile the worker consumes:
// formats in canonical FORMAT_KEYS order (PNG, WebP, AVIF); tiers = implied scale-1 top + custom rows;
// per-format compression (PNG native-lossless unless pngLossy; WebP/AVIF quality unless lossless; WebP near
// →60); global knobs folded in at their EXACT legacy predicate (effort>0 ⇒ set; scaleAwareQuality;
// pngRecompressLevel>0 ⇒ set — byte-identical for default(0)/migrated-true(2)); avifSubsample omitted when
// undefined; overrides omitted when empty. Pure, deterministic.
//
// Returns undefined when disabled OR no format selected (matches the memo — never builds a known-bad
// empty-formats profile). The caller (memo) only invokes this when profileEnable is true, but the
// disabled/empty guards stay here so parseBuildConfig can validate a saved-but-disabled config too.
export function buildProfileFromState(s: ProfileStateInput): ExportProfile | undefined {
  if (!s.profileEnable) return undefined;
  const formats: FormatTarget[] = FORMAT_KEYS.filter(({ mime }) => s.profileFormats[mime].enabled).map(({ mime }) => {
    const f = s.profileFormats[mime];
    if (mime === 'image/png') return { format: mime, ...(f.pngLossy ? { pngLossy: true } : {}) }; // native lossless unless pngLossy (round13 pngquant)
    if (mime === 'image/webp') return { format: mime, ...(f.lossless ? { lossless: true } : { quality: f.quality, ...(f.near ? { near: 60 } : {}) }) };
    return { format: mime, quality: f.quality }; // AVIF: lossy only (UI disables lossless)
  });
  if (formats.length === 0) return undefined;
  const tiers: ResolutionTier[] = [{ label: '1080p (full)', scale: 1, suffix: '_1080p' }, ...s.customTiers];
  // round10-profile-overrides.md §6: map the UI rules → core ProfileOverride[]. Drop blank-match rows (a
  // half-typed row must never silently match). fonts444 ⇒ REPLACE formats with one AVIF target + merge
  // avifSubsample:3 (the headline 4:4:4); lossless ⇒ a lossless overlay; quality ⇒ a quality overlay.
  // OMIT the `overrides` field entirely when empty ⇒ the worker resolver no-ops ⇒ byte-identical (additive).
  const overrides: ProfileOverride[] = s.profileOverrides
    .filter((o) => o.match.trim() !== '')
    .map((o) =>
      o.mode === 'fonts444'
        ? { match: o.match, formats: [{ format: 'image/avif', quality: o.quality ?? 85 }], avifSubsample: 3 }
        : o.mode === 'lossless'
          ? { match: o.match, lossless: true }
          : { match: o.match, quality: o.quality ?? 85 },
    );
  // The png-recompress fold: the v2 LEVEL wins when present; the legacy boolean maps true ≙ 2 (the exact
  // old predicate) — so default(level 0 / boolean false) omits, migrated-true carries 2, byte-identical.
  const pngLevel = s.pngRecompressLevel ?? (s.pngRecompress ? 2 : 0);
  // Profile-GLOBAL encode knobs — fold the SHARED encode-globals state into the profile. Each is OMITTED at
  // its default with the EXACT legacy predicate so a freshly-enabled, untouched profile stays byte-identical.
  // avifSubsample is set only when chosen.
  return {
    formats,
    tiers,
    ...(s.effort > 0 ? { effort: s.effort } : {}),
    ...(s.scaleAwareQ ? { scaleAwareQuality: true } : {}),
    ...(pngLevel > 0 ? { pngRecompressLevel: pngLevel } : {}),
    ...(s.profileAvifSubsample !== undefined ? { avifSubsample: s.profileAvifSubsample } : {}),
    ...(overrides.length > 0 ? { overrides } : {}),
  };
}

/** TRANSITIONAL upgrade of the legacy 8-field slice to a full BuildSettings: profile + encode globals
 *  applied, EVERYTHING else at settingsDefaults() — truthful, because the pre-migration App hardcodes
 *  exactly those defaults (padding 2 / maxSize 4096 / maxEdge 2048 / avif q85 / …). */
function upgradeLegacyState(s: BuildConfigState): BuildSettings {
  return {
    ...settingsDefaults(),
    profileEnable: s.profileEnable,
    profileFormats: s.profileFormats,
    customTiers: s.customTiers,
    profileOverrides: s.profileOverrides,
    profileAvifSubsample: s.profileAvifSubsample,
    effort: s.effort,
    scaleAwareQ: s.scaleAwareQ,
    pngRecompressLevel: s.pngRecompress ? 2 : 0,
  };
}

const isSettings = (s: BuildSettings | BuildConfigState): s is BuildSettings => 'pngRecompressLevel' in s;

// ── 2. serializeBuildConfig — pure, deterministic. Stable key order, 2-space JSON ───────────────────
// Builds a v2 BuildConfigFile from the live state in the FIXED §6 key order (kind, version, profile,
// defaults, globals, rules, packing, resize, output — each section's keys rebuilt explicitly) so the same
// state always serializes byte-identically (pinned by test). avifSubsample is OMITTED (key absent) when
// undefined. tierSuffixes are canonicalized to the preset-ladder order (deterministic — a Set-backed UI
// has no order to preserve). Backend-op toggles/consent are NEVER read here (whitelist by construction).
// No Date.now/Math.random.
export function serializeBuildConfig(state: BuildSettings | BuildConfigState): string {
  const s = isSettings(state) ? state : upgradeLegacyState(state);
  // Format entries are rebuilt key-by-key in a fixed order so two states with same values but different
  // object-key insertion order still serialize identically. pngLossy is OMITTED when undefined (PNG-only
  // knob; WebP/AVIF never carry it) so the round-trip is lossless (parse omits it back to undefined).
  const fmt = (f: ProfileFormatState): ProfileFormatState => ({
    enabled: f.enabled,
    quality: f.quality,
    lossless: f.lossless,
    near: f.near,
    ...(f.pngLossy !== undefined ? { pngLossy: f.pngLossy } : {}),
  });
  const file: BuildConfigFile = {
    kind: 'asset-doctor/build-config',
    version: BUILD_CONFIG_VERSION,
    profile: {
      enabled: s.profileEnable,
      formats: {
        'image/png': fmt(s.profileFormats['image/png']),
        'image/webp': fmt(s.profileFormats['image/webp']),
        'image/avif': fmt(s.profileFormats['image/avif']),
      },
      customTiers: s.customTiers.map((t) => ({ label: t.label, scale: t.scale, suffix: t.suffix })),
      overrides: s.profileOverrides.map((o) => ({ match: o.match, mode: o.mode, quality: o.quality })),
      ...(s.profileAvifSubsample !== undefined ? { avifSubsample: s.profileAvifSubsample } : {}),
    },
    defaults: { target: s.defaultTarget, quality: s.defaultQuality },
    globals: {
      effort: s.effort,
      scaleAwareQuality: s.scaleAwareQ,
      pngRecompressLevel: s.pngRecompressLevel,
      webpNearLossless: s.webpNearLossless,
    },
    rules: {
      aggressive: s.aggressive,
      opaqueAlpha: s.opaqueAlpha,
      stripMetadata: s.stripMetadata,
      bestFormatPerImage: s.bestFormatPerImage,
      frameRedundancy: s.frameRedundancy,
      trimMargin: s.trimMargin,
      overrides: s.overrides.map((o) => ({ match: o.match, quality: o.quality })),
    },
    packing: {
      padding: s.padding,
      maxSize: s.maxSize,
      extrude: s.extrude,
      packLoose: s.packLoose,
      packMode: s.packMode,
      packGranularity: s.packGranularity,
      packTrim: s.packTrim,
      polygon: s.polygon,
      spinePageFormat: s.spinePageFormat,
    },
    resize: {
      maxEdge: s.maxEdge,
      tierEnable: s.tierEnable,
      tierSuffixes: LOWER_TIER_SUFFIXES.filter((suf) => s.tierSuffixes.includes(suf)),
    },
    output: {
      hashFilenames: s.hashFilenames,
      emitPixiManifest: s.emitPixiManifest,
      includeFileSizes: s.includeFileSizes,
    },
  };
  return JSON.stringify(file, null, 2);
}

// ── 4. pickSettings — coerce arbitrary parsed object → COMPLETE BuildSettings (pure) ─────────────────
// DROP unknown/extra keys, BACKFILL missing ones from settingsDefaults(), CLAMP/COERCE wrong-typed fields
// (design §6.3) so validateProfile (in parse) gets a well-typed profile to judge — never a TypeError here
// (fail-closed there, not here). Forward-compat tolerant (extra keys silently dropped); partial-config +
// v1-config tolerant (missing keys/sections backfilled; globals.pngRecompress:true migrates to level 2,
// the v2 pngRecompressLevel WINNING when present). Backend-op toggles are NOT read — they are ALWAYS the
// settingsDefaults() values (never restored from a file). Pure, deterministic.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
/** Integer clamp: a finite number is rounded + clamped into [lo,hi]; anything else ⇒ the default. */
const clampInt = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
/** Closed string-enum coercion: keep a listed value verbatim, anything else ⇒ the default. */
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d;

/** Coerce one format entry, backfilling from the per-format default. pngLossy stays optional (kept only when
 *  a real boolean). */
function pickFormat(v: unknown, def: ProfileFormatState): ProfileFormatState {
  const o = isObj(v) ? v : {};
  const out: ProfileFormatState = {
    enabled: bool(o.enabled, def.enabled),
    quality: num(o.quality, def.quality),
    lossless: bool(o.lossless, def.lossless),
    near: bool(o.near, def.near),
  };
  if (typeof o.pngLossy === 'boolean') out.pngLossy = o.pngLossy;
  else if (def.pngLossy !== undefined) out.pngLossy = def.pngLossy;
  return out;
}

/** Coerce a custom-tier entry. Non-object ⇒ a zeroed placeholder (validateTiers fails it closed — never a
 *  TypeError). label is presentation-only; scale/suffix carry the validated geometry. */
function pickTier(v: unknown): ResolutionTier {
  const o = isObj(v) ? v : {};
  return { label: str(o.label, ''), scale: num(o.scale, NaN), suffix: str(o.suffix, '') };
}

/** Coerce a UI override row. An unknown mode falls back to 'quality' (a typed value validateProfile can
 *  still judge); quality kept only when a real number. */
function pickOverride(v: unknown): UiOverride {
  const o = isObj(v) ? v : {};
  const m = o.mode;
  const mode: OverrideMode = m === 'fonts444' || m === 'lossless' || m === 'quality' ? m : 'quality';
  const out: UiOverride = { match: str(o.match, ''), mode };
  if (typeof o.quality === 'number' && Number.isFinite(o.quality)) out.quality = o.quality;
  return out;
}

/** Coerce a legacy per-folder override row (rules.overrides). Rows without a string match are dropped;
 *  quality is a wire-scale number clamped into [0,1], else the legacy 0.85 default. */
function pickLegacyOverride(v: unknown): { match: string; quality: number } | null {
  if (!isObj(v) || typeof v.match !== 'string') return null;
  const quality =
    typeof v.quality === 'number' && Number.isFinite(v.quality) ? Math.min(1, Math.max(0, v.quality)) : 0.85;
  return { match: v.match, quality };
}

export function pickSettings(raw: unknown): BuildSettings {
  const def = settingsDefaults();
  const root = isObj(raw) ? raw : {};
  const profile = isObj(root.profile) ? root.profile : {};
  const defaults = isObj(root.defaults) ? root.defaults : {};
  const globals = isObj(root.globals) ? root.globals : {};
  const rules = isObj(root.rules) ? root.rules : {};
  const packing = isObj(root.packing) ? root.packing : {};
  const resize = isObj(root.resize) ? root.resize : {};
  const output = isObj(root.output) ? root.output : {};
  const fmtsIn = isObj(profile.formats) ? profile.formats : {};

  const tiers = Array.isArray(profile.customTiers) ? profile.customTiers.map(pickTier) : def.customTiers;
  const overrides = Array.isArray(profile.overrides) ? profile.overrides.map(pickOverride) : def.profileOverrides;
  const sub = profile.avifSubsample;

  // v1→v2 png-recompress migration: the v2 LEVEL (finite number, clamped 0..6) WINS when present;
  // else the v1 boolean maps true ⇒ 2 (the exact old wire value), false/absent ⇒ 0 (off).
  const pngLevelRaw = globals.pngRecompressLevel;
  const pngRecompressLevel =
    typeof pngLevelRaw === 'number' && Number.isFinite(pngLevelRaw)
      ? clampInt(pngLevelRaw, 0, 6, 0)
      : globals.pngRecompress === true
        ? 2
        : 0;

  // extrude: legal set {0,1,2} (the ExtrudePanel values) — anything else falls back to 0 (off).
  const extrudeRaw = num(packing.extrude, 0);
  const extrude = extrudeRaw === 1 || extrudeRaw === 2 ? extrudeRaw : 0;

  // tierSuffixes: intersect with the preset lower-tier ladder in canonical high→low order (unknown
  // suffixes dropped — the tier UI only offers the preset ladder). An explicit [] is preserved.
  const tierSuffixesIn = resize.tierSuffixes;
  const tierSuffixes = Array.isArray(tierSuffixesIn)
    ? LOWER_TIER_SUFFIXES.filter((suf) => (tierSuffixesIn as unknown[]).includes(suf))
    : def.tierSuffixes;

  const legacyOverrides = Array.isArray(rules.overrides)
    ? rules.overrides.map(pickLegacyOverride).filter((o): o is { match: string; quality: number } => o !== null)
    : def.overrides;

  return {
    profileEnable: bool(profile.enabled, def.profileEnable),
    profileFormats: {
      'image/png': pickFormat(fmtsIn['image/png'], def.profileFormats['image/png']),
      'image/webp': pickFormat(fmtsIn['image/webp'], def.profileFormats['image/webp']),
      'image/avif': pickFormat(fmtsIn['image/avif'], def.profileFormats['image/avif']),
    },
    customTiers: tiers,
    profileOverrides: overrides,
    // Keep a numeric subsample verbatim (validateProfile is the gate for the {0,1,2,3} set); anything else
    // ⇒ undefined (omitted), the default.
    profileAvifSubsample: typeof sub === 'number' && Number.isFinite(sub) ? sub : undefined,
    defaultTarget: oneOf<ExportFormat>(defaults.target, ['image/png', 'image/webp', 'image/avif'], def.defaultTarget),
    defaultQuality: clampInt(defaults.quality, 0, 100, def.defaultQuality),
    effort: clampInt(globals.effort, 0, 6, def.effort),
    scaleAwareQ: bool(globals.scaleAwareQuality, def.scaleAwareQ),
    webpNearLossless: bool(globals.webpNearLossless, def.webpNearLossless),
    pngRecompressLevel,
    aggressive: bool(rules.aggressive, def.aggressive),
    opaqueAlpha: bool(rules.opaqueAlpha, def.opaqueAlpha),
    stripMetadata: bool(rules.stripMetadata, def.stripMetadata),
    bestFormatPerImage: bool(rules.bestFormatPerImage, def.bestFormatPerImage),
    frameRedundancy: bool(rules.frameRedundancy, def.frameRedundancy),
    trimMargin: bool(rules.trimMargin, def.trimMargin),
    overrides: legacyOverrides,
    padding: clampInt(packing.padding, 0, 32, def.padding),
    maxSize: clampInt(packing.maxSize, 128, 8192, def.maxSize),
    extrude,
    packLoose: bool(packing.packLoose, def.packLoose),
    packMode: oneOf<PackMode>(packing.packMode, ['auto', 'force-static', 'force-spine'], def.packMode),
    packGranularity: oneOf<StaticGranularity>(
      packing.packGranularity,
      ['per-leaf-folder', 'one-sheet-for-all', 'per-top-level-bundle'],
      def.packGranularity,
    ),
    packTrim: bool(packing.packTrim, def.packTrim),
    polygon: bool(packing.polygon, def.polygon),
    spinePageFormat: oneOf<SpinePageFormat>(packing.spinePageFormat, ['png', 'profile'], def.spinePageFormat),
    maxEdge: clampInt(resize.maxEdge, 128, 16384, def.maxEdge),
    tierEnable: bool(resize.tierEnable, def.tierEnable),
    tierSuffixes,
    hashFilenames: bool(output.hashFilenames, def.hashFilenames),
    emitPixiManifest: bool(output.emitPixiManifest, def.emitPixiManifest),
    includeFileSizes: oneOf<'off' | 'raw' | 'gzip'>(output.includeFileSizes, ['off', 'raw', 'gzip'], def.includeFileSizes),
    // NEVER restored (invariant: consent per-run; backend opt-in never sticky via a shared file) — the
    // defaults (all off) regardless of any injected keys in the file.
    ktx2Enable: def.ktx2Enable,
    pngquantEnable: def.pngquantEnable,
    resampleEnable: def.resampleEnable,
  };
}

// ── 3. parseBuildConfig — never throws; fail-closed via the EXISTING validateProfile ────────────────
// a. JSON.parse in try/catch        → fix.config.err.malformed
// b. typeof !== object / null/array → fix.config.err.notObject
// c. kind mismatch                  → fix.config.err.wrongKind
// d. non-integer / FUTURE version   → fix.config.err.version (detail: the version); v1 accepted+migrated
// e. coerce with pickSettings (defaults for missing, dropped extras, clamped wrong types, v1 migration)
// f. validateProfile(buildProfileForValidation(coerced)) — the SAME gate the live run uses:
//    invalid ⇒ fix.config.err.invalid (detail = joined validator errors); else ⇒ ok.
export function parseBuildConfig(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reasonKey: 'fix.config.err.malformed' };
  }
  if (!isObj(raw)) return { ok: false, reasonKey: 'fix.config.err.notObject' };
  if (raw.kind !== 'asset-doctor/build-config') return { ok: false, reasonKey: 'fix.config.err.wrongKind' };
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version > BUILD_CONFIG_VERSION) {
    return { ok: false, reasonKey: 'fix.config.err.version', detail: String(version) };
  }

  const settings = pickSettings(raw);

  // Validate the REBUILT profile through the EXISTING fail-closed gate (validateProfile — the SAME gate the
  // live run uses), so a bad/old config is rejected, never crashes. The profile to judge:
  //  - profileEnable: true  ⇒ validate the full as-if-enabled profile WITH a possibly-empty formats array,
  //    so the validator is the sole judge (empty formats ⇒ emptyFormats reject; bad suffix ⇒ tier badSuffix;
  //    bad global subsample ⇒ badSubsample; etc.).
  //  - profileEnable: false ⇒ validate ONLY when ≥1 format is selected (so a saved-but-disabled BAD config is
  //    still caught, edge case 8) — but a disabled config with no usable formats is NEVER blocked (it applies
  //    fine, off). The disabled flag itself is always applied as-is on success (loading never forces it on).
  const anyFormat = FORMAT_KEYS.some(({ mime }) => settings.profileFormats[mime].enabled);
  if (settings.profileEnable || anyFormat) {
    const profile = buildProfileForValidation(settings);
    const v = validateProfile(profile);
    if (!v.ok) return { ok: false, reasonKey: 'fix.config.err.invalid', detail: v.errors.join('; ') };
  }
  // The TRANSITIONAL legacy boolean view (level > 0) rides along for the pre-migration App.tsx apply path.
  // `version` is surfaced so the caller can WARN (never silently) when an OLDER config is applied as a full
  // snapshot: its sections added after that version are restored to their defaults (pickSettings backfill).
  return { ok: true, state: { ...settings, pngRecompress: settings.pngRecompressLevel > 0 }, version };
}

// The profile validateProfile judges on load. Mirrors buildProfileFromState's mapping EXACTLY but WITHOUT
// its memo short-circuits (disabled / empty-formats ⇒ undefined): validation always sees a concrete profile
// with a (possibly-empty) formats array so the validator — not this function — owns every reject (the
// emptyFormats rule fires for an enabled profile with no selected format, which buildProfileFromState would
// otherwise hide behind `undefined`). Pure, deterministic; reuses buildProfileFromState's logic by forcing
// enabled, then handing an explicit empty-formats profile when no format is selected.
function buildProfileForValidation(s: BuildSettings): ExportProfile {
  const built = buildProfileFromState({ ...s, profileEnable: true });
  if (built) return built;
  return { formats: [], tiers: [{ label: '1080p (full)', scale: 1, suffix: '_1080p' }, ...s.customTiers] };
}
