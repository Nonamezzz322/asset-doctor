// Unified build settings (settings-page design §3) — ONE pure state object covering the FULL fix-config
// surface the Settings page edits, plus the EXTRACTED buildOptions body (buildFixOptions) that maps it +
// the per-run FixCard state to the wire FixOptions. apps/web has NO React test harness (vitest env=node),
// so every load-bearing decision lives here and is unit-tested; the React side (settings-ctx.tsx /
// SettingsPage.tsx / FixCard) only reads state and delegates to patchSettings/buildFixOptions.
//
// BYTE-IDENTITY (design §8 B1, pinned by build-settings.test.ts): settingsDefaults() reproduces TODAY'S
// hardcoded behavior EXACTLY — buildFixOptions(settingsDefaults(), <empty per-run>) deep-equals the option
// bag App.tsx's buildOptions() produces today ({targetMime:'image/avif', quality:0.85, padding:2,
// maxSize:4096, maxEdge:2048, aggressive:false, polygon:false, every optional undefined}). The worker
// input is identical ⇒ the default run's zip is byte-identical.
//
// INVARIANTS: pure + deterministic (no Date.now/Math.random, no IO, no React). Backend-op toggles live
// here ONLY as live UI state — they are NEVER serialized (build-config.ts whitelist) and `backendConsent`
// is NOT here at all (per-run FixCard state — consent is never sticky; invariant 1/2). Nothing here
// generates or measures anything (invariant 3).
//
// NOTE on the import cycle with ./build-config: build-settings imports buildProfileFromState (the SINGLE
// UI→ExportProfile mapping) and build-config imports settingsDefaults (the SINGLE defaults source). Both
// are used strictly at CALL time (no top-level evaluation touches the other module), so the ESM cycle is
// benign — the alternative (duplicating either function) would reintroduce exactly the drift both modules
// exist to prevent.

import type { ExportFormat, LazyMarking, ResolutionTier, ScaleTier, SkinGuard } from '@asset-doctor/core';
import type { PackMode, StaticGranularity } from '@asset-doctor/ingest';
import { DEFAULT_SCALE_TIERS } from '@asset-doctor/fix';
import type { BackendOptions, FixOptions } from '../worker/fix-protocol';
import type { OpKind } from './op-manifest';
import type { ProfileFormatState, UiOverride } from './profile-ui-types';
import { buildProfileFromState } from './build-config';

/** Spine sheet-page format policy (design §0.1/§4): 'png' (DEFAULT) ⇒ today's runtime-safe PNG pages,
 *  wire field omitted ⇒ byte-identical; 'profile' ⇒ Spine repack/pack pages follow the export profile /
 *  legacy resolved target (the runtime must decode that format — Pixi does; surfaced honestly). */
export type SpinePageFormat = 'png' | 'profile';

/** The full user-editable build-config surface (builder-parity, honest browser subset — design §3).
 *  Grouped exactly like the Settings page cards. Every default (settingsDefaults) reproduces today's
 *  hardcoded behavior. Per-run state (fix phase, unlocked, marking, skinGuard, excludeKinds,
 *  backendConsent, backendReady) deliberately STAYS in FixCard — it is not a setting. */
export interface BuildSettings {
  // ── formats (export profile) — existing shapes, existing defaults ──
  profileEnable: boolean;
  profileFormats: Record<ExportFormat, ProfileFormatState>;
  customTiers: ResolutionTier[];
  profileOverrides: UiOverride[];
  /** AVIF chroma subsample (3=4:4:4, 1=4:2:2, 0=4:2:0); undefined ⇒ omitted ⇒ @jsquash default. */
  profileAvifSubsample: number | undefined;

  // ── defaults (the profile-OFF loose path) — replace the two buildOptions hardcodes ──
  /** Loose-transcode target when NO profile is active (was hardcoded 'image/avif'). */
  defaultTarget: ExportFormat;
  /** Loose-transcode quality 0..100 UI scale (wire = /100; was hardcoded 0.85 ⇒ 85). */
  defaultQuality: number;

