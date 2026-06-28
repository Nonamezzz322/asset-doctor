Confirmed. Owners DO go through `emitLooseProfileFanout` when `profileOn` (L1426-1452). The Phase-A prediction at L782 uses `effectiveFor(ref,1).targetMime` which, when `profileOn`, returns `opts.targetMime` (the unused legacy `'image/avif'` base since `opts.overrides` is the legacy override, not the profile). This is a PRE-EXISTING latent divergence. The fan-out sets `ownerActualName.image = r.ownerImage` (= renamedTo(srcPath, profileFormats[0] resolved mime)), and Phase C reconciles against the unhashed prediction. So whatever the draft adds for overrides must feed `resolveProfileForRef(ref,...).formats[0]` into the prediction.

Now I have everything needed. Outputting the final revised design.

---

# Round 7-overrides — Additive per-folder/prefix OVERRIDES for the export profile (REVISED, code-grounded)

## 0. Verdict on the draft

The draft's **core insight is correct and the wiring sites are real**, but it contains **two MAJOR false premises** that would create a parallel, drifting type system, plus several smaller corrections. The revised design below keeps the additive intent and the ordered task breakdown, but re-grounds it on the machinery that already exists.

### Blockers / Majors found (with code grounding)

- **[BLOCKER B1 — false premise: parallel `ResolvedProfile.global`].** The draft invents `ResolvedProfile.global` carrying `effort/avifQualityAlpha/avifSubsample/pngRecompressLevel/scaleAwareQuality`. These **already exist** as a live local: `profileGlobal` (`fix.worker.ts:309-315`), built from `ExportProfile.{effort,scaleAwareQuality,avifQualityAlpha,avifSubsample,pngRecompressLevel}` (`core/src/index.ts:160-169`), and already threaded into every `formatEncode(f, scale, profileGlobal)` call (`fix.worker.ts:1014, 1948`). Inventing a second `global` shape is duplication that **will drift** from `formatEncode`'s actual `global` parameter type (`settings.ts:131-141`). **Resolution:** the resolver returns the SAME shape `formatEncode` already consumes — reuse `typeof profileGlobal` / the existing `formatEncode` `global` param type. No new global type.

- **[BLOCKER B2 — false premise: "the worker resolves formats globally; override applies cleanly there"].** Partly true, partly wrong. When `profileOn`, the loose-fanout (`emitLooseProfileFanout`, 994-1054) and tier loop (1947-1949) use `profileFormats` + `profileGlobal` and **completely ignore `opts.overrides`** — `resolveOptions`/`effectiveFor` (`settings.ts:75-96`, `fix.worker.ts:416-419`) govern ONLY the LEGACY (profile-OFF) loose/transcode path and the pack-sheet target sites (`1517/1592/1611`). So per-ref resolution *inside a profile run* genuinely does not exist today — the feature is real, not redundant. **But** the existing `opts.overrides` (`FixOverride[]`, protocol 124-131) and its UI (`SettingsPanel`, App.tsx 489-525, state `{match,quality}[]` at 940) are a **separate, already-shipped folder-override system** for the legacy path. The draft never mentions it. **Resolution:** (a) the new profile-overrides MUST reuse `overrideMatches`/`FixOverride` semantics verbatim, and (b) the design must explicitly disclaim collision: profile-overrides are a NEW field on `ExportProfile`, NOT a reuse of `opts.overrides` (which stays the legacy knob, inert when `profileOn`). Reusing `FixOverride` shape avoids a third match predicate.

- **[MAJOR M1 — over-scoped `ProfileOverride` fields].** `avifSubsample`, `avifQualityAlpha`, `pngRecompressLevel`, `effort`, `scaleAwareQuality` are **profile-global today, not per-format**. Making them per-override is possible but multiplies the surface and the validation/golden burden well past v1's "fonts→4:4:4" headline. The cleanest honest port (`avifFullChromaFolders`) only needs `avifSubsample` per-folder. **Resolution:** v1 override fields = `{ match, formats?, quality?, near?, lossless?, effort?, avifSubsample? }`. Drop `avifQualityAlpha`/`pngRecompressLevel` from v1 overrides (still profile-global). `effort`/`avifSubsample` MERGE onto the running `profileGlobal`; `quality`/`near`/`lossless` overlay per-format. This keeps `formatEncode` unchanged.

