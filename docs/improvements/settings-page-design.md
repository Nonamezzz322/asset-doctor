# DESIGN (final, skeptic-verified): unified BuildSettings + dedicated Settings page + sheet-format wiring

Status: APPROVED WITH CORRECTIONS. Every brief premise was re-verified against the live code on
branch `feat/asset-pipeline` (line numbers below are CURRENT as of this verification). Corrections to
the brief are marked ⚠CORRECTION. Open questions are RULED below (§0). Four implementation agents can
work from this document without re-deriving decisions.

Gate for every commit: `export PATH="$HOME/.local/bin:$PATH" && pnpm typecheck && pnpm test && pnpm lint`.
No new runtime deps. No git commit/push by agents other than as instructed by the orchestrator.

---

## 0. RULINGS on the two open questions

### 0.1 Repack/merge page format when the profile is OFF → **keep today's webp-lossless hardcode, UNCONDITIONALLY**

Rule (per call site, all decided by ONE pure helper, §4):

| Site | profile ON (per-ref resolved) | profile OFF |
|---|---|---|
| STATIC repack + MERGE (`fix.worker.ts:2184-2190`) | `resolveProfile(ref).formats[0]` via `formatEncode(fmt, 1, rp.global)` → `feToEncodeOpts`; if per-ref formats.length > 1 ⇒ STILL formats[0] + one honest `skipped[]` note per sheet | **`image/webp` + `{lossless:true, allowPngFallback:true}` — today's bytes, always** |
| PACK static pages (`:2845-2847, :2872`) | same `formats[0]` rule as above | legacy `resolveOptions(group.outDir,'loose',baseEffective,opts.overrides).targetMime` + `encOptsFor(eff,true)` — today's path (which now reads `settings.defaultTarget` through `opts.targetMime`, default `image/avif` ⇒ byte-identical) |
| SPINE repack (`:1961-1968`) + SPINE pack (`:2845-2846`, probeExt `:2745`) | `spinePageFormat==='profile'` ⇒ `formats[0]` (+multi note); `'png'` ⇒ PNG | `spinePageFormat==='profile'` ⇒ legacy resolved target (`resolveOptions(ref,'spine',…)`); `'png'` (DEFAULT) ⇒ `'image/png'` + `{allowPngFallback:true}` — today's bytes |

Justification (why NOT tie repack/merge to `defaultTarget` when profile is off):

1. **Structural byte-identity, not heuristic.** "Keep today's output when defaults are untouched"
   via touched-detection is unfalsifiable (a loaded config that happens to equal the defaults is
   indistinguishable from untouched). Profile-OFF ⇒ webp-lossless is a *structural* guarantee: the
   default run has profile OFF, so the default run is provably byte-identical.
2. **Lossless honesty.** Repack/merge today is a *lossless geometric* fix — its receipt claim is
   "same pixels, smaller sheet, exact VRAM before→after". `defaultTarget` is `image/avif` q85
   (lossy). Silently routing a geometry fix through a lossy encode because a *loose-transcode*
   default knob was moved would be exactly the "settings change silently degrades" failure the
   honesty guards forbid. The explicit vehicle for "sheets in format X" already exists and is the
   profile (`profileEnable` + one format).
3. **Pack keeps its lossy legacy path** because that IS today's behavior (packed sheets already
   follow the legacy avif default via `resolveOptions`) — byte-identity forces the asymmetry, and
   the asymmetry is honest: pack composes *loose lossy-sourced* images under the quality knob;
   repack re-emits *existing sheet* content.
4. **Multi-format profile ⇒ formats[0] + note (never webp-lossless, never fan-out).** Precedent:
   the Phase-A owner-name prediction (`fix.worker.ts:1291-1298`) and `emitLooseProfileFanout`'s
   canonical owner image ALREADY treat `resolveProfile(ref).formats[0]` as "the canonical format".
   One sidecar references one page, so fan-out is impossible (out of scope, as briefed); choosing
   webp-lossless would emit a format the user never selected. Contrast: `atlasNeedsForcedFormat`
   refuses multi because *keeping the byte-original page* is an option there; for a freshly composed
   repack/merge/pack page it is not.
5. For a MERGE group, resolve the profile for `refs[0]` (the same representative already used for
   `baseDir` and `captureSheetDiff` at `:2170/:2228`). Deterministic; documented v1 rule.

⚠CORRECTION (missed by the brief): the non-merge repack ext-repoint at `fix.worker.ts:2239-2242`
hardcodes two `sheet.mime === 'image/webp'` checks. Generalizing the format requires replacing both
with mime-driven renames: `const newExt = EXT[sheet.mime] ?? '.png'; imagePath = origPath.replace(/\.[a-z0-9]+$/i, newExt)`
and the same for `na.imageRef` — skip the rename when the extension is unchanged. For today's
webp emit this is behavior-identical (webp source stays `.webp`, png source renamed `.png`→`.webp`
exactly as now); a PNG fallback from a PNG source yields an unchanged name exactly as now.
The merge branch (`:2196`) already uses `EXT[sheet!.mime]` — no change needed there.

⚠CORRECTION: the `FixOptions.exportProfile` doc comment (`fix-protocol.ts:90-101`) states
"Repack/merge sheets (lossless WebP) + Spine pages (PNG) are UNCHANGED" — that sentence must be
updated in the wiring commit (C2) or it becomes actively false documentation.

Out of scope, restated: repacked/merged/packed refs stay EXCLUDED from the tier/profile fan-out
loop (`tierTransformed` adds at `:2010/:2296/:3013`, honest skip at `:3240-3247`) — unchanged. The
tier-loop Spine PNG hardcodes (`:3343/:3351`) and its existing honest note (`:3267-3273`) are also
unchanged in v1 (`spinePageFormat` governs repack/pack Spine pages only; document in the hint copy).

### 0.2 localStorage persistence of settings → **NO. Explicit save/load JSON only (unchanged).**

1. The explicit-save precedent is deliberate and *documented in code*
   (`build-config.ts:21` — "NO localStorage auto-persist — explicit download/load only"); reversing
   it is a product decision outside this slice's mandate.
2. Auto-persist makes "default run" session-dependent: every BYTE-IDENTITY claim in this codebase
   (dozens of them, including all of §8 below) is phrased against untouched defaults. A returning
   visitor with a month-old persisted toggle would get silently different output from a "fresh"
   run — the exact ambiguity the discipline exists to prevent.
3. Partial persistence (settings yes; consent/backend toggles/marking never) creates a mixed
   restore where some page controls come back and others don't — confusing and easy to get subtly
   wrong.
4. The convenience case is already covered by a *better* artifact: the versioned, validated,
   shareable JSON (commit it next to the game repo; it survives browser storage clears).
5. Cheap future path, unblocked by this design: an explicit "remember in this browser" opt-in
   checkbox that stores `serializeBuildConfig()` output and restores through the SAME
   `parseBuildConfig` fail-closed gate — zero schema work later. NOT in this slice.

---

## 1. Verification results (premise-by-premise)

All brief line refs checked; current locations:

- App.tsx (2874 lines): `App()` :58; `profilePanelOpen` :65; header :320-348 (no nav links today);
  `<main>` :350; live region :357-360 (FIRST child of main — see §5 caveat); Dropzone gate :361;
  results h1 (`ad-sr-only`) :377; `FixCard` render :424; optimize-entry anchor :429-441;
  `SettingsPanel` :701; `ExtrudePanel` :945 (values {0,1,2}); `ExportProfilePanel` :1222 (save/load
  buttons inside, :1303-1329); `FixCard` :1527; settings useStates :1529-1668; `buildOptions`
  :1805-1884 with hardcodes `targetMime:'image/avif', quality:0.85, padding:2, maxSize:4096,
  maxEdge:2048` (:1808-1812); mutual exclusions VERIFIED: `webpNearLossless: !exportProfile && … `
  :1820, `scaleTiers: !exportProfile && …` :1853; frameRedundancy/trimMargin send `false` only on
  opt-out :1834/:1839; backend field gate :1890-1899 (`buildBackendOptions`); stale-plan reset
  effect :2023-2025 (deps = the exact option-state list); consent reset effect :2029-2031;
  `SettingsPanel`/`PackPanel`/`ExtrudePanel`/`TierPanel`/`ExportProfilePanel`/`BackendKtx2Panel`
  rendered :2078-2196.
- Worker (4695 lines): `composePageEncode` :1390; SPINE repack PNG hardcode :1965-1966; STATIC
  repack+merge webp-lossless hardcode :2188-2189; webp-specific ext repoint :2239-2242
  (⚠ see §0.1); pack `probeExt` :2745-2748; pack `effTarget` :2845-2847; pack `encOpts` :2872;
  `resolveProfile` :693 (in scope at ALL call sites — same closure); `encOptsFor` :713;
  `feToEncodeOpts` :727; profile validation + `profileOn/profileMulti/profileHasLowerTier`
  :508-555; force driver gate :1255-1259; `forceAtlasFormat` :1794; tier fan-out + tierTransformed
  honest skip :3240-3247; profile-off single legacy tier descriptor :3349-3355.
- `packages/fix`: `formatEncode` settings.ts:150 (scale=1 ⇒ scaleAwareQuality no-op — safe for
  sheets); `validateProfile`/`validateTiers`/`validateGlobals`/`isSafeSuffix` scale.ts (pngRecompressLevel
  range **[0,6]** at :226-228 — matches the new level knob); `DEFAULT_SCALE_TIERS` scale.ts:19;
  `atlasNeedsForcedFormat` atlasProfileForce.ts:60; `EXT` dedup-exec.ts:19-24.
- `build-config.ts` v1: exactly as briefed (BUILD_CONFIG_VERSION=1 :29; globals
  `{effort, scaleAwareQuality, pngRecompress:boolean}` :43; older-version accepted+backfilled,
  future rejected :255-258; fail-closed via validateProfile :271-275).
- Mipmaps: `MIP_OVERHEAD = 4/3` core/src/index.ts:310 (conditional, never assumed);
  `KTX2_PROFILE_BAKES_MIPS = true` backend-client.ts:53. The honest mipmap surface = extrude knob
  + KTX2 op + copy. CONFIRMED: nothing else is honest; no new pixel behavior.
- i18n: ⚠CORRECTION — catalogs are **JSON files** `packages/i18n/src/catalogs/{en,ru,de,es,pt,fr,it,zh,hi}.json`
  (en = 431 keys), not .ts. Parity+placeholder tests in packages/i18n; the static t() scan
  `apps/web/test/i18n-app-keys.test.ts` has an explicit MAINTENANCE CONTRACT: every new component
  file containing `t('…')` MUST be added to its `appSrc` concatenation (§5, §7).
- ⚠CORRECTION: `PackMode = 'auto' | 'force-static' | 'force-spine'`,
  `StaticGranularity = 'per-leaf-folder' | 'one-sheet-for-all' | 'per-top-level-bundle'`
  (packages/ingest :211-212). Config-v2 enum coercion must use these exact strings.
- ⚠CORRECTION (refinement of brief decision 2): `cfgStatus` + `onSaveConfig`/`onLoadConfig` move to
  the Settings page (the save/load UI moves there); FixCard keeps only per-run state:
  fix `phase`, `unlocked`, `marking`, `skinGuard`, `excludeKinds`, `backendConsent`, `backendReady`.
- Consent behavior note: consent today resets only when `backendAnyEnable`/`backendReady` flip
  (:2029-2031) — NOT literally "on every option change" as an old comment claims. This design keeps
  the existing reset semantics verbatim (consent stays in FixCard, never in context, never
  serialized) — no behavior change either way.

Verdicts on the brief's checks (a)–(f): (a) SOUND with the live-region caveat (§5);
(b) SOUND — exclusions get *stronger* under one settings object (§3); (c) FEASIBLE — all call
sites confirmed + the ext-repoint correction (§0.1); (d) SOUND (§6); (e) SOUND with the JSON-catalog
and appSrc corrections (§7); (f) NO violations found (§9).

---

## 2. File list

NEW:
| File | Responsibility |
|---|---|
| `apps/web/src/lib/route.ts` | Pure: `type View = 'main'\|'settings'`; `SETTINGS_HASH = '#settings'`; `viewOfHash(hash: string): View` (exact `'#settings'` ⇒ settings, everything else — `''`, `'#'`, `'#Settings'`, `'#foo'` — main). Zero DOM. |
| `apps/web/src/lib/route.test.ts` | Unit tests for viewOfHash + frozen SETTINGS_HASH. |
| `apps/web/src/lib/build-settings.ts` | Pure: `interface BuildSettings` (§3), `settingsDefaults()`, `patchSettings(s, p): BuildSettings` (spread, always fresh object), `scaleTiersOf(s): ScaleTier[]` (the tier-ladder derivation, ports the memo at App.tsx:1598-1601 with `includes` over `string[]`), `buildFixOptions(s, perRun): FixOptions` (the EXTRACTED buildOptions body, §3.2). Imports fix-protocol types + `buildProfileFromState`. NO React. |
| `apps/web/src/lib/build-settings.test.ts` | §8 byte-identity pin + exclusion matrix + patch immutability. |
| `apps/web/src/lib/settings-ctx.tsx` | Thin React context: `BuildSettingsProvider` (holds ONE `useState<BuildSettings>`), `useBuildSettings(): {settings, patch}`. No logic beyond `patchSettings` delegation (precedent: lib/i18n.tsx). Not unit-tested (no harness; logic lives in build-settings.ts). |
| `apps/web/src/components/SettingsPage.tsx` | The page (§5): h1, back link, grouped open cards; hosts the MOVED panels + new controls; owns `cfgStatus` + save/load; consumes `useBuildSettings`. |
| `packages/fix/src/sheetTarget.ts` | Pure decision helper (§4): `sheetPageTarget(args): SheetTargetDecision`. Exported from packages/fix index. |
| `packages/fix/test/sheetTarget.test.ts` | Full decision-matrix tests (§10). |

MODIFIED:
| File | Change |
|---|---|
| `apps/web/src/App.tsx` | App: add `view` state (hashchange listener + initial read), wrap Dropzone+results in `<div hidden={view==='settings'}>` (live region stays OUTSIDE the wrapper), render `<SettingsPage/>` when settings, header nav `<a href={SETTINGS_HASH}>`; drop `profilePanelOpen` lift; FixCard: delete the ~26 lifted useStates, read context, `buildOptions` → thin `buildFixOptions(settings, …)` wrapper; stale-plan effect deps → `[settings, marking]`; move SettingsPanel/PackPanel/ExtrudePanel/TierPanel/ExportProfilePanel definitions out to SettingsPage.tsx; split BackendKtx2Panel (op toggles → page; consent+uploadPreview+status stays in FixCard). |
| `apps/web/src/worker/fix-protocol.ts` | Add `spinePageFormat?: 'png' \| 'profile'` to FixOptions (absent/`'png'` ⇒ dead path); fix the stale exportProfile doc sentence (§0.1). |
| `apps/web/src/worker/fix.worker.ts` | Consume `sheetPageTarget` at the 3 sites + probeExt (§4.2); generalize the :2239-2242 ext repoint; honest multi-format note; NO other behavior change. |
| `apps/web/src/lib/build-config.ts` | v2 (§6): BUILD_CONFIG_VERSION=2, new sections, boolean→level migration, serialize/parse over `BuildSettings` (replaces BuildConfigState), `buildProfileFromState` takes the new shape (`pngRecompressLevel>0 ⇒ {pngRecompressLevel}` replaces the boolean⇒2 fold). |
| `apps/web/src/lib/build-config.test.ts` | v2 round-trip, v1 migration, fail-closed matrix (§10). |
| `apps/web/src/lib/optimize-entry.ts` (+test) | Anchor becomes navigation: keep `OPTIMIZE_ENTRY` keys + `PROFILE_PANEL_ANCHOR` (now the id of the Formats card on the page); add nothing else — App's anchor becomes `<a href={SETTINGS_HASH}>` styled as today; after view switch a `useEffect` in SettingsPage scrolls to `PROFILE_PANEL_ANCHOR` ONLY when arriving via the anchor is NOT tracked — simpler final rule: the anchor just navigates; Formats is the first card. Update the test's comment/pins accordingly (constants unchanged ⇒ minimal edit). |
| `packages/i18n/src/catalogs/*.json` (×9) | Add `settings.*` keys (§7). Existing `fix.*` keys move with components VERBATIM (no re-keying). |
| `apps/web/test/i18n-app-keys.test.ts` | Add `comp('SettingsPage.tsx')` to `appSrc` (maintenance contract). |
| `packages/fix/src/index.ts` | Export sheetTarget symbols. |

NOT modified: `apps/api`, `packages/{core,parsers,ingest,analysis,probe,correlate,budget}`,
`packages/fix/src/{scale,settings,atlasProfileForce}.ts` (reused as-is), zip/license/backend-client.

---

## 3. BuildSettings — field-by-field (defaults = today's behavior EXACTLY)

```ts
// apps/web/src/lib/build-settings.ts
import type { ExportFormat, ResolutionTier } from '@asset-doctor/core';
import type { PackMode, StaticGranularity } from '@asset-doctor/ingest';
import type { ProfileFormatState, UiOverride } from './profile-ui-types';

export interface BuildSettings {
  // ── formats (export profile) — existing shapes, existing defaults ──
  profileEnable: boolean;                                   // false
  profileFormats: Record<ExportFormat, ProfileFormatState>; // png {enabled:false, quality:85, lossless:true,  near:false, pngLossy:false}
                                                            // webp{enabled:false, quality:85, lossless:false, near:false}
                                                            // avif{enabled:true,  quality:85, lossless:false, near:false}
  customTiers: ResolutionTier[];                            // []
  profileOverrides: UiOverride[];                           // []
  profileAvifSubsample: number | undefined;                 // undefined (omit ⇒ @jsquash default)

  // ── defaults (the profile-OFF loose path) — REPLACE the two buildOptions hardcodes ──
  defaultTarget: ExportFormat;                              // 'image/avif'  (was hardcoded :1808)
  defaultQuality: number;                                   // 85 (0..100 UI; wire = /100 ⇒ 0.85, was :1809)

  // ── encode globals ──
  effort: number;                                           // 0   (0..6)
  scaleAwareQ: boolean;                                     // false
  webpNearLossless: boolean;                                // false (legacy global; wire 60 when on AND no profile)
  pngRecompressLevel: number;                               // 0 (0..6; 0 ⇒ off ≙ old boolean false; old true ≙ 2)

  // ── rules ──
  aggressive: boolean;                                      // false
  opaqueAlpha: boolean;                                     // false
  bestFormatPerImage: boolean;                              // false
  frameRedundancy: boolean;                                 // true  (wire: send false only on opt-out)
  trimMargin: boolean;                                      // true  (wire: send false only on opt-out)
  overrides: { match: string; quality: number }[];          // []   (legacy per-folder; quality 0..1 as today)

  // ── packing ──
  padding: number;                                          // 2    (was hardcoded :1810)
  maxSize: number;                                          // 4096 (was hardcoded :1811)
  extrude: number;                                          // 0    (legal set {0,1,2} — ExtrudePanel :947)
  packLoose: boolean;                                       // false
  packMode: PackMode;                                       // 'auto'            ('auto'|'force-static'|'force-spine')
  packGranularity: StaticGranularity;                       // 'per-leaf-folder' (|'one-sheet-for-all'|'per-top-level-bundle')
  packTrim: boolean;                                        // true
  polygon: boolean;                                         // false
  spinePageFormat: 'png' | 'profile';                       // 'png' (NEW; 'png' ⇒ wire field omitted ⇒ byte-identical)

  // ── resize / resolutions ──
  maxEdge: number;                                          // 2048 (was hardcoded :1812)
  tierEnable: boolean;                                      // false
  tierSuffixes: string[];                                   // ['_720p','_540p']  ⚠ array, not Set (JSON-serializable;
                                                            //    derived from DEFAULT_SCALE_TIERS.filter(t=>t.scale<1))

  // ── output ──
  hashFilenames: boolean;                                   // false
  emitPixiManifest: boolean;                                // false
  includeFileSizes: 'off' | 'raw' | 'gzip';                 // 'off'

  // ── backend ops (page UI; live state only — NEVER serialized, §6) ──
  ktx2Enable: boolean;                                      // false
  pngquantEnable: boolean;                                  // false
  resampleEnable: boolean;                                  // false
}
```

STAYS IN FIXCARD (per-run, NOT in BuildSettings, NOT serialized): fix `phase`, `unlocked`,
`marking` (folder-dependent), `skinGuard` (const), `excludeKinds` (intra-plan), `backendConsent`
(per-run invariant), `backendReady` (probe result). `cfgStatus` moves to SettingsPage (local state).

### 3.1 Context wiring

`App()` renders `<BuildSettingsProvider>` around `<main>`'s children (or the whole tree — either is
fine; pick the whole `<div className="min-h-full …">` body so both FixCard and SettingsPage reach it).
Provider holds the single `useState<BuildSettings>(settingsDefaults)`. `patch(p)` =
`setSettings(s => patchSettings(s, p))` — ALWAYS a fresh object (load-bearing for the stale-plan
effect). SettingsPage `applyLoadedConfig(loaded)` = one whole-object `setSettings(merge)` — atomic,
same as today's all-setters apply.

### 3.2 buildFixOptions (extracted, pure, test-pinned)

```ts
export interface PerRunOptions {
  excludeKinds: ReadonlySet<OpKind>;
  marking: LazyMarking;
  skinGuard: SkinGuard;
  backend: BackendOptions | undefined; // FixCard's buildBackendOptions() result (consent-gated, unchanged)
}
export function buildFixOptions(s: BuildSettings, run: PerRunOptions): FixOptions
```

Body = verbatim port of App.tsx:1805-1884 with these EXACT substitutions (everything else identical):
- `targetMime: s.defaultTarget` · `quality: s.defaultQuality / 100` · `padding: s.padding` ·
  `maxSize: s.maxSize` · `maxEdge: s.maxEdge`
- `exportProfile = buildProfileFromState(s)` computed INSIDE (one snapshot ⇒ the mutual exclusions
  `webpNearLossless: !exportProfile && s.webpNearLossless ? 60 : undefined` and
  `scaleTiers: !exportProfile && scaleTiersOf(s).length > 1 ? scaleTiersOf(s) : undefined`
  are decided against the SAME object — strictly stronger than today's separate useStates)
- `pngRecompressLevel: s.pngRecompressLevel > 0 ? s.pngRecompressLevel : undefined` (old
  `pngRecompress ? 2 : undefined`; defaults 0 ⇒ undefined ⇒ identical; migrated true ⇒ 2 ⇒ identical)
- `spinePageFormat: s.spinePageFormat === 'profile' ? 'profile' : undefined` (omit on default)
- `emitPixiManifest` / `includeFileSizes`: FixCard passes the EFFECTIVE values through PerRunOptions?
  NO — keep the auto-pair derivation in FixCard: FixCard computes `effectiveEmitManifest` from
  `s.emitPixiManifest || backendWillUpload` and hands buildFixOptions a settings copy is WRONG
  (drift). Final rule: buildFixOptions takes a 5th per-run input `backendWillUpload: boolean` and
  applies today's exact predicates (`effectiveEmitManifest || undefined`,
  `effectiveEmitManifest && s.includeFileSizes !== 'off' ? s.includeFileSizes : undefined`).
- `buildProfileFromState` signature migrates to BuildSettings (it ignores the extra fields); its
  pngRecompress fold becomes `...(s.pngRecompressLevel > 0 ? { pngRecompressLevel: s.pngRecompressLevel } : {})`.

FixCard's `buildOptions(over?)` becomes:
`buildFixOptions(settings, { excludeKinds: over ?? excludeKinds, marking: aggressive? marking guard…, skinGuard, backend: buildBackendOptions(), backendWillUpload })`
— note marking/skinGuard gating (`aggressive && non-empty`) moves INTO buildFixOptions (it reads
`s.aggressive`), so FixCard passes them raw.

Stale-plan reset effect (App.tsx:2023-2025): deps become `[settings, marking]` — `settings` object
identity changes on every patch (including page edits while FixCard is hidden ⇒ a pending plan is
correctly invalidated; this implements "settings apply to the NEXT run"). `excludeKinds` stays out
(unchanged contract). Consent-reset effect unchanged (`backendAnyEnable` now
`settings.ktx2Enable || settings.pngquantEnable || settings.resampleEnable`).
`uploadPreview` memo deps switch to the three settings fields (same values).

---

## 4. Worker wiring

### 4.1 Pure helper — `packages/fix/src/sheetTarget.ts`

```ts
import type { FormatTarget, ImageMime } from '@asset-doctor/core';

export type SpinePageFormat = 'png' | 'profile';
export interface SheetTargetArgs {
  site: 'repack' | 'pack';          // repack = STATIC repack/merge + SPINE repack; pack = Feature-4 pack
  isSpine: boolean;
  spinePageFormat: SpinePageFormat; // worker maps absent wire field → 'png'
  /** resolveProfile(ref).formats for this ref; [] ⇒ profile OFF. */
  profileFormats: readonly FormatTarget[];
  /** The legacy resolved target for THIS site (pack: resolveOptions(...).targetMime; spine repack:
   *  resolveOptions(ref,'spine',...).targetMime). Unused for static repack/merge (webp-lossless). */
  legacyMime: ImageMime;
}
export type SheetTargetDecision =
  | { kind: 'spine-png' }                                     // 'image/png' + {allowPngFallback:true}
  | { kind: 'webp-lossless' }                                 // 'image/webp' + {lossless:true, allowPngFallback:true}
  | { kind: 'legacy'; mime: ImageMime }                       // mime + encOptsFor(eff, true)
  | { kind: 'profile'; format: FormatTarget; multiNote: boolean }; // formatEncode(format,1,rp.global) → feToEncodeOpts

export function sheetPageTarget(a: SheetTargetArgs): SheetTargetDecision {
  const profileOn = a.profileFormats.length > 0;
  if (a.isSpine) {
    if (a.spinePageFormat !== 'profile') return { kind: 'spine-png' };            // DEFAULT — today
    if (profileOn) return { kind: 'profile', format: a.profileFormats[0]!, multiNote: a.profileFormats.length > 1 };
    return { kind: 'legacy', mime: a.legacyMime };
  }
  if (profileOn) return { kind: 'profile', format: a.profileFormats[0]!, multiNote: a.profileFormats.length > 1 };
  return a.site === 'repack' ? { kind: 'webp-lossless' } : { kind: 'legacy', mime: a.legacyMime };  // §0.1
}
```

Total, deterministic, zero IO. The worker maps decisions to (mime, EncodeOpts) via its EXISTING
closures — no encode logic duplicated.

### 4.2 Call-site diff plan (fix.worker.ts) — each site: compute decision, map, keep everything else

Shared mapping (small local fn near `feToEncodeOpts`):
```ts
const sheetEnc = (d: SheetTargetDecision, ref: string, kindForLegacy: FixAssetKind): { mime: ImageMime; encOpts: EncodeOpts } => {
  switch (d.kind) {
    case 'spine-png':     return { mime: 'image/png',  encOpts: { allowPngFallback: true } };
    case 'webp-lossless': return { mime: 'image/webp', encOpts: { lossless: true, allowPngFallback: true } };
    case 'legacy':        return { mime: d.mime, encOpts: encOptsFor(resolveOptions(ref, kindForLegacy, { ...baseEffective, targetMime: d.mime }, opts.overrides), true) };
    case 'profile': {
      const rp = resolveProfile(ref);
      return { mime: d.format.format, encOpts: feToEncodeOpts(formatEncode(d.format, 1, rp.global)) };
    }
  }
};
const spinePageFormat: SpinePageFormat = opts.spinePageFormat === 'profile' ? 'profile' : 'png';
```

1. **SPINE repack (:1961-1968).** Replace literal `'image/png', { allowPngFallback: true }` with the
   decision for `{site:'repack', isSpine:true, spinePageFormat, profileFormats: profileOn ? resolveProfile(ref).formats : [], legacyMime: resolveOptions(ref,'spine',baseEffective,opts.overrides).targetMime}`.
   When mime !== png: rename `imagePath` by `EXT[enc.mime]` (mirror the static repack repoint), patch
   `na.imageRef` BEFORE `emitSpineAtlasText` (line-0 texture name), push honest note when `multiNote`
   (`'export profile: sheet page emitted as <fmt> only (one sidecar references one page)'`) and a
   runtime note (`'spine pages emitted as <fmt> — requires a loader that decodes it (Pixi does)'`).
   Default `'png'` ⇒ decision `spine-png` ⇒ code path byte-identical.
2. **STATIC repack + MERGE (:2184-2190).** Replace literal `'image/webp', {lossless:true, allowPngFallback:true}`
   with decision for `{site:'repack', isSpine:false, spinePageFormat, profileFormats: profileOn ? resolveProfile(refs[0]!).formats : [], legacyMime:'image/webp' /*unused*/}`.
   Generalize the non-merge ext repoint (:2239-2242) per §0.1 correction. Merge branch already
   mime-generic. `multiNote` ⇒ one skipped[] entry per emitted sheet. Profile OFF ⇒ decision
   `webp-lossless` ⇒ byte-identical.
3. **PACK (:2845-2847 effTarget, :2872 encOpts, :2745 probeExt).** `effTarget/encOpts` from decision
   `{site:'pack', isSpine, spinePageFormat, profileFormats: profileOn ? resolveProfile(group.id ?? first-region-ref).formats : [], legacyMime: resolveOptions(group.outDir,'loose',baseEffective,opts.overrides).targetMime}`.
   NOTE the resolve ref for pack-profile: use `group.outDir` with kind 'loose' (the same key the
   legacy path resolves by) so folder-prefix profile overrides match by output folder —
   deterministic, mirrors legacy. `probeExt` = `EXT[decision mime] ?? '.png'` (superset probe logic
   unchanged). Spine pack default ⇒ `spine-png` ⇒ byte-identical; static pack profile-off ⇒ legacy
   ⇒ byte-identical (`decision.legacy.mime === today's effTarget`).
4. **`recordKtx2Candidate` / `captureSheetDiff` / hashEmit / recordVariant** already consume
   `sheet.mime`/bytes — no change.
5. **NOT touched:** tier loop (:3240-3355), forceAtlasFormat driver, loose fan-out, resize path,
   pngquant/resample/ktx2 post-passes.

Wire: `spinePageFormat?: 'png'|'profile'` added to FixOptions (fix-protocol.ts); plan-mode (`mode:'plan'`)
needs NO change (it predicts counts, not formats).

---

## 5. Settings page + routing + a11y

### 5.1 route.ts + App wiring

- `viewOfHash(location.hash)` initial; `hashchange` listener in one `useEffect` (add+cleanup).
- Header (App.tsx:327 right-side div): add `<a href={SETTINGS_HASH}>` styled like the existing
  mono-teal links (`font-mono text-xs text-teal underline-offset-2 hover:underline`), label
  `t('settings.nav')`, BEFORE `<LanguageSwitcher/>`.
- `<main>` children become:
  ```tsx
  <span role="status" …live region… />            // STAYS OUTSIDE the hidden wrapper — a display:none
                                                   // live region is not announced by SRs (load-bearing)
  <div hidden={view === 'settings'}> …Dropzone/results tree verbatim… </div>
  {view === 'settings' ? <SettingsPage … /> : null}
  ```
- VERIFIED a11y: `hidden` ⇒ UA `display:none` on the wrapper (no Tailwind class on it to override)
  ⇒ the whole subtree (incl. the Dropzone `<h1>` or the results sr-only `<h1>` at :377) leaves the
  AOM ⇒ exactly ONE h1 in every state (SettingsPage brings its own). One `<header>`/`<main>`
  landmark pair throughout (SettingsPage renders INSIDE the same `<main>`). React state fully
  preserved (nothing unmounts): report, film selection, probe readings, FixCard receipt/plan all
  survive round-trips. The plan does get invalidated on settings edits — deliberate (§3.2).
- Focus/scroll: SettingsPage h1 gets `tabIndex={-1}` + a mount-effect `h1.focus({preventScroll:false})`
  — standard SPA view-switch practice; returning via `#` lands back on the intact tree (no focus
  management needed beyond default).
- `profilePanelOpen` state + the controlled-`<details>` machinery in ExportProfilePanel
  (open/onToggleOpen props) are DELETED (sections are open cards).

### 5.2 Component tree + sections (SettingsPage.tsx)

```
SettingsPage ({ files? no — page is folder-independent })
├─ <a href="#"> ← t('settings.back')
├─ <h1 tabIndex={-1}> t('settings.title')
├─ <p> t('settings.applyNote')            // "apply to the NEXT fix run — live, no reload"
├─ Card: Форматы вывода  (id = PROFILE_PANEL_ANCHOR)
│   ├─ ExportProfilePanel content (moved verbatim, minus save/load block, minus <details> wrapper)
│   └─ Defaults row (profile OFF): defaultTarget <select png|webp|avif> + defaultQuality 0..100
│       labels t('settings.defaultTarget'/'settings.defaultTarget.hint'/'settings.defaultQuality')
├─ Card: Разрешения и масштабы — TierPanel content (Set↔array adapter; resampleAvailable prop
│   replaced by `settings.resampleEnable` + softened hint — the consent-dependent flag lives in
│   FixCard; the tier-only vips hint on the page says "when the backend op engages", key
│   t('settings.resampleTierHint')) + maxEdge number input (t('settings.maxEdge'))
├─ Card: Упаковка атласов — PackPanel content + padding (t('settings.padding')) + maxSize
│   (t('settings.maxSize')) + polygon checkbox (moved from FixCard, keys fix.polygon/fix.polygonHint)
│   + spinePageFormat select (t('settings.spineFormat'), options t('settings.spineFormat.png')
│   /t('settings.spineFormat.profile'), hint t('settings.spineFormat.hint') — states the runtime
│   requirement + that tier-loop Spine pages stay PNG in v1)
├─ Card: Мипмапы и швы — ExtrudePanel content (moved) + KTX2 toggle row (from BackendKtx2Panel)
│   + honest copy t('settings.mip.copy'): raster formats store no mip levels — the GPU generates
│   them at load (+33% VRAM ceiling, the existing mipmap-cost finding measures this); KTX2 (opt-in
│   backend) bakes real mips; extrude prevents mip/bilinear seam bleed. NO new pixel behavior.
├─ Card: Правила оптимизации — SettingsPanel content minus pngRecompress checkbox, PLUS
│   pngRecompressLevel select 0..6 (t('settings.pngLevel') + hint; 0 = off) + aggressive checkbox
│   (moved from FixCard, key fix.merge)
├─ Card: Переопределения — the legacy per-folder overrides editor (already inside SettingsPanel —
│   keep it there; this card exists only if we split it — FINAL: keep overrides inside the Rules
│   card to avoid churn; drop this card)
├─ Card: Вывод и имена файлов — emitPixiManifest + includeFileSizes + hashFilenames rows (moved;
│   auto-pair note stays in FixCard where backendWillUpload is known; page shows plain checkbox)
├─ Card: Бэкенд (опционально) — ktx2/pngquant/resample toggles + configured/unconfigured status
│   (backendConfigured is module-level derivable: API_BASE + loadStoredEntitlement — import same
│   helpers); consent checkbox + upload preview REMAIN IN FIXCARD (t('settings.backend.consentNote')
│   explains: consent is asked per-run next to the Run button)
└─ Card: Конфиг — Save/Load buttons + cfgStatus live region (moved from ExportProfilePanel verbatim,
    keys fix.config.* reused) — serializes the WHOLE BuildSettings (§6)
```

Cards: `rounded-xl border border-line bg-panel p-4` + mono `[10px]` uppercase teal section titles —
existing tokens only. Moved panels: strip the `<details>/<summary>` wrappers, keep inner JSX + keys
verbatim (summary text becomes the card title with the same key).

FixCard KEEPS (visible run surface): merge/aggressive? — NO: aggressive moves to Rules card (it's a
setting); FixCard keeps BundlesPanel (needs `files`; shown when `settings.aggressive && showBundles`),
plan preview + PlanCard/excludeKinds, consent block + upload preview + healthz status, run buttons,
receipt/sheet-diffs/verdicts, license/ProBadge, and a small `<a href={SETTINGS_HASH}>` "настройки →"
link (key t('settings.open')) so the run surface points at the config.

---

## 6. Config file v2 (build-config.ts)

`BUILD_CONFIG_VERSION = 2`. Serialized shape (stable key order exactly as listed; 2-space JSON;
sections after `profile` are NEW):

```jsonc
{
  "kind": "asset-doctor/build-config",
  "version": 2,
  "profile": { "enabled": false, "formats": { "image/png": {…}, "image/webp": {…}, "image/avif": {…} },
               "customTiers": [], "overrides": [], /* "avifSubsample": 3 — omitted when undefined */ },
  "defaults": { "target": "image/avif", "quality": 85 },
  "globals":  { "effort": 0, "scaleAwareQuality": false, "pngRecompressLevel": 0, "webpNearLossless": false },
  "rules":    { "aggressive": false, "opaqueAlpha": false, "bestFormatPerImage": false,
                "frameRedundancy": true, "trimMargin": true, "overrides": [ { "match": "ui/", "quality": 0.8 } ] },
  "packing":  { "padding": 2, "maxSize": 4096, "extrude": 0, "packLoose": false, "packMode": "auto",
                "packGranularity": "per-leaf-folder", "packTrim": true, "polygon": false, "spinePageFormat": "png" },
  "resize":   { "maxEdge": 2048, "tierEnable": false, "tierSuffixes": ["_720p", "_540p"] },
  "output":   { "hashFilenames": false, "emitPixiManifest": false, "includeFileSizes": "off" }
}
```

NEVER serialized (and never restored): `ktx2Enable`, `pngquantEnable`, `resampleEnable`,
`backendConsent` (per-run invariant), `marking`, `excludeKinds`. `serializeBuildConfig(s: BuildSettings)`
reads only the whitelisted fields; `parseBuildConfig` returns a `Partial`-free BuildSettings whose
backend-op toggles are ALWAYS `settingsDefaults()` values (pin with a test).

Parse/migration rules (extends the existing pickState philosophy — coerce+backfill, reject only via
validators):
1. kind/`version` gates unchanged: non-integer or `> 2` ⇒ `fix.config.err.version`; `1` accepted.
2. **v1 migration:** `globals.pngRecompress === true ⇒ pngRecompressLevel = 2`; `false/absent ⇒ 0`.
   v2 `globals.pngRecompressLevel` (finite number ⇒ `clampInt(0..6)`) WINS when present. All new
   sections absent in v1 ⇒ backfilled from `settingsDefaults()` ⇒ a v1 file loads to exactly
   {old profile+globals, everything else default} — same live state a v1 load produces today.
3. Coercions (each falls back to its default on wrong type): enums —
   `defaults.target ∈ {image/png,image/webp,image/avif}`; `packing.packMode ∈ {auto,force-static,force-spine}`;
   `packing.packGranularity ∈ {per-leaf-folder,one-sheet-for-all,per-top-level-bundle}`;
   `packing.spinePageFormat ∈ {png,profile}`; `output.includeFileSizes ∈ {off,raw,gzip}`.
   Numbers — `quality clampInt 0..100`; `effort clampInt 0..6`; `pngRecompressLevel clampInt 0..6`;
   `padding clampInt 0..32`; `extrude` coerced into `{0,1,2}` (else 0); `maxSize clampInt 128..8192`;
   `maxEdge clampInt 128..16384`. `rules.overrides[]`: keep rows with string match; `quality` number
   clamp 0..1 else 0.85. `resize.tierSuffixes`: intersect with
   `DEFAULT_SCALE_TIERS.filter(t=>t.scale<1).map(t=>t.suffix)` (unknown suffixes dropped — the tier
   UI only offers the preset ladder).
4. Fail-closed validators unchanged: `validateProfile(buildProfileForValidation(state))` (same
   enabled/anyFormat trigger as today) — a bad profile/tier/subsample/global still rejects the WHOLE
   file with `fix.config.err.invalid`.
5. Deterministic round-trip: `parse(serialize(s))` deep-equals `s` restricted to serialized fields;
   `serialize(parse(v1File).state)` produces a valid v2 file.

`buildProfileFromState` change (same commit): input type `BuildSettings`;
`pngRecompress ⇒ level 2` fold becomes `pngRecompressLevel > 0 ⇒ {pngRecompressLevel}` —
byte-identical for default(0)/migrated-true(2).

---

## 7. i18n plan

New namespace `settings.*`, added to ALL 9 catalogs (`packages/i18n/src/catalogs/*.json` — JSON,
en is the source; parity + placeholder tests enforce the other 8 automatically):

`settings.nav` · `settings.title` · `settings.back` · `settings.open` · `settings.applyNote` ·
`settings.section.formats` · `settings.section.resolutions` · `settings.section.packing` ·
`settings.section.mip` · `settings.section.rules` · `settings.section.output` ·
`settings.section.backend` · `settings.section.config` ·
`settings.defaultTarget` · `settings.defaultTarget.hint` · `settings.defaultQuality` ·
`settings.maxEdge` · `settings.padding` · `settings.maxSize` ·
`settings.spineFormat` · `settings.spineFormat.png` · `settings.spineFormat.profile` ·
`settings.spineFormat.hint` · `settings.pngLevel` · `settings.pngLevel.hint` ·
`settings.mip.copy` · `settings.resampleTierHint` · `settings.backend.consentNote`

(~28 keys × 9 catalogs; all static — no `{tokens}` ⇒ no new plural machinery.) Existing
`fix.settings.*`, `fix.profile.*`, `fix.pack.*`, `fix.tier.*`, `fix.extrude*`, `fix.backend.*`,
`fix.config.*`, `fix.merge`, `fix.polygon*`, `fix.pixiManifest*`, `fix.includeFileSizes*`,
`fix.hashFilenames*` move with their JSX VERBATIM — zero re-keying, zero catalog churn for moved UI.

MANDATORY: add `comp('SettingsPage.tsx')` to `appSrc` in `apps/web/test/i18n-app-keys.test.ts`
(the file's maintenance contract), else moved keys leave the scan silently. No new dynamic
`t(\`…${}\`)` classes are introduced (the pack/tier dynamic branches move file but keep shape — the
existing `MODE_SUFFIXES`/`GRAN_SUFFIXES`/tier-label expansions already cover them; verify the
expansion branches still find their prefixes after the move).

Worker skip strings (multi-format sheet note, spine-format runtime note) stay EN like every other
`skipped[]` reason (existing convention — receipts are EN; not i18n keys).

---

## 8. BYTE-IDENTITY claims (reviewers: check each)

B1. **Default untouched run (profile OFF, nothing toggled):**
    `buildFixOptions(settingsDefaults(), {excludeKinds:∅, marking:{}, skinGuard:{}, backend:undefined, backendWillUpload:false})`
    deep-equals today's `buildOptions()` output field-for-field (pinned by test: the exact literal
    expected bag `{targetMime:'image/avif', quality:0.85, padding:2, maxSize:4096, maxEdge:2048,
    aggressive:false, polygon:false, …all optionals undefined…}`). Worker input identical ⇒ zip
    byte-identical.
B2. **Spine sheets:** `spinePageFormat` default `'png'` ⇒ wire field absent ⇒ worker constant
    `'png'` branch ⇒ `sheetPageTarget → 'spine-png'` ⇒ `'image/png' + {allowPngFallback:true}` —
    the exact literals at :1965-1966 and :2845-2846; probeExt `'.png'` as :2745.
B3. **Static repack/merge, profile OFF:** decision `webp-lossless` ⇒ the exact literals at
    :2188-2189; the generalized ext-repoint reproduces :2239-2242 for webp/png mimes (test the
    string math: `.png→.webp` rename, `.webp→.webp` no-op, png-fallback ⇒ original name).
B4. **Pack static, profile OFF:** decision `legacy` with `legacyMime = resolveOptions(...).targetMime`
    — the same expression as :2847; `encOptsFor(eff,true)` as :2872; `baseEffective.targetMime`
    still `opts.targetMime` = `settings.defaultTarget` = `'image/avif'` default.
B5. **Profile ON, loose/tier paths:** untouched (no worker change there); profile ON *sheet* paths
    CHANGE deliberately (formats[0]) — this is the feature, NOT covered by byte-identity; documented
    + honest notes.
B6. **v1 config load:** produces the same live state as today's v1 load (profile+globals applied,
    `pngRecompress:true ⇒ level 2 ⇒ wire pngRecompressLevel:2` — the same wire value as today's
    boolean path), everything else defaults.
B7. **UI default render:** page hidden by default (`viewOfHash('') === 'main'`), header gains one
    nav link (additive); FixCard renders the same controls minus the moved panels (visual diff is
    the point of the feature — but the RUN output stays B1).
B8. **Existing worker tests** (apps/web/test/*-worker.test.ts, packages/fix/test/*) pass unchanged —
    they construct FixOptions directly; every new field is optional-absent ⇒ dead.

---

## 9. Invariant compliance

- Inv 1/2: zero new network; settings page is pure client; backend ops stay opt-in + consent-per-run
  in FixCard; consent + backend toggles NEVER serialized (§6) and consent never leaves FixCard state.
- Inv 3: no generation; mip section is copy + existing knobs (no fake baking — raster mips are
  impossible and stated so); `sheetPageTarget` only *selects* among honest encodes; multi-format
  sheet limitation surfaced, never silent; PNG-fallback + keep-original guards untouched.
- Inv 4: instant-wow path untouched (analysis flow not modified; page adds no work to the ≤10s path).
- Inv 5: extrude VRAM-growth disclosure, disk≠VRAM wording, mip ×4/3 ceiling copy all preserved;
  no new VRAM claims anywhere.
- Fail-closed: config v2 parse rejects unknown/future versions and invalid profiles exactly as v1;
  coercions never widen valid ranges past the existing validators.

---

## 10. Commit breakdown (6 small commits, gate green after each)

C1. `feat(fix): sheetPageTarget — pure sheet-format decision helper`
    packages/fix/src/sheetTarget.ts + test + index export. No consumers yet ⇒ zero behavior change.
    Tests: full matrix — spine png/profile × profileOn/off/multi, repack vs pack, legacy passthrough;
    determinism; formats[0] selection; multiNote flag.

C2. `feat(web,worker): sheet formats follow the profile; spinePageFormat wire option`
    fix-protocol.ts (+field, fix stale doc comment), fix.worker.ts (4 sites §4.2 + ext-repoint
    generalization + honest notes). Tests: new `apps/web/test/sheet-format-worker.test.ts` (mirror
    atlas-transcode-worker.test.ts harness): (a) repack under single-format avif profile ⇒ page is
    avif + sidecar repointed; (b) multi-format profile ⇒ formats[0] + skipped note; (c) spine repack
    with spinePageFormat:'profile' + webp-lossless profile ⇒ webp page + .atlas line-0 repointed;
    (d) absent options ⇒ existing snapshot paths unchanged (rely on the existing worker suites for
    the byte-identity half — they must pass untouched).

C3. `feat(web): BuildSettings — one settings object, context, buildFixOptions extraction`
    lib/build-settings.ts + test, lib/settings-ctx.tsx, App.tsx FixCard lift (context reads; delete
    lifted useStates; stale-plan deps → [settings, marking]; buildOptions → wrapper). UI unchanged
    in this commit (panels still in FixCard, driven by context). Tests: B1 literal pin; exclusion
    matrix (profileEnable+format ⇒ no scaleTiers/webpNearLossless keys; tiers only when
    tierEnable && >1; frameRedundancy/trimMargin false-only-on-optout; spinePageFormat omitted on
    'png'); patchSettings immutability + identity change; scaleTiersOf ladder order.

C4. `feat(web): build-config v2 — full-surface serialize, v1 migration, fail-closed`
    build-config.ts (+version, sections, migration, BuildSettings-typed) + build-config.test.ts
    (round-trip; v1 boolean→level both values; future-version/wrong-kind/malformed rejects; invalid
    profile reject; unknown-key drop; backend-toggle exclusion pin; enum/number coercion matrix).
    App.tsx: applyBuildConfig → single setSettings merge.

C5. `feat(web,a11y,i18n): settings page — hash route, moved panels, mip section, 9-catalog keys`
    lib/route.ts + test, components/SettingsPage.tsx, App.tsx (view state, hidden wrapper, nav link,
    panel moves, BackendKtx2Panel split, optimize-entry anchor → href=#settings, drop
    profilePanelOpen), optimize-entry.ts/test touch-up, 9 catalogs `settings.*`,
    i18n-app-keys.test.ts appSrc. Tests: route.test.ts; updated optimize-entry.test.ts; i18n parity
    auto-covers catalogs.

C6. `docs: FEATURES/CLAUDE.md — unified build settings page (formats+mip honest model)`
    Update the `fix` package paragraph in CLAUDE.md (build-config v2, settings page, sheet-format
    rules incl. the §0.1 table) + FEATURES log entry per repo convention.

---

## 11. Test plan summary (per module)

| Module | Tests |
|---|---|
| packages/fix/test/sheetTarget.test.ts | Decision matrix (≥12 cases §10-C1), byte-identity defaults, determinism |
| apps/web/test/sheet-format-worker.test.ts | 4 worker-level scenarios (§10-C2) |
| lib/build-settings.test.ts | B1 literal FixOptions pin; mutual-exclusion matrix; default-omission table (every optional undefined at defaults); patch immutability; ladder derivation |
| lib/build-config.test.ts | v2 round-trip determinism; v1→v2 migration (true⇒2, false⇒0); fail-closed matrix; serialization exclusion pins (backend/consent absent from output; parse never restores them) |
| lib/route.test.ts | viewOfHash: '', '#', '#settings', '#Settings', '#settings/x', '#foo' |
| lib/optimize-entry.test.ts | Updated pins (constants unchanged; comment updates) |
| i18n | Existing parity/placeholder tests auto-enforce the 9 catalogs; i18n-app-keys scan extended with SettingsPage.tsx |
| Existing suites | apps/web/test/*-worker.test.ts + packages/fix/test/* must pass UNMODIFIED (B8) |

Manual smoke (pnpm dev): default run zip vs main-branch zip on fixtures/sample-projects (byte-compare);
#settings round-trip preserves results + receipt; SR pass (one h1 per view); profile-ON repack emits
profile format with note.