  // ── encode globals ──
  /** Encoder effort 0(fast)..6(max); 0 ⇒ omitted (today's fast preset). */
  effort: number;
  scaleAwareQ: boolean;
  /** Legacy global WebP near-lossless toggle (wire 60 when on AND no profile — mutual exclusion). */
  webpNearLossless: boolean;
  /** Lossless oxipng recompress level 0..6; 0 ⇒ off (replaces the old boolean; old true ≙ level 2). */
  pngRecompressLevel: number;

  // ── rules ──
  aggressive: boolean;
  opaqueAlpha: boolean;
  bestFormatPerImage: boolean;
  /** DEFAULT ON — wire sends `false` only on opt-out (undefined ≙ on; keeps the default bag identical). */
  frameRedundancy: boolean;
  /** DEFAULT ON — wire sends `false` only on opt-out (undefined ≙ on; keeps the default bag identical). */
  trimMargin: boolean;
  /** Legacy per-folder overrides (profile-OFF loose/pack paths); quality 0..1 wire scale, as today. */
  overrides: { match: string; quality: number }[];

  // ── packing ──
  padding: number;
  maxSize: number;
  /** Edge-extrude (bleed) px, legal set {0,1,2}; 0 ⇒ no gutter (today). */
  extrude: number;
  packLoose: boolean;
  packMode: PackMode;
  packGranularity: StaticGranularity;
  packTrim: boolean;
  polygon: boolean;
  /** NEW (design §0.1): Spine repack/pack page format policy. 'png' (default) ⇒ wire field omitted ⇒
   *  byte-identical to today. */
  spinePageFormat: SpinePageFormat;

  // ── resize / resolutions ──
  maxEdge: number;
  tierEnable: boolean;
  /** The LOWER tiers opted into (scale-1 top is always implied). Array, NOT a Set — JSON-serializable;
   *  kept in the canonical DEFAULT_SCALE_TIERS high→low order. Mutually exclusive with the profile. */
  tierSuffixes: string[];

  // ── output ──
  hashFilenames: boolean;
  emitPixiManifest: boolean;
  includeFileSizes: 'off' | 'raw' | 'gzip';

  // ── backend ops (page UI; LIVE state only — NEVER serialized, consent stays per-run in FixCard) ──
  ktx2Enable: boolean;
  pngquantEnable: boolean;
  resampleEnable: boolean;
}

/** The default BuildSettings — reproduces TODAY'S behavior exactly (every value mirrors the current
 *  App.tsx useState initials + the five buildOptions hardcodes). Fresh objects on every call (no shared
 *  mutable state). This is the SINGLE source of defaults: build-config.ts backfills missing config keys
 *  from here, so the two can never drift. */
export function settingsDefaults(): BuildSettings {
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
    defaultTarget: 'image/avif',
    defaultQuality: 85,
    effort: 0,
    scaleAwareQ: false,
    webpNearLossless: false,
    pngRecompressLevel: 0,
    aggressive: false,
    opaqueAlpha: false,
    bestFormatPerImage: false,
    frameRedundancy: true,
    trimMargin: true,
    overrides: [],
    padding: 2,
    maxSize: 4096,
    extrude: 0,
    packLoose: false,
    packMode: 'auto',
    packGranularity: 'per-leaf-folder',
    packTrim: true,
    polygon: false,
    spinePageFormat: 'png',
    maxEdge: 2048,
    tierEnable: false,
    tierSuffixes: DEFAULT_SCALE_TIERS.filter((t) => t.scale < 1).map((t) => t.suffix),
    hashFilenames: false,
    emitPixiManifest: false,
    includeFileSizes: 'off',
    ktx2Enable: false,
    pngquantEnable: false,
    resampleEnable: false,
  };
}

/** Immutable patch: ALWAYS a fresh top-level object (load-bearing — the stale-plan reset effect keys on
 *  settings object identity, so every edit invalidates a pending plan). Shallow by design: a caller
 *  patching a nested array/record passes the replacement wholesale (same discipline as setState today). */