- **[MAJOR M2 — dedup Phase-A prediction is ALREADY mis-grounded under profile, draft's T8 understates it].** Confirmed at `fix.worker.ts:771-784`: Phase-A uses `effectiveFor(ref,1).targetMime`, which under `profileOn` returns the legacy `opts.targetMime`/`opts.overrides` resolution — NOT `profileFormats[0]`. Owners DO fan out through `emitLooseProfileFanout` when `profileOn` (1426-1452), which sets `ownerActualName.image = renamedTo(srcPath, <profileFormats[0] resolved mime>)`. So the prediction can already diverge from actual today (mitigated only because Phase C reconciles actual-vs-predicted and *keeps* the consumer on divergence — a silent dedup degrade). Profile-overrides changing `formats[0]` make this worse. **Resolution:** T8 must feed `resolveProfileForRef(ref,…).formats[0].format` into the Phase-A `targetMime` when `profileOn` (mapping format→mime), fixing the pre-existing latent divergence as a side effect. This is load-bearing, not optional.

- **[MAJOR M3 — `profileMulti` is global; per-ref `refMulti` needed].** Confirmed: `profileMulti` (293, 302) drives `variantManifestName(..., profileMulti)` (2002, 2012, 2018) and the Spine multi-note (1892). An override changing per-ref format COUNT must derive `refMulti = rp.formats.length > 1` per ref. Draft correct; kept.

### Minors / rebuttals

- **[m1 — `formats:[]` rejection]** Correct; `validateFormatList` (factored) rejects empty. Kept.
- **[m2 — sibling-prefix `fonts` vs `fonts2`]** Correct; `overrideMatches` uses `ref===match || ref.startsWith(match+'/')` (`settings.ts:62-67`). `fonts2` not matched. Kept.
- **[m3 — case sensitivity]** `overrideMatches` is **case-SENSITIVE** (raw `startsWith`). The draft never states this. **Added** to the match-semantics contract: matches are case-sensitive on the dir-aware ingest key (`keyOf`), consistent with the existing legacy override and `RESOLUTION_TOKEN` being the only case-insensitive comparison in the codebase. Fonts folders are matched by their actual key case.
- **[m4 — dir-aware ref vs basename]** Confirmed `overrideMatches` operates on the ingest `ref` (the dir-aware `keyOf` key, e.g. `fonts/title.png`), NOT a basename. So `match:'fonts'` reliably catches `fonts/*` and nested `fonts/x/*`. Kept; made explicit.
- **[m5 — lossless-AVIF in overrides]** Correct and load-bearing (invariant 3). `overlayFormat` drops `lossless` on avif AND `validateFormatList` rejects `lossless:true` avif inside `override.formats`. Kept.
- **[m6 — protocol T5]** Correct: overrides ride inside `ExportProfile.overrides`, which already flows through `FixOptions.exportProfile` (protocol 67) untouched. No new wire field. Kept (doc-only).
- **[REBUTTAL of draft's `scaleAwareQuality` "not override-settable" note]** Agreed and kept — it stays profile-global (mirrors `formatEncode`'s `global.scaleAwareQuality`).

---

## 1. Scope & invariants

v1 goal: an additive `ExportProfile.overrides?: ProfileOverride[]`. Each entry matches refs by the **existing** dir-aware predicate (`overrideMatches`, `settings.ts:62-67`) and overrides a SUBSET of the profile's per-format encode + a thin slice of `profileGlobal` for matching refs. **Absent/empty ⇒ byte-identical** to today's profile run; **profile absent ⇒ byte-identical to pre-round7** (the worker's whole profile branch is `profileOn`-gated, 290-305).

Honest subset only (invariant 1/3): per-folder `formats` REPLACE, per-format `quality/near/lossless` overlay, and the headline **fonts→4:4:4** via `avifSubsample` merged onto `profileGlobal`. Dropped from v1 (not honest-per-file or out of scope): pngquant include/exclude, sharp kernels, `maxTextureSize` (geometry), and per-override `avifQualityAlpha`/`pngRecompressLevel` (stay profile-global).

**Reuse, do NOT reinvent:** `overrideMatches` (the ONE match predicate), `formatEncode` + its `global` param (the ONE encode mapping), `profileGlobal` (the live global bag, 309-315), `recordVariant` (the manifest/hash path that overrides must ride). **Match precedence = later-wins**, identical to the existing `resolveOptions` fold (`settings.ts:82-93`) and its goldens — NOT most-specific, NOT first-match.

---

## 2. The additive type (`packages/core/src/index.ts`, after `ExportProfile` L170)

```ts
/** One per-folder/prefix/type override on the export profile (round7-overrides). ADDITIVE: an absent or
 *  empty overrides[] ⇒ the resolver returns the base profile unchanged ⇒ byte-identical to a no-override
 *  run; profile itself absent ⇒ byte-identical to pre-round7 (the worker's profile branch is profileOn-gated).
 *  `match` reuses the EXISTING dir-aware predicate (overrideMatches, settings.ts): case-SENSITIVE exact
 *  ref, dir-prefix `<m>/...`, or a `type:spine|type:pixi|type:loose` pseudo-key — NOT a glob, NOT a bare
 *  startsWith (so `fonts` never matches `fonts2`). Match is on the dir-aware ingest key (keyOf), not a
 *  basename. Precedence: LATER matching entry wins, field-by-field (mirrors resolveOptions' fold — NOT
 *  most-specific). Fields are a SUBSET; omitted fields fall through from the base profile. */
export interface ProfileOverride {
  /** Dir prefix ("fonts" | "ui/buttons"), exact ref, or 'type:spine'|'type:pixi'|'type:loose'. Case-sensitive. */
  match: string;
  /** REPLACE the whole format list for matching refs (atomic; e.g. fonts → [{format:'image/avif'}]).
   *  Omit ⇒ keep base profile.formats. Validated EXACTLY like profile.formats (≥1, valid, no lossless-avif,
   *  no dup target) via the shared validateFormatList. */
  formats?: FormatTarget[];
  /** Overlay the lossy quality (0..100) onto EVERY non-png/non-lossless format of the matching refs. */
  quality?: number;
  /** Overlay webp near-lossless (0..100; 100/omit ⇒ off) onto matching refs' webp targets only. */
  near?: number;
  /** Force matching refs to lossless where honest (webp/png); IGNORED for avif (no faked-lossless). */
  lossless?: boolean;
  /** Merge encoder effort (0..6) onto the running profile-global for matching refs. */
  effort?: number;
  /** The fonts→4:4:4 port: merge AVIF chroma subsample (3 = YUV444) onto the running profile-global. */
  avifSubsample?: number;
}
```

Add to `ExportProfile`:
```ts
  /** ADDITIVE per-folder/prefix/type overrides (round7-overrides). Absent/empty ⇒ identical to a
   *  no-override profile run. Validated fail-closed alongside the base (validateProfile). */
  overrides?: ProfileOverride[];
```

Two axes, by design:
- **`formats` REPLACES** the running format list (atomic — a format list isn't field-mergeable). This is the `webpOptionsOverrides`/`avifOptionsOverrides`/fonts→AVIF analogue.
- **`quality/near/lossless`** overlay per-format (only where the codec honors them); **`effort/avifSubsample`** MERGE onto the running global. All scalar folds are `?? running` so later non-undefined wins.

---

## 3. The pure resolver (`packages/fix/src/settings.ts`)

New `ProfileOverride` mirror (kept here so `packages/fix` stays a leaf, exactly as `FixOverride` is mirrored today — `settings.ts:35-46`), `resolveProfileForRef`, and a private `overlayFormat`. Export via `index.ts:41-42` (next to `validateProfile`). **Reuse `overrideMatches` verbatim** — do NOT add a predicate. The resolver returns formats + a global bag whose type IS `formatEncode`'s `global` parameter type (factor that param type into a named exported `FormatEncodeGlobal` so the resolver and `formatEncode` cannot drift):

```ts
/** The global-knob bag formatEncode consumes (settings.ts:131-141), named so resolveProfileForRef and
 *  formatEncode share ONE type (no drift). scaleAwareQuality + avifQualityAlpha + pngRecompressLevel stay
 *  PROFILE-GLOBAL in v1 (not per-override); effort + avifSubsample are override-mergeable. */
export interface FormatEncodeGlobal {
  effort: number;
  scaleAwareQuality: boolean;
  avifQualityAlpha?: number;
  avifSubsample?: number;
  pngRecompressLevel?: number;
}
```
(Then change `formatEncode`'s inline `global: {…}` param to `global: FormatEncodeGlobal` — pure refactor, no behavior change, existing goldens still pass.)

```ts
/** Per-ref ProfileOverride mirror (kept leaf-side, like FixOverride). Structurally identical to core's. */
export interface ProfileOverride {
  match: string;
  formats?: FormatTarget[];
  quality?: number;
  near?: number;
  lossless?: boolean;
  effort?: number;
  avifSubsample?: number;
}

/** The effective profile config for ONE ref: the formats to fan out + the global bag to feed formatEncode.
 *  `global` is exactly FormatEncodeGlobal so the worker passes it straight into formatEncode. */
export interface ResolvedProfile {
  formats: FormatTarget[];
  global: FormatEncodeGlobal;
}

/** Resolve the effective profile (formats + global) for ONE ref of ONE kind. Starts from the validated
 *  base, folds EVERY matching override IN ARRAY ORDER (later wins). No-match ⇒ base returned BY REFERENCE
 *  unchanged (so a no-override / no-match run is structurally identical ⇒ byte-identical fan-out). Pure,
 *  deterministic — no Date/Math.random, no object-key iteration (overrides is an ordered array). */
export function resolveProfileForRef(
  ref: string,
  kind: FixAssetKind,
  baseFormats: FormatTarget[],
  baseGlobal: FormatEncodeGlobal,
  overrides?: ProfileOverride[],
): ResolvedProfile {
  let formats = baseFormats; // shared until an override touches it — no needless copies (additivity anchor)
  let global = baseGlobal;
  if (overrides) {
    for (const o of overrides) {
      if (!overrideMatches(o.match, ref, kind)) continue; // REUSED predicate (settings.ts:62-67)
      if (o.formats) formats = o.formats; // REPLACE (atomic)
      if (o.quality !== undefined || o.near !== undefined || o.lossless !== undefined) {
        formats = formats.map((f) => overlayFormat(f, o)); // per-format overlay (fresh objects)
      }
      if (o.effort !== undefined || o.avifSubsample !== undefined) {
        global = {
          effort: o.effort ?? global.effort,
          scaleAwareQuality: global.scaleAwareQuality, // profile-global, not override-settable in v1
          avifQualityAlpha: global.avifQualityAlpha,   // profile-global in v1
          avifSubsample: o.avifSubsample ?? global.avifSubsample, // the fonts→4:4:4 merge
          pngRecompressLevel: global.pngRecompressLevel, // profile-global in v1
        };
      }
    }
  }
  return { formats, global };
}

/** Apply quality/near/lossless ONLY where the codec honors them — png ignores all (native lossless);
 *  avif ignores lossless+near (no faked-lossless, invariant 3); webp honors all. Mirrors formatEncode's
 *  per-format rules (settings.ts:145-177) so the overlay can't diverge from the encode. Returns a fresh
 *  object only when it changes the target (no-op fields ⇒ identical fields). */
function overlayFormat(f: FormatTarget, o: ProfileOverride): FormatTarget {
  if (f.format === 'image/png') return f; // native lossless — nothing to overlay
  if (f.format === 'image/avif') {
    return o.quality !== undefined ? { ...f, quality: o.quality } : f; // no lossless/near on avif
  }
  const next: FormatTarget = { ...f }; // webp
  if (o.lossless !== undefined) next.lossless = o.lossless;
  if (o.quality !== undefined) next.quality = o.quality;
  if (o.near !== undefined) next.near = o.near;
  return next;
}
```

**Determinism & additivity (asserted by test T4):** identical inputs ⇒ identical output; later-wins mirrors `resolveOptions`; iteration is over the ordered `overrides` array (no object-key hazard); no-match ⇒ `baseFormats`/`baseGlobal` returned by reference ⇒ the worker calls `formatEncode(f, scale, baseGlobal)` on the SAME objects it does today ⇒ byte-identical.

**Precedence statement (exact):** overrides are applied in `overrides[]` array order; for each matching entry, `formats` REPLACE wins outright (LAST matching `formats` is final), and each scalar overlay re-applies `?? running` (LAST matching value of each scalar is final). This is "later-wins, field-by-field" — chosen for byte-parity with the shipped `resolveOptions` fold and its goldens. **Documented in the type's doc comment AND in the design's edge table.**

---

## 4. Validation (`validateProfile`, `packages/fix/src/scale.ts:138-177`)

Validate `overrides[]` in the SAME pass (so an invalid override fails the whole profile closed — `fix.worker.ts:297-298` already turns each reason into a `(profile)` skip). Factor the existing per-format loop (142-168) into a private `validateFormatList(formats, label, errors)` so the format-axis rules (empty / bad-format / **lossless-avif** / bad-quality / bad-near / dup-target) are applied to BOTH `p.formats` and each `o.formats` and **cannot drift**.

Per override `i`:
- `if (o.formats)` → `validateFormatList(o.formats, \`override[${i}].formats\`, errors)`.
- scalars: `quality`/`near` ∈ [0,100] when present; `effort` ∈ [0,6]; `avifSubsample` a finite integer; reject `o.match.trim() === ''` (`override[${i}]: emptyMatch` — a blank UI row must never silently match).
- `o.lossless` needs no extra rule: `overlayFormat` drops it on avif (honesty preserved structurally) and validation already forbids lossless-avif in `o.formats`.
- All errors prefixed `override[i]: …` so the worker's `(profile)` skip names the failing rule.

Success shape carries the validated overrides so the worker reads them from the validation result, not raw `opts.exportProfile.overrides`:
```ts
export type ProfileValidation =
  | { ok: true; formats: FormatTarget[]; tiers: ScaleTier[]; overrides: ProfileOverride[] }
  | { ok: false; errors: string[] };
```
Empty/absent overrides ⇒ `overrides: []`. (Update the existing success return at `scale.ts:176` to add `overrides: p.overrides ?? []`.)

---

## 5. Worker wiring (`apps/web/src/worker/fix.worker.ts`)

Capture validated overrides next to `profileFormats` (300-303):
```ts
let profileOverrides: ProfileOverride[] = []; // alongside profileFormats
// in the v.ok branch:
profileOverrides = v.overrides;
```
A tiny per-ref helper next to `kindOf` (414) so every site calls ONE thing:
```ts
const resolveProfile = (ref: string) =>
  resolveProfileForRef(ref, kindOf(ref), profileFormats, profileGlobal, profileOverrides);
```

**Site A — `emitLooseProfileFanout` (994-1054).** It already has `ref`. Resolve at entry; use `rp.formats` in the 1013 loop and `rp.global` in `formatEncode` (1014); derive `refMulti = rp.formats.length > 1`:
```ts
const rp = resolveProfile(ref);
const refMulti = rp.formats.length > 1;
for (const f of rp.formats) {
  const fe = formatEncode(f, scale, rp.global);
  …
}
```
This single change ALSO covers the **format-only standalone pass** (2086-2116), which calls `emitLooseProfileFanout` (2106), and the **resize/transcode owner fan-out** (1388, 1443). `recordVariant(ref, 'loose', srcPath, {suffix:'', src})` (1034) is untouched, so overrides ride the EXISTING manifest+hash path (`hashEmit` at 1031) — **round8 manifest + round9 cache-busting see the overridden emitted set automatically** (the manifest/hash key on the actual emitted bytes/paths, not on `profileFormats`). This rebuts the draft's worry: no special handling needed beyond using `rp.formats`.

**Site B — tier loop (1915-2039).** `ref` in scope (1864). Resolve before 1946; feed `rp.formats`/`rp.global` into the 1947-1949 map; use `refMulti` for the Spine note and every `variantManifestName`:
```ts
const rp = resolveProfile(ref);
const refMulti = rp.formats.length > 1;
const tierEncodes = profileOn
  ? rp.formats.map((f) => {
      const fe = formatEncode(f, tier.scale, rp.global);
      return { mime: isSpine ? 'image/png' : fe.targetMime, encOpts: feToEncodeOpts(fe), fmtLabel: f.format };
    })
  : [/* legacy descriptor — UNCHANGED */];
```
Replace `profileMulti` with `refMulti` at the THREE `variantManifestName(..., profileMulti)` calls (2002, 2012, 2018) — but resolve `refMulti` ONCE per ref above (not inside the format loop). The Spine multi-note (1892) must use the per-ref count too:
```ts
const rpSpine = resolveProfile(ref); // resolve once before the tier loop opens
if (profileOn && (rpSpine.formats.length > 1) && isSpine) { skipped.push({…}); }
```
(Compute `rp`/`refMulti` ONCE per `ref` before `for (ti…)` and reuse inside.)

**Spine stays PNG** — the `isSpine ? 'image/png'` guard (1949, 2002) already enforces this; an override redirecting a Spine to webp/avif cannot change the page format. The only behavioral change is the honest multi-note keying on the per-ref count.

**Pack-target sites (1517/1592/1611) UNTOUCHED** — they use `resolveOptions(group.outDir, …, opts.overrides)` (the LEGACY sheet path). Profile-overrides govern only the loose/tier reference-changing paths, consistent with how the global profile already excludes repack/merge sheets (these sites are NOT profile-gated).

**Dedup Phase-A prediction (771-784) — M2 fix, load-bearing.** Today `targetMime: transcoded ? effectiveFor(ref,1).targetMime : opts.targetMime`. Under `profileOn`, a transcoded owner actually fans out via `emitLooseProfileFanout`, whose canonical owner image = `renamedTo(srcPath, <mime of rp.formats[0]>)`. Make the prediction match:
```ts
const targetMime = transcoded
  ? (profileOn ? mimeOf(resolveProfile(ref).formats[0]!) : effectiveFor(ref, 1).targetMime)
  : opts.targetMime;
```
where `mimeOf(f) = f.format` (FormatTarget.format IS an ImageMime). This both honors overrides AND fixes the pre-existing latent divergence (the prediction was already wrong for profile-on owners — Phase C silently kept consumers). Add a one-line comment that `rp.formats[0]` is the canonical owner rename basis. The Phase-C divergence guard (`ownerImageUnhashed`, 1041) remains the backstop.

**The legacy `effectiveFor` path is left intact** — it still uses `opts.overrides` for profile-OFF runs and the pack-sheet sites. Profile-overrides and `opts.overrides` are independent (B2): when `profileOn`, `opts.overrides` is inert on the fan-out paths (it always was).

---

## 6. UI — compact override editor (`apps/web/src/App.tsx`, `ExportProfilePanel`, after the resolutions block ~L865-900)

The panel already owns formats + custom tiers (786-806). Add overrides INSIDE the profile panel (NOT the legacy `SettingsPanel` override editor at 489-525 — that one feeds `opts.overrides`, a different field; keep them separate and labeled distinctly to avoid user confusion). Lift override state into `App` next to `customTiers` (988) so the `exportProfile` memo (1004-1015) can map it:

- **State:** `const [profileOverrides, setProfileOverrides] = useState<UiOverride[]>([])`, `UiOverride = { match: string; mode: 'fonts444' | 'quality' | 'lossless'; quality?: number }`.
- **Preset button** `+ Fonts → AVIF 4:4:4` ⇒ push `{ match: 'fonts', mode: 'fonts444' }`. Default state is `[]` (pure additive — NOT `['fonts']`; a non-empty default would break byte-identity). Opt-in only.
- **Generic `+ Override`** ⇒ a row: `match` text input (placeholder `ui/buttons`), `mode` select (Quality / Lossless / Fonts 4:4:4), a quality number when `mode==='quality'`, remove button (mirror 519).
- **Map in the `exportProfile` memo (1004-1015)** — extend the returned object:
  ```ts
  const overrides: ProfileOverride[] = profileOverrides
    .filter((o) => o.match.trim() !== '')
    .map((o) =>
      o.mode === 'fonts444'
        ? { match: o.match, formats: [{ format: 'image/avif', quality: o.quality ?? 85 }], avifSubsample: 3 }
        : o.mode === 'lossless'
          ? { match: o.match, lossless: true }
          : { match: o.match, quality: o.quality ?? 85 });
  return { formats, tiers, ...(overrides.length > 0 ? { overrides } : {}) }; // omit when empty ⇒ additive
  ```
- Add `profileOverrides` to the memo deps (1015) AND to `buildOptions`' effect/dep array (1162). `buildOptions` needs NO change beyond the memo (overrides ride inside `exportProfile`, already forwarded at 1086).
- **Additivity:** empty `profileOverrides` ⇒ `overrides` omitted (undefined) ⇒ `exportProfile` identical to today.

---

## 7. i18n (`packages/i18n/src/catalogs/*.json`, EN source of truth)

Add next to `fix.profile.*` (en.json 299-315), then all 9 catalogs (en/ru/de/es/pt/fr/it/zh/hi):
- `fix.profile.overrides`: "Per-folder overrides"
- `fix.profile.overridesHint`: "Override formats or quality for a folder prefix (e.g. fonts → AVIF 4:4:4)."
- `fix.profile.overrideFonts444`: "Fonts → AVIF 4:4:4"
- `fix.profile.addOverride`: "Add override"
- `fix.profile.overrideMode.quality` / `.lossless` / `.fonts444`
- `fix.profile.overrideMatchPlaceholder`: "folder prefix or type:loose"

EN updated first; run the i18n drift test (`pnpm --filter @asset-doctor/i18n test`).

---

## 8. Edge cases (defined behavior)

| Case | Behavior |
|---|---|
| no override matches a ref | `resolveProfileForRef` returns base formats/global BY REFERENCE ⇒ `formatEncode` runs on the same objects ⇒ byte-identical to no-override |
| `overrides` empty/absent | `validateProfile` → `overrides:[]` ⇒ resolver loop no-ops ⇒ **byte-identical** to a no-override profile |
| profile itself absent | `profileOn` false ⇒ whole branch skipped ⇒ **byte-identical to pre-round7** |
| multiple matches on one ref | array order, later wins (formats: last `formats`; scalars: last value of each) |
| `override.formats:[]` | **rejected** by `validateFormatList` (emptyFormats) ⇒ `override[i]: emptyFormats` ⇒ whole profile fails closed (no emit) |
| override redirects Spine→webp | page stays PNG (1949/2002 guard); honest per-ref multi note if `rp.formats.length>1` |
| `type:loose` override + atlas ref | `overrideMatches` false (kind mismatch via `kindOf`) ⇒ atlas unaffected |
| sibling-prefix `fonts` vs `fonts2` | exact-or-`/`-prefix ⇒ `fonts2` NOT matched |
| case `Fonts` vs `fonts` | case-SENSITIVE ⇒ NOT matched (documented; matches the legacy override + ingest key case) |
| override `lossless:true` on avif format | `overlayFormat` drops it (avif honors only quality) ⇒ never faked-lossless (invariant 3) |
| dedup owner with format override | Phase-A predicts `rp.formats[0].format` (M2) ⇒ no silent dedup degrade |
| override changes per-ref format count | `refMulti` derived per ref ⇒ correct single/multi manifest names; siblings keep their own token |

---

## 9. Honesty / invariants

- **1–2 (thin/browser):** all resolution is pure TS in `packages/fix`; no server, no native libs. Dropped knobs (pngquant/kernels/maxTexSize) are exactly the non-browser/non-honest ones.
- **3 (objectivity / no faked-lossless):** `validateFormatList` rejects lossless-avif in overrides; `overlayFormat` never sets lossless on avif.
- **5 (disk≠VRAM):** overrides change per-file encode params only; the existing `fix.profile.diskNote` (en.json:315) and the tier loop's single-VRAM-per-tier rule (2035-2038) still hold — fan-out is a file count, never a saving.
- **Determinism:** ordered-array fold, later-wins, no object-key iteration, no Date/random (asserted by `settings.ts:1-3` + test T4).

---

## 10. Ordered task breakdown (small commits)

| id | title | files | deps | acceptance |
|----|-------|-------|------|-----------|
| **T1** | core: `ProfileOverride` type + `ExportProfile.overrides?` | `packages/core/src/index.ts` (after L170) | — | typecheck green; doc states additivity (absent/empty⇒identical) + case-sensitive match |
| **T2** | fix: factor `FormatEncodeGlobal` out of `formatEncode`'s param; no behavior change | `packages/fix/src/settings.ts` (131-141), `index.ts` | — | existing settings goldens still pass |
| **T3** | fix: `ProfileOverride` mirror + `ResolvedProfile` + `resolveProfileForRef` + `overlayFormat`; export | `packages/fix/src/settings.ts`, `index.ts:41-42` | T1,T2 | pure; REUSES `overrideMatches`; no-match ⇒ base returned by reference |
| **T4** | fix: `validateProfile` validates `overrides[]` (factor `validateFormatList`); success carries `overrides` | `packages/fix/src/scale.ts` (138-177), `index.ts` (ProfileValidation) | T1 | rejects lossless-avif / empty-formats / bad-quality/near / bad-effort / empty-match in overrides; prefixes `override[i]:` |
| **T5** | fix tests: `resolveProfileForRef` goldens + `validateProfile` override cases | `packages/fix/test/settings.test.ts`, `scale.test.ts` | T3,T4 | covers no-match identity (by reference), fonts→4:4:4 (formats REPLACE + avifSubsample merge), quality/near/lossless overlay, png/avif carve-outs, later-wins, sibling-prefix + case non-match, lossless-avif + empty-formats rejection, determinism (double-call eq) |
| **T6** | protocol: doc that overrides ride `ExportProfile.overrides` (no new wire field); note independence from `opts.overrides` | `apps/web/src/worker/fix-protocol.ts` (59-67, 124-131 comment) | T1 | typecheck; confirm `exportProfile.overrides` threads via `buildOptions` untouched |
| **T7** | worker: capture `profileOverrides` from validation; `resolveProfile` helper; wire `emitLooseProfileFanout` (covers loose + format-only standalone + owner fan-out) with `rp.formats`/`rp.global`/`refMulti` | `fix.worker.ts` (300-303, 414, 994-1054) | T3,T4 | loose fan-out honors fonts→4:4:4; no-override ⇒ existing `export-profile-fanout.test.ts` green |
| **T8** | worker: wire tier loop — `rp` once per ref, `refMulti` for Spine note + all three `variantManifestName` calls | `fix.worker.ts` (1892, 1946-2026) | T7 | tiered profile honors per-ref overrides; Spine stays PNG; per-ref multi naming |
| **T9** | worker: feed `resolveProfile(ref).formats[0].format` into dedup Phase-A `targetMime` under `profileOn` (fixes pre-existing latent divergence too) | `fix.worker.ts` (771-784) | T7 | dedup owner with a format-override predicts its real first format; Phase-C guard not falsely tripped |
| **T10** | UI: override editor in `ExportProfilePanel` (fonts-444 preset + add-rule) + `UiOverride→ProfileOverride` in `exportProfile` memo; lift state, wire deps | `apps/web/src/App.tsx` (788-, 988, 1004-1015, 1162) | T1 | empty rows ⇒ overrides omitted; preset emits `{match:'fonts',formats:[avif],avifSubsample:3}`; distinct from the legacy SettingsPanel override editor |
| **T11** | i18n: `fix.profile.overrides*` keys to all 9 catalogs (EN first) | `packages/i18n/src/catalogs/*.json` | T10 | i18n drift test green |
| **T12** | full verify: `pnpm typecheck && pnpm test && pnpm lint` + an additivity assertion (a profile with `overrides:[]` emits a byte-identical zip to no-overrides) | — | T1–T11 | all green |

---

## Key files (absolute)

- `/home/nonamezzz/Рабочий стол/projects/packages/core/src/index.ts` — `ExportProfile` L155-170 (incl. existing global knobs 160-169), `FormatTarget` L131-139, `ExportFormat` L124 (T1)
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/settings.ts` — `overrideMatches` L62-67, `resolveOptions` L75-96 (precedence pattern), `EffectiveOptions`/`FixOverride` mirror L39-59, `formatEncode` + its `global` param L131-178 (T2,T3)
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/scale.ts` — `validateProfile` L138-177, per-format loop to factor L142-168, success return L176, `ProfileValidation` L117-119 (T4)
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/index.ts` — exports L29-42 (T2,T3,T4)
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/test/settings.test.ts` (resolveOptions goldens L60-114 to mirror), `scale.test.ts` (T5)
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix.worker.ts` — profile capture L290-315, `profileGlobal` L309-315, `kindOf`/`effectiveFor` L414-419, dedup Phase-A L771-784, `emitLooseProfileFanout` L994-1054, owner fan-out L1426-1452, tier loop L1892/1915-2039, format-only standalone L2086-2116, pack-sheet sites (UNTOUCHED) L1517/1592/1611 (T7,T8,T9)
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix-protocol.ts` — `FixOptions.overrides` (legacy) L47, `exportProfile` L67, `FixOverride` L124-131 (T6)
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx` — `ExportProfilePanel` L786-900, legacy override editor in `SettingsPanel` L489-525 (KEEP SEPARATE), `exportProfile` memo L1004-1015, `customTiers` state L988, `buildOptions` L1052-1093, deps L1162 (T10)
- `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/en.json` — `fix.profile.*` L299-315 (T11)

**Reuse confirmed (no new machinery):** `overrideMatches` (THE predicate), `formatEncode` + new shared `FormatEncodeGlobal` (THE encode mapping), `profileGlobal` (THE live global bag, 309-315), `recordVariant`/`hashEmit` (THE manifest + cache-bust path overrides ride automatically), `validateProfile`/`validateFormatList` (THE validation), `resolveOptions`' later-wins fold (THE precedence). The new `ProfileOverride` is additive on `ExportProfile` and **independent of** the pre-existing `opts.overrides` legacy folder editor (which stays inert during profile fan-out).