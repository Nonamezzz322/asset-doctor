# R5 Build-config import/export (download/load the ExportProfile + fix settings as a versioned JSON) (PROCEED)

# R5 — Build-config import/export (save/load the configuration)

## Premise verification (cited — the gap is REAL, not marginal)

The feature does NOT exist. Confirmed by direct inspection, not grep-of-comments:

1. **No config serialize/parse anywhere in the web app.** `grep -rniE "import.*config|export.*config|saveProfile|loadProfile|serializeProfile|JSON.stringify.*profile" apps/web/src` returns only `backend-client.ts:120` (`JSON.stringify({ png, w, h, op, profile })` — a per-op backend request body, unrelated) and a `fix.worker.ts:128` comment. There is no ExportProfile-to-JSON download and no file-input load of a config.
2. **No config i18n keys.** `grep -iE "fix\.config|config\.(save|load|import|export)" packages/i18n/src/catalogs/en.json` → empty. (en.json has 502 keys; none for config save/load.)
3. **The config the user edits is real, large, and currently un-saveable.** The "build config" is a union of ~14 `useState` pieces in `apps/web/src/App.tsx`: profile panel state (`profileEnable` 1505, `profileFormats: Record<ExportFormat, ProfileFormatState>` 1506, `customTiers: ResolutionTier[]` 1511, `profileOverrides: UiOverride[]` 1515, `profileAvifSubsample` 1522) plus the SHARED SettingsPanel global knobs the profile memo folds in (`effort` 1438, `scaleAwareQ` 1439, `pngRecompress` 1441). Lose the tab → lose all of it. The external asset-builder this clones uses a checked-in config file; we have no equivalent. This is exactly the cited gap.
4. **The validator to reuse already exists and is exported.** `validateProfile(p: ExportProfile): ProfileValidation` (`packages/fix/src/scale.ts:219`, re-exported `packages/fix/src/index.ts:50`) returns `{ ok:false; errors:string[] }` fail-closed — never throws — and already rejects empty formats, lossless-AVIF, bad quality/near, dup targets, bad globals, and delegates the tier axis to `validateTiers`. R5 reuses it verbatim.
5. **Granular UI types are already exported from App.tsx** (`ProfileFormatState` 1154, `UiOverride`/`OverrideMode` 1180-1186, `FORMAT_KEYS` 1169) — the importer can set them directly without new App refactor.

Verdict: **PROCEED.** Contained, browser-only, additive, with a robust fail-closed path.

---

## Problem (verified)

A user who dials in formats/quality/subsampling/scale-tiers/overrides + global encode knobs cannot save, share, or reload that configuration. Reverse-mapping the *derived* `ExportProfile` back to UI state is lossy (the memo collapses `ProfileFormatState.near: boolean` → `near: 60` at `App.tsx:1595`, and folds `effort`/`scaleAwareQ`/`pngRecompress` from the SettingsPanel into the profile at 1622-1624), so we must serialize the **granular UI source state**, not the derived profile. But validation MUST still go through `validateProfile` on the *rebuilt* profile so a bad/old config is rejected, never crashes.

## v1 scope (one shippable slice)

- A pure, Node-testable module `apps/web/src/lib/build-config.ts`: `serializeBuildConfig(state) → BuildConfigFile`, `parseBuildConfig(text) → ParseResult` (malformed JSON / version / shape / fail-closed validation all handled, never throws).
- Two additive UI buttons in `ExportProfilePanel` (App.tsx): **Save config ↓** (download a `.json`) and **Load config ↑** (hidden `<input type=file accept=".json,application/json">`). Token-driven styling mirroring the existing `fix.download` button (`App.tsx:2344`).
- A `applyBuildConfig` callback in `App()` that, on a valid parse, calls the existing setters (`setProfileEnable`, `setProfileFormats`, `setCustomTiers`, `setProfileOverrides`, `setProfileAvifSubsample`, `setEffort`, `setScaleAwareQ`, `setPngRecompress`).
- 9 i18n catalogs for the new labels + parse-error reasons.

## Out of scope (explicit)

- Loading does NOT include asset files (config only; assets never serialized — invariant 1).
- NO save of backend-op toggles (`ktx2Enable`/`pngquantEnable`/`resampleEnable`/`backendConsent`) — those are per-run, consent-reset (`App.tsx:1546-1562`); persisting consent would violate "consent never sticky". NO save of `packLoose`/`hashFilenames`/`emitPixiManifest`/`aggressive`/`marking`/`excludeKinds` in v1 (those are separate Pro toggles outside the profile panel; a later slice can extend the schema additively via the version field).
- NO localStorage auto-persist (out of scope; explicit download/load only — honesty: no hidden state).
- NO server round-trip (browser-only).

## Additive contract / type changes

**Nothing in `packages/core` changes.** The serialized shape lives in the new web-lib module (it references UI types, not wire contracts). New types in `apps/web/src/lib/build-config.ts`:

```ts
export const BUILD_CONFIG_VERSION = 1;
export interface BuildConfigFile {
  kind: 'asset-doctor/build-config';   // discriminator — rejects arbitrary JSON
  version: number;                      // forward-compat gate
  profile: {
    enabled: boolean;
    formats: Record<ExportFormat, ProfileFormatState>;
    customTiers: ResolutionTier[];      // core type (label/scale/suffix)
    overrides: UiOverride[];            // App-exported {match,mode,quality?}
    avifSubsample?: number;             // 0|1|3 (undefined ⇒ key omitted)
  };
  globals: { effort: number; scaleAwareQuality: boolean; pngRecompress: boolean };
}
export interface BuildConfigState {   // what App passes in / gets back (the live useState slice)
  profileEnable: boolean;
  profileFormats: Record<ExportFormat, ProfileFormatState>;
  customTiers: ResolutionTier[];
  profileOverrides: UiOverride[];
  profileAvifSubsample: number | undefined;
  effort: number; scaleAwareQ: boolean; pngRecompress: boolean;
}
export type ParseResult =
  | { ok: true; state: BuildConfigState }
  | { ok: false; reasonKey: string; detail?: string };  // reasonKey is an i18n key
```

**Absent ⇒ byte-identical.** This module is never imported by the worker; not loading a config leaves every `useState` at its current default ⇒ zero behavior change. Imports of `ProfileFormatState`/`UiOverride`/`OverrideMode`/`FORMAT_KEYS` come from App.tsx (already exported) or are moved to a tiny shared types file if a circular import appears (App.tsx imports build-config.ts which would import App.tsx — SEE edge case "circular import").

## Pure modules + signatures (`apps/web/src/lib/build-config.ts`)

```ts
import { validateProfile } from '@asset-doctor/fix';
import type { ExportProfile, ExportFormat, FormatTarget, ProfileOverride, ResolutionTier } from '@asset-doctor/core';

// 1. SERIALIZE — pure, deterministic. Stable key order, 2-space JSON.
export function serializeBuildConfig(s: BuildConfigState): string;
//   builds BuildConfigFile, JSON.stringify(file, ORDERED_REPLACER, 2). avifSubsample omitted when undefined.

// 2. buildProfileFromState — REUSES the EXACT mapping logic of App.tsx:1590-1628 (the exportProfile memo),
//    extracted here so save/validate and the live run share ONE mapping (no drift). Returns ExportProfile.
export function buildProfileFromState(s: BuildConfigState): ExportProfile;
//   (App.tsx's memo is refactored to call this — see worker/UI changes — so there is a single source of truth.)

// 3. PARSE + VALIDATE — never throws.
export function parseBuildConfig(text: string): ParseResult;
//   a. JSON.parse in try/catch        → { ok:false, reasonKey:'fix.config.err.malformed' }
//   b. typeof !== object / null       → 'fix.config.err.notObject'
//   c. kind !== 'asset-doctor/build-config' → 'fix.config.err.wrongKind'
//   d. !Number.isInteger(version) || version > BUILD_CONFIG_VERSION → 'fix.config.err.version' (detail: version)
//      (version < current ⇒ accept + migrate-by-default-fill — v1 has only version 1, so this is the
//       forward-compat hook; unknown FUTURE version is rejected, never silently mis-parsed.)
//   e. coerce shape with defaults for MISSING/extra keys (pickState below) — partial config tolerated.
//   f. const v = validateProfile(buildProfileFromState(coerced));
//      if (!v.ok) → { ok:false, reasonKey:'fix.config.err.invalid', detail: v.errors.join('; ') }
//      else → { ok:true, state: coerced }

// 4. pickState — coerce arbitrary parsed object → BuildConfigState, DROPPING unknown/extra keys and
//    backfilling missing ones from PROFILE_DEFAULTS (mirrors App.tsx:1506-1509 initial state). Pure.
//    Clamps obvious garbage types (e.g. non-array customTiers → []) so validateProfile gets a well-typed
//    profile to judge (fail-closed there, not a TypeError here).
```

**Determinism:** `serializeBuildConfig` uses a fixed-order replacer (kind, version, profile{enabled,formats(PNG,WebP,AVIF order),customTiers,overrides,avifSubsample}, globals) ⇒ same state always serializes byte-identically (testable). No `Date.now`/`Math.random`. `parseBuildConfig` is a pure function of its input string.

## Worker / UI / backend changes