export function patchSettings(s: BuildSettings, p: Partial<BuildSettings>): BuildSettings {
  return { ...s, ...p };
}

/** The validated tier ladder (ports the App.tsx scaleTiers memo verbatim, `includes` over the string[]):
 *  always the scale-1 top tier (validateTiers requires it) plus every opted-in lower tier, in the
 *  canonical high→low DEFAULT_SCALE_TIERS order. [] when disabled. */
export function scaleTiersOf(s: BuildSettings): ScaleTier[] {
  return s.tierEnable
    ? DEFAULT_SCALE_TIERS.filter((tt) => tt.scale >= 1 || s.tierSuffixes.includes(tt.suffix))
    : [];
}

/** The per-run inputs FixCard owns (NOT settings — they depend on the loaded folder / license / this
 *  run's consent) and hands to buildFixOptions raw. The aggressive gating of marking/skinGuard lives
 *  INSIDE buildFixOptions (it reads s.aggressive), so callers never pre-gate. */
export interface PerRunOptions {
  /** OpKinds deselected in the Plan card (intra-plan state; empty ⇒ full fix). */
  excludeKinds: ReadonlySet<OpKind>;
  /** UI-supplied lazy/bundle marking (folder-dependent). */
  marking: LazyMarking;
  /** Declared key/value skins (folder-dependent). */
  skinGuard: SkinGuard;
  /** FixCard's buildBackendOptions() result — consent-gated per run, undefined unless EVERY backend
   *  precondition (enable + configured + healthz + per-run consent) is met. Passed through verbatim. */
  backend: BackendOptions | undefined;
  /** True iff the consented backend path will actually engage this run — drives the round12 auto-pair
   *  (emit the Pixi manifest so backend-produced files never ship orphaned). */
  backendWillUpload: boolean;
}

/** FixOptions + the `spinePageFormat` wire field (design §4). The worker-wiring commit (C2) adds the
 *  field to fix-protocol.ts's FixOptions; until then this intersection carries it (an extra optional
 *  property — assignable to FixOptions, dead/inert in the worker). Once fix-protocol.ts gains the field
 *  the intersection is redundant and harmless — no drift either way. */
export type BuildFixOptions = FixOptions & { spinePageFormat?: SpinePageFormat };

/** ONE source of truth for the FixOptions both the dry-run preview (mode:'plan') and the execute run
 *  (mode:'execute') send — the EXTRACTED App.tsx buildOptions body (verbatim port, design §3.2), now
 *  driven by BuildSettings instead of ~30 useStates. All omitted/false/empty values reproduce today's
 *  behavior in the worker. The mutual exclusions (webpNearLossless / scaleTiers omitted when an export
 *  profile is sent) are decided against ONE settings snapshot — strictly stronger than the old separate
 *  useStates. Pure + deterministic; pinned byte-identical at defaults by build-settings.test.ts. */
export function buildFixOptions(s: BuildSettings, run: PerRunOptions): BuildFixOptions {
  // ONE snapshot: the profile below is the SAME object the exclusions test against (no drift window).
  const exportProfile = buildProfileFromState(s);
  const scaleTiers = scaleTiersOf(s);
  // round12 auto-pair: a consented backend run emits new/changed files (.ktx2 sibling / re-compressed
  // PNG) that only load if the manifest maps them — force the manifest ON exactly like today.
  const effectiveEmitManifest = s.emitPixiManifest || run.backendWillUpload;
  const exclude = run.excludeKinds;
  return {
    targetMime: s.defaultTarget,
    quality: s.defaultQuality / 100,
    padding: s.padding,
    maxSize: s.maxSize,
    maxEdge: s.maxEdge,
    aggressive: s.aggressive,
    polygon: s.polygon,
    // Feature 2/3 — omitted/false/empty values reproduce today's behavior in the worker.
    effort: s.effort > 0 ? s.effort : undefined,
    scaleAwareQuality: s.scaleAwareQ || undefined,
    // ROUND7 T12: webpNearLossless is MUTUALLY EXCLUSIVE with an export profile — the profile carries its
    // own per-format near-lossless, so omit the legacy global knob when a profile is sent (no double-source).
    webpNearLossless: !exportProfile && s.webpNearLossless ? 60 : undefined,
    // Level knob (replaces the old boolean; 0 ⇒ off ⇒ undefined ⇒ identical; migrated true ≙ 2 ⇒ identical).
    pngRecompressLevel: s.pngRecompressLevel > 0 ? s.pngRecompressLevel : undefined,
    // Opaque-alpha (round15) — forwarded only when enabled; off ⇒ undefined ⇒ byte-identical to today.
    opaqueAlpha: s.opaqueAlpha || undefined,
    // Per-image MEASURED best-format pick (round17) — forwarded only when enabled; off ⇒ undefined.
    bestFormatPerImage: s.bestFormatPerImage || undefined,
    // Frame-redundancy aliasing (round19) — DEFAULT ON: the worker treats undefined as ON, so we only
    // send `false` on explicit opt-out (keeps the default bag byte-identical to today's absent field).
    frameRedundancy: s.frameRedundancy ? undefined : false,
    // Trim-margin → repack scheduling (round21 #0) — DEFAULT ON, same false-only-on-opt-out contract.
    trimMargin: s.trimMargin ? undefined : false,
    // Marking/skinGuard ride only under aggressive AND non-empty (the gate moved here from FixCard).
    marking: s.aggressive && Object.keys(run.marking).length > 0 ? run.marking : undefined,
    skinGuard: s.aggressive && Object.keys(run.skinGuard).length > 0 ? run.skinGuard : undefined,
    overrides: s.overrides.length > 0 ? s.overrides.filter((o) => o.match.trim() !== '') : undefined,
    // Feature 4 — only forwarded when explicitly enabled; off ⇒ undefined ⇒ no pack ops (today).
    packLoose: s.packLoose || undefined,
    packMode: s.packLoose ? s.packMode : undefined,
    packGranularity: s.packLoose ? s.packGranularity : undefined,
    packTrim: s.packLoose ? s.packTrim : undefined,
    // Scale-tier export — only when enabled AND a real lower tier is selected (the implied scale-1 top
    // alone would just rename). ROUND7 T12: MUTUALLY EXCLUSIVE with the export profile (sole source of
    // formats + resolutions when sent) — decided against the SAME exportProfile snapshot above.
    scaleTiers: !exportProfile && scaleTiers.length > 1 ? scaleTiers : undefined,
    // Config-driven export profile — undefined ⇒ byte-identical to today; validated fail-closed worker-side.
    exportProfile,
    // Edge-extrude (bleed) — only forwarded when > 0; off ⇒ undefined ⇒ no gutter (today).
    extrude: s.extrude > 0 ? s.extrude : undefined,
    // Selective fix — the deselected OpKinds (empty ⇒ undefined ⇒ full fix, byte-identical to today).
    excludeKinds: exclude.size > 0 ? [...exclude] : undefined,
    // PixiJS-v8 manifest — user-enabled OR backend auto-pair (round12); off + no backend ⇒ undefined.
    emitPixiManifest: effectiveEmitManifest || undefined,
    // includeFileSizes (round23 #2) — only when the manifest is actually emitted AND a real mode chosen.
    includeFileSizes: effectiveEmitManifest && s.includeFileSizes !== 'off' ? s.includeFileSizes : undefined,
    // Content-hash cache-busting (round9) — forwarded only when enabled.
    hashFilenames: s.hashFilenames || undefined,
    // Spine sheet-page format (design §0.1) — omitted on the 'png' default ⇒ the worker's whole branch
    // is dead ⇒ byte-identical; 'profile' ⇒ Spine repack/pack pages follow the profile/legacy target.
    spinePageFormat: s.spinePageFormat === 'profile' ? 'profile' : undefined,
    // OPT-IN backend — FixCard's consent-gated buildBackendOptions() result, passed through verbatim
    // (undefined unless enable+configured+healthz+per-run consent all hold ⇒ the path stays dead).
    backend: run.backend,
  };
}
