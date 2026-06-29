// AB-R5 — Build-config import/export (PURE, Node-testable). The user dials in formats / quality /
// subsampling / scale-tiers / overrides + global encode knobs in the ExportProfilePanel; this module is
// the SINGLE place that (a) maps that granular UI state → the core ExportProfile (buildProfileFromState —
// the exportProfile memo in App.tsx calls THIS, so save/validate and the live run share ONE mapping, no
// drift), and (b) serializes/parses a versioned, fail-closed JSON config file the user can save/share/reload.
//
// INVARIANT COMPLIANCE: the serialized config carries ZERO asset bytes — only the numbers/strings/booleans
// the user already chose (invariant 1). No backend (invariant 2). We serialize/restore settings only —
// nothing measured/generated (invariant 3). Browser-only, additive: absent a loaded config every useState
// stays at its default ⇒ the default path is byte-identical (this module is NEVER imported by the worker).
//
// We serialize the GRANULAR UI state, NOT the derived ExportProfile (reverse-mapping the lossy profile is
// impossible — the memo collapses ProfileFormatState.near→near:60 and folds the SettingsPanel globals in).
// But VALIDATION still runs the rebuilt profile through the existing validateProfile (the SAME gate the live
// run uses) so a bad/old config is rejected, never crashes. parseBuildConfig NEVER throws — every failure is
// a fail-closed { ok:false, reasonKey } i18n key. Deterministic: no Date.now / Math.random; stable key order.
//
// DELIBERATELY NOT PERSISTED (v1): backend-op toggles (ktx2/pngquant/resample), backendConsent (consent must
// be per-run — persisting it would violate "consent never sticky"), and the separate Pro toggles
// (packLoose/hashFilenames/emitPixiManifest/aggressive/marking/excludeKinds). A later slice can extend the
// schema additively via the version field. NO localStorage auto-persist — explicit download/load only.

import { validateProfile } from '@asset-doctor/fix';
import type { ExportProfile, ExportFormat, FormatTarget, ProfileOverride, ResolutionTier } from '@asset-doctor/core';
import { FORMAT_KEYS, type ProfileFormatState, type OverrideMode, type UiOverride } from './profile-ui-types';

/** Forward-compat gate. v1 has only version 1; a FUTURE (greater) version is rejected fail-closed, never
 *  silently mis-parsed. An OLDER version is accepted + backfilled (the migrate-by-default-fill hook). */
export const BUILD_CONFIG_VERSION = 1;

/** The on-disk serialized shape. References UI types, NOT wire contracts (nothing in @asset-doctor/core
 *  changes). `kind` is the discriminator that rejects arbitrary JSON; `version` is the forward-compat gate. */
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
  globals: { effort: number; scaleAwareQuality: boolean; pngRecompress: boolean };
}

/** What App passes in / gets back — the live useState slice the panel + SettingsPanel globals own. */
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

export type ParseResult =
  | { ok: true; state: BuildConfigState }
  | { ok: false; reasonKey: string; detail?: string }; // reasonKey is an i18n key

/** The default UI state (mirrors App.tsx's initial useState for the profile panel + globals). The SINGLE
 *  source of the defaults pickState backfills MISSING keys from, so a partial config round-trips. Fresh
 *  objects every call (no shared mutable state). */
function profileDefaults(): BuildConfigState {
  return {
    profileEnable: false,
    profileFormats: {
      'image/png': { enabled: false, quality: 85, lossless: true, near: false, pngLossy: false },
      'image/webp': { enabled: false, quality: 85, lossless: false, near: false },
      'image/avif': { enabled: true, quality: 85, lossless: false, near: false },
    },
    customTiers: [],
    profileOverrides: [],
    profileAvifSubsample: undefined,
    effort: 0,
    scaleAwareQ: false,
    pngRecompress: false,
  };
}

// ── 1. buildProfileFromState — the SINGLE mapping UI state → core ExportProfile ──────────────────────
// VERBATIM port of the exportProfile memo body (App.tsx). The memo now calls this (one source of truth ⇒
// no save/run drift — "exactly what will be applied"). Returns the SAME ExportProfile the worker consumes:
// formats in canonical FORMAT_KEYS order (PNG, WebP, AVIF); tiers = implied scale-1 top + custom rows;
// per-format compression (PNG native-lossless unless pngLossy; WebP/AVIF quality unless lossless; WebP near
// →60); global knobs folded in at their EXACT legacy predicate (effort>0 ⇒ set; scaleAwareQuality; png →
// level 2); avifSubsample omitted when undefined; overrides omitted when empty. Pure, deterministic.
//
// Returns undefined when disabled OR no format selected (matches the memo — never builds a known-bad
// empty-formats profile). The caller (memo) only invokes this when profileEnable is true, but the
// disabled/empty guards stay here so parseBuildConfig can validate a saved-but-disabled config too.
export function buildProfileFromState(s: BuildConfigState): ExportProfile | undefined {
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
  // Profile-GLOBAL encode knobs — fold the SHARED SettingsPanel state into the profile. Each is OMITTED at
  // its default with the EXACT legacy predicate (effort>0 ⇒ set; scaleAwareQuality ⇒ true; pngRecompress ⇒ 2)
  // so a freshly-enabled, untouched profile stays byte-identical. avifSubsample is set only when chosen.
  return {
    formats,
    tiers,
    ...(s.effort > 0 ? { effort: s.effort } : {}),
    ...(s.scaleAwareQ ? { scaleAwareQuality: true } : {}),
    ...(s.pngRecompress ? { pngRecompressLevel: 2 } : {}),
    ...(s.profileAvifSubsample !== undefined ? { avifSubsample: s.profileAvifSubsample } : {}),
    ...(overrides.length > 0 ? { overrides } : {}),
  };
}

// ── 2. serializeBuildConfig — pure, deterministic. Stable key order, 2-space JSON ───────────────────
// Builds a BuildConfigFile from the live state in a FIXED key order (kind, version, profile{enabled,
// formats(PNG,WebP,AVIF), customTiers, overrides, avifSubsample}, globals{effort, scaleAwareQuality,
// pngRecompress}) so the same state always serializes byte-identically (testable). avifSubsample is OMITTED
// (key absent) when undefined. No Date.now/Math.random.
export function serializeBuildConfig(s: BuildConfigState): string {
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
    globals: { effort: s.effort, scaleAwareQuality: s.scaleAwareQ, pngRecompress: s.pngRecompress },
  };
  return JSON.stringify(file, null, 2);
}

// ── 4. pickState — coerce arbitrary parsed object → BuildConfigState (pure) ──────────────────────────
// DROP unknown/extra keys, BACKFILL missing ones from profileDefaults(), and CLAMP wrong-typed fields so
// validateProfile (in parse) gets a well-typed profile to judge — never a TypeError here (fail-closed there,
// not here). Forward-compat tolerant (extra keys silently dropped); partial-config tolerant (missing keys
// backfilled). Pure, deterministic.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);

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

export function pickState(raw: unknown): BuildConfigState {
  const def = profileDefaults();
  const root = isObj(raw) ? raw : {};
  const profile = isObj(root.profile) ? root.profile : {};
  const globals = isObj(root.globals) ? root.globals : {};
  const fmtsIn = isObj(profile.formats) ? profile.formats : {};

  const tiers = Array.isArray(profile.customTiers) ? profile.customTiers.map(pickTier) : def.customTiers;
  const overrides = Array.isArray(profile.overrides) ? profile.overrides.map(pickOverride) : def.profileOverrides;
  const sub = profile.avifSubsample;

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
    effort: num(globals.effort, def.effort),
    scaleAwareQ: bool(globals.scaleAwareQuality, def.scaleAwareQ),
    pngRecompress: bool(globals.pngRecompress, def.pngRecompress),
  };
}

// ── 3. parseBuildConfig — never throws; fail-closed via the EXISTING validateProfile ────────────────
// a. JSON.parse in try/catch        → fix.config.err.malformed
// b. typeof !== object / null/array → fix.config.err.notObject
// c. kind mismatch                  → fix.config.err.wrongKind
// d. non-integer / FUTURE version   → fix.config.err.version (detail: the version)
// e. coerce with pickState (defaults for missing, dropped extras, clamped wrong types)
// f. validateProfile(buildProfileFromState(coerced)) — the SAME gate the live run uses:
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

  const state = pickState(raw);

  // Validate the REBUILT profile through the EXISTING fail-closed gate (validateProfile — the SAME gate the
  // live run uses), so a bad/old config is rejected, never crashes. The profile to judge:
  //  - profileEnable: true  ⇒ validate the full as-if-enabled profile WITH a possibly-empty formats array,
  //    so the validator is the sole judge (empty formats ⇒ emptyFormats reject; bad suffix ⇒ tier badSuffix;
  //    bad global subsample ⇒ badSubsample; etc.).
  //  - profileEnable: false ⇒ validate ONLY when ≥1 format is selected (so a saved-but-disabled BAD config is
  //    still caught, edge case 8) — but a disabled config with no usable formats is NEVER blocked (it applies
  //    fine, off). The disabled flag itself is always applied as-is on success (loading never forces it on).
  const anyFormat = FORMAT_KEYS.some(({ mime }) => state.profileFormats[mime].enabled);
  if (state.profileEnable || anyFormat) {
    const profile = buildProfileForValidation(state);
    const v = validateProfile(profile);
    if (!v.ok) return { ok: false, reasonKey: 'fix.config.err.invalid', detail: v.errors.join('; ') };
  }
  return { ok: true, state };
}

// The profile validateProfile judges on load. Mirrors buildProfileFromState's mapping EXACTLY but WITHOUT
// its memo short-circuits (disabled / empty-formats ⇒ undefined): validation always sees a concrete profile
// with a (possibly-empty) formats array so the validator — not this function — owns every reject (the
// emptyFormats rule fires for an enabled profile with no selected format, which buildProfileFromState would
// otherwise hide behind `undefined`). Pure, deterministic; reuses buildProfileFromState's logic by forcing
// enabled, then handing an explicit empty-formats profile when no format is selected.
function buildProfileForValidation(s: BuildConfigState): ExportProfile {
  const built = buildProfileFromState({ ...s, profileEnable: true });
  if (built) return built;
  return { formats: [], tiers: [{ label: '1080p (full)', scale: 1, suffix: '_1080p' }, ...s.customTiers] };
}