- **Worker: NONE.** Config never reaches the worker; only its *applied effect* (the existing `exportProfile` memo + `buildOptions`) does, unchanged.
- **Backend: NONE** (browser-only, invariant 1/2 untouched).
- **UI (App.tsx):**
  - Extract the body of the `exportProfile` memo (1590-1627) into `buildProfileFromState` in build-config.ts; the memo becomes `useMemo(() => profileEnable ? buildProfileFromState({...liveState}) : undefined, [deps])`. (One source of truth; prevents save/run drift — the cited honesty requirement "exactly what will be applied".)
  - Add to `ExportProfilePanel` props: `onSaveConfig: () => void`, `onLoadConfig: (file: File) => void`. Render two buttons inside the panel header area, styled like `App.tsx:2344` (`border-line ... font-mono text-[11px] text-teal hover:border-teal`). Load uses a hidden `<input type="file" accept=".json,application/json">` + `ref.click()` (mirrors `App.tsx:424`).
  - `onSaveConfig` in `App()`: `downloadText(serializeBuildConfig(state), 'asset-doctor-build-config.json')` — a tiny `downloadText` helper mirroring `downloadZip` (`App.tsx:581-586`: Blob → `URL.createObjectURL` → `a.download` → `a.click` → revoke).
  - `onLoadConfig`: `file.text()` → `parseBuildConfig` → on ok, call all setters; on error, surface `t(reasonKey)` (+ `detail`) via the existing live-region/toast (`live` state, `App.tsx:97`) — NO alert, NO crash.

## Honesty + invariant compliance

- **Inv 1 (assets stay local):** config JSON contains zero asset bytes — only numbers/strings/booleans the user already chose. Download is a local Blob; load is a local file read. No network.
- **Inv 2 (thin backend):** no backend touched.
- **Inv 3 (objective, no generation):** we serialize/restore settings only; nothing measured or generated. Backend-op toggles + consent are deliberately NOT persisted (consent must be per-run).
- **Inv 4 (instant-wow):** purely additive buttons; no impact on the ≤10s diagnosis path.
- **Inv 5 (disk≠VRAM):** N/A (config has no metric claims) — and applying a loaded config reuses the same memo/worker, so all existing honest VRAM gating still runs.
- **"Exactly what will be applied":** because save serializes the granular UI state and the memo is rebuilt from `buildProfileFromState`, the saved config restores the *same UI controls* the user sees, and validation runs the *same* `validateProfile` the live run uses — no hidden divergence.

## Edge cases (all fail-closed)

1. **Malformed JSON** → `JSON.parse` throws, caught → `fix.config.err.malformed`. No crash.
2. **Not an object / null / array** → `fix.config.err.notObject`.
3. **Wrong/missing `kind`** (arbitrary JSON dropped in) → `fix.config.err.wrongKind`.
4. **Version mismatch (future)** → reject `fix.config.err.version` with detail. (Older version accepted + backfilled; v1 has only 1.)
5. **Extra/unknown keys** → silently dropped by `pickState` (forward-compat tolerant).
6. **Partial config** (missing `globals`, missing a format entry, missing `customTiers`) → backfilled from `PROFILE_DEFAULTS`; then validated.
7. **Semantically-invalid-but-well-typed** (e.g. lossless AVIF, dup targets, bad suffix `_99999p` failing `RESOLUTION_TOKEN`, scale>1, no scale-1 top tier) → `buildProfileFromState` + `validateProfile` rejects → `fix.config.err.invalid` (detail = joined errors). The granular state is NOT applied (atomic: all-or-nothing).
8. **profileEnable:false in file** → still validate the rebuilt profile IF formats exist (so a disabled-but-saved config round-trips), but never block load on it; apply the disabled flag as-is.
9. **Wrong-type fields** (e.g. `effort: "high"`, `customTiers: {}`) → `pickState` coerces to defaults/empty so `validateProfile` never sees a TypeError.
10. **Circular import** (App.tsx ↔ build-config.ts for `ProfileFormatState`/`UiOverride`): if Vite/TS flags it, move those three UI types + `FORMAT_KEYS`/`OVERRIDE_MODE_KEYS` into a new `apps/web/src/lib/profile-ui-types.ts` and re-export from App.tsx (additive, no behavior change). Decide at implementation time by attempting the direct import first.

## Test plan (REAL — pure Node/vitest, mirrors the 16 existing `apps/web/src/lib/*.test.ts`)

New `apps/web/src/lib/build-config.test.ts` (vitest, no React, runs under web `vitest run`):

1. **Round-trip identity:** for a representative state (multi-format, custom tiers, fonts444 + quality + lossless overrides, avifSubsample 3, effort 4, scaleAware on, pngRecompress on) → `parseBuildConfig(serializeBuildConfig(s)).state` deep-equals `s`.
2. **Determinism:** `serializeBuildConfig(s) === serializeBuildConfig(structuredClone(s))` (stable key order; pin the exact string for one fixture).
3. **Malformed JSON** → `{ok:false, reasonKey:'fix.config.err.malformed'}`; assert it does NOT throw.
4. **Wrong kind / not object / array / null** → respective reasonKeys.
5. **Future version** (`version: 99`) → `fix.config.err.version`.
6. **Extra keys** (`profile.bogus`, top-level `attack`) → dropped, valid config still parses ok.
7. **Partial** (omit `globals`, omit one format entry, omit `customTiers`) → backfilled, ok.
8. **Fail-closed semantics:** craft files that produce lossless-AVIF, a duplicate target, a bad suffix (`_99999p`), and an empty-formats enabled profile → each → `fix.config.err.invalid`, and assert `validateProfile` is the gate (the detail contains the verbatim validator error substring, e.g. `'losslessAvif'`, `'dupTarget'`, `'tier badSuffix'`).
9. **Wrong-typed fields** (`effort:'x'`, `customTiers:{}`) → no throw; coerced; result deterministic.
10. **No-drift guard:** `buildProfileFromState(state)` deep-equals the object the App memo would build for the same inputs — pin one fixture's expected `ExportProfile` (e.g. asserts `near:60` mapping, `effort` folded only when >0, `avifSubsample` omitted when undefined) so a future memo edit that forgets to call the shared fn is caught.

**i18n test (extend `packages/i18n/test/catalogs.test.ts`):** add an `it('every locale renders the build-config keys without leftover braces')` block asserting all new keys exist in all 9 locales and render brace-free (the existing harness already enforces key parity + placeholder preservation, so adding keys to all 9 catalogs is enforced automatically by the `same keys as en` assertion).

**Unverifiable visual part (explicit reasoning):** the actual button click → file download / file picker is browser-only and there's no React/Playwright harness here (apps/web has Vitest only). The download/load *mechanism* is copied verbatim from the already-shipped `downloadZip` (App.tsx:581) and the file `<input>` (App.tsx:424), both already exercised in production — so the only NEW logic (serialize/parse/validate/coerce) is 100% pure-Node-tested above; the wiring is a like-for-like reuse of verified code, requiring only manual smoke-check, not new automated visual tests.

## New i18n keys (add to all 9 `packages/i18n/src/catalogs/*.json`)

`fix.config.save`, `fix.config.load`, `fix.config.hint`, `fix.config.loaded` (success toast), `fix.config.err.malformed`, `fix.config.err.notObject`, `fix.config.err.wrongKind`, `fix.config.err.version`, `fix.config.err.invalid`. (en is source; translate the other 8 — the drift test enforces parity.)

## Ordered small-commit task breakdown

1. **`feat(fix-ui): extract exportProfile mapping into pure buildProfileFromState`** — move App.tsx:1590-1627 body into `build-config.ts buildProfileFromState`; memo calls it; add the no-drift unit test (#10). (Pure refactor, byte-identical output — guarded by the test.)
2. **`feat(fix-ui): pure build-config serialize/parse core + tests`** — add `BuildConfigFile`/`BuildConfigState`/`ParseResult`, `serializeBuildConfig`/`parseBuildConfig`/`pickState`, version + kind gates, fail-closed via `validateProfile`. Tests #1-9. (No UI yet ⇒ zero behavior change.)
3. **`i18n: build-config save/load labels + parse-error reasons (9 locales)`** — add the 9 keys to all catalogs; extend catalogs.test.ts. 
4. **`feat(fix-ui): wire Save/Load config buttons into ExportProfilePanel`** — add `downloadText` helper, the two buttons + hidden file input, `onSaveConfig`/`onLoadConfig` in App(), success/error surfaced via existing `live` region. (Additive UI; default path untouched.)
5. **`docs: note build-config import/export in CLAUDE.md fix bullet`** — one-line update under the `fix` package description.

Each commit is independently green (`pnpm test`, `pnpm typecheck`, `pnpm lint`) and additive — absent a loaded config, output is byte-identical to today.

## Key file paths
- New pure core + tests: `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/build-config.ts` + `build-config.test.ts`
- UI wiring: `/home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx` (ExportProfilePanel ~1194-1420; state 1505-1522, 1438-1441; exportProfile memo 1590-1628; downloadZip pattern 581-586; file-input pattern 424)
- Reused validator: `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/scale.ts:219` (`validateProfile`), exported `packages/fix/src/index.ts:50`
- i18n: `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/*.json` + `packages/i18n/test/catalogs.test.ts`