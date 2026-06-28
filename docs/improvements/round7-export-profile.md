Critical finding confirmed: the existing `encOptsFor`/`effectiveFor`/`EffectiveOptions` path **does NOT thread a `lossless` flag** for loose transcode or tier emits. The only `lossless:true` in the loose/transcode path comes from `op.lossless` set in `plan.ts:268` (per-finding content-class), and that is handled in a separate `transcode` op branch — but the tier loop (`encOptsFor(eff, true)`) and loose-resize never set lossless. The design's `formatEncode` must add lossless to `EncodeOpts`, which the worker's `encOptsFor` currently drops. This is a real gap the design glosses over.

I have everything needed. Let me write the final revised design.

---

# ADVERSARIAL REVIEW + FINAL REVISED DESIGN — Config-Driven Export Profile (v1)

## Part A — Verification verdict (code-grounded)

I read every cited file. The draft is **largely accurate** on the big claims but has **5 real blockers/majors** and several drifted citations. Summary of what held vs. broke:

### Claims VERIFIED true
- **Single hardcoded target/quality**: `App.tsx:856-857` — `targetMime:'image/avif'`, `quality:0.85`. ✅
- **Closed tier ladder**: `scale.ts:19-23` `DEFAULT_SCALE_TIERS`; UI in `TierPanel` (App.tsx:679+). ✅
- **`encodeCanvas` honors lossless / near-lossless / effort / avifSubsample / pngRecompressLevel**: `fix.worker.ts:1712-1772`. ✅ Native `convertToBlob` IS the lossy WebP fast-path (`:1755`) — **native WebP lossy quality works in-browser** (truth confirmed in code). AVIF + lossless-WebP + near-lossless route through `@jsquash` (`:1718,:1741`). ✅
- **Tier loop reuses one source bitmap, one drawImage per tier** (`:1483-1484`), `effectiveFor`/`encOptsFor` (`:321-334`), `tieredName` ext-swap (`scale.ts:51-55`). ✅
- **AVIF has NO lossless in our wiring** (`:1721-1727` passes no `lossless:1`) — so **rejecting lossless-AVIF is correct and honest**. ✅
- **Spine pages stay PNG** (`:1490`), repack/merge sheets stay lossless WebP (`:897`). ✅
- **`FixChange.to` is already `string[]`** (fix-protocol.ts:135). ✅
- **`tierVram` never summed into `vramBytesAfter`** (fix-protocol.ts:216-219). ✅
- **AVIF→WebP silent fall-through** exists (`:1729-1732`) — edge case 3 is a **real** risk. ✅

### BLOCKERS / MAJORS (draft is wrong or under-scoped)

**B1 — `lossless` is NOT threaded through the loose/tier encode path. (BLOCKER)**
The draft's `FormatTarget.lossless` and `formatEncode.lossless` assume the worker can pass lossless to `encodeCanvas`. It can't today: `EffectiveOptions` (settings.ts:49-54) has **no `lossless` field**, and `encOptsFor` (`:326-334`) **never sets `EncodeOpts.lossless`**. The only lossless in loose-transcode comes from `op.lossless` (plan.ts:268, per-finding content-class) inside the separate `transcode` op — not reachable from the tier loop or the profile loop. **The draft's per-format `lossless` toggle is real work that requires adding a `lossless` field to the worker's encode opts builder, not "already wired."** Without this, a profile asking for "lossless WebP" silently emits lossy WebP — a faked-lossless (invariant 3) violation.

**B2 — Test plan cites a non-existent harness. (MAJOR)**
There are **no worker tests, no Playwright, no OffscreenCanvas mock** anywhere (`apps/web/src/worker/*.test.ts` = none; no `@playwright`). Pure fix tests live in **`packages/fix/test/`** (not `src/`): `scale.test.ts`, `settings.test.ts` exist. The draft's "Worker integration (Vitest with OffscreenCanvas mock, or Playwright e2e)" and "golden hash byte-identity" tests describe infrastructure that **does not exist**. Byte-identity must be proven by **pure-layer golden tests + a worker-path code-review assertion**, not a fictional e2e harness. Cut/rescope §11 honestly.

**B3 — Format-only profile routing is hand-waved and risks a double-emit regression. (MAJOR)**
The draft's §5d "set `profileTiers` to include the `_1x` top tier so the loop runs at scale=1" collides with the **existing plan/worker exclusion machinery**. The plan's `tiered` guard (plan.ts:213-225) only excludes refs from standalone resize/transcode when `tieringOn && !folderAlreadyTiered` AND `tierEligible`. If the worker fabricates a `_1x`-only ladder to force the tier loop, it ALSO trips: `folderAlreadyTiered` detection, the dedup×tier repoint-disable (plan.ts:110, `disableOwnerRepoint`), the `tierChanges` SET→SET rows, `referencesChanged=true` even when nothing was downscaled, and the `'tier'` OpKind in selective-fix. A pure-format run (avif+webp at scale 1) would be mislabeled as a "tier" op and would rename owners and disable dedup repoint — a **behavior regression**. The format fan-out must be a **first-class concept**, not a `_1x` tier hack.

**B4 — Manifest-collision claim is only half-right; the IMAGE collides too in one case. (MAJOR)**
The draft says multi-format images never collide because extensions differ. True for the image (`btn_720p.webp` vs `btn_720p.avif`). **But** if a profile requests **PNG + (AVIF-that-falls-back-to-PNG)** — or PNG + a WebP-that-fails-to-PNG-fallback — two targets resolve to the **same** `.png` name → image clobber. The draft's edge-case 3 only guards the AVIF→WebP collision, not AVIF→PNG / WebP→PNG. Fan-out collision detection must key on the **actual emitted mime**, post-encode, for **every** pair — not just AVIF-vs-WebP.

**B5 — Drifted line citations (MINOR but pervasive).** Real anchors today: tier loop `1409-1552` (draft said 1409-1552 ✓ but inner emit is `1489-1531` ✓); `baseEffective` at **313** (draft said 1683 — wrong, that's `EncodeOpts`); loose transcode `1029-1057` ✓, resize loose `1006-1027` ✓; `encodeCanvas` `1712` ✓; UI `buildOptions` `853` ✓, deps `949` ✓; `scaleTiers` derivation `813-815`; core `ScaleTier` `107-110`. The draft's "near `baseEffective`, fix.worker.ts:1683" is a wrong anchor (1683 is inside `EncodeOpts`). Fixed below.

### Things the draft got RIGHT to cut (honest browser subset)
- **No pngquant / lossy-PNG quantization** — correctly excluded (`fix.skipped.whyNoPngquant` already in en.json:243). ✅
- **No resampling kernel / pre-blur** — native-only; disclosed via `whyNoKernel`/`whyNoPreBlur` (en.json:241-242). ✅
- **No lossless AVIF** — no `@jsquash` path; rejecting is the honest call. ✅
- **No JPEG sheet emit** — `ExportFormat` excludes jpeg; correct (JPEG has no alpha, wrong for game atlases). ✅

### One capability the draft OVER-claims as free
`avifSubsample` UI is **gated** today (`fix-protocol.ts:35-37`: "UI toggle GATED until Task 14 verifies 0/1/2 mapping"; `whyNoChroma` en.json:244). The draft exposes `avifSubsample` in the profile type — keep it as a **field** (3=YUV444 is confirmed) but do **not** add a free-choice UI control beyond what's gated; honor the existing gate.

---

## Part B — FINAL REVISED DESIGN (implementation-ready)

# Asset Doctor — Config-Driven Export Profile (v1)

## 0. Problem & shape
The fix engine emits **one format** (`'image/avif'`, App.tsx:856) at **one quality** (`0.85`, App.tsx:857), tiers limited to the closed `_1080p/_720p/_540p` ladder (scale.ts:19-23). Per-format lossless is **not reachable** from the loose/tier encode path today (B1). v1 adds an additive `ExportProfile` on `FixOptions` generalizing **resolutions × formats × per-format compression**. **Absent profile ⇒ byte-identical to today.**

## 1. v1 scope
**(a) Resolutions from config** — arbitrary `{label, scale, suffix}` list; reuses `ScaleTier`/`validateTiers` (scale.ts:73-101).
**(b) Format targets from config** — emit one-or-more of png/webp/avif per run, each lossless and/or lossy, via a **first-class format fan-out** (NOT a `_1x` tier hack — B3). Honest browser subset only.
**(c) Compression from config** — per-format `quality` 0..100, `lossless`, webp `near`, plus global `effort`/`avif*`/`pngRecompressLevel`. **`lossless` requires new plumbing (B1).**

### Out-of-scope (defer, §13)
PixiJS bundle manifest; content-hash cache-busting; resampling kernel/pre-blur (native-only, disclosed); JPEG sheet & pngquant (not browser-honest); per-folder profile overrides (global `overrides[]` stays); repack/merge sheet format (lossless WebP) + Spine pages (PNG) unchanged — the profile governs **loose-transcode, loose-resize, and tier** emits only.

## 2. Core types (additive, `packages/core/src/index.ts`, after `ScaleTier` @107-110)

```ts
/** Honest browser subset only: png | webp | avif. NO jpeg (no alpha), NO pngquant (native-only).
 *  `quality` 0..100 → LOSSY encodes (webp/avif); ignored when `lossless` or for png. `lossless`:
 *  webp→@jsquash lossless; png→native(+oxipng if pngRecompressLevel set); AVIF lossless is REJECTED
 *  in validateProfile (no @jsquash lossless-avif path in encodeCanvas:1721 — never a faked-lossless).
 *  `near` (webp only) 0..100, 100/omit ⇒ off (maps to @jsquash near_lossless, encodeCanvas:1745). */
export type ExportFormat = 'image/png' | 'image/webp' | 'image/avif';

export interface FormatTarget {
  format: ExportFormat;
  quality?: number;   // 0..100; omit ⇒ profile default 85. Ignored when lossless.
  lossless?: boolean; // webp/png only; REJECTED for avif.
  near?: number;      // webp near-lossless 0..100 (100/omit ⇒ off). Ignored for non-webp.
}

/** One resolution rung. `label` is presentation-only; `suffix` is the on-disk RESOLUTION_TOKEN
 *  (scale.ts:31). Structurally ScaleTier + label — worker derives ScaleTier[] by dropping label. */
export interface ResolutionTier { label: string; scale: number; suffix: string; }

/** Config-driven export profile (v1). ADDITIVE on FixOptions — ABSENT ⇒ byte-identical to today.
 *  When present it REPLACES the single targetMime + closed ladder for the loose-transcode / loose-resize
 *  / tier (reference-changing) paths only. Repack/merge sheets + Spine pages keep runtime-safe formats. */
export interface ExportProfile {
  formats: FormatTarget[];     // ≥1; emits one file per (format × tier) per eligible asset.
  tiers: ResolutionTier[];     // ≥1; MUST include exactly one scale===1 top tier (validateTiers).
  effort?: number;             // 0..6, all formats. Omit ⇒ 0 (native fast-path).
  pngRecompressLevel?: number; // oxipng 0..6 on png emits. Omit ⇒ off.
  avifSubsample?: number;      // 3=YUV444. Omit ⇒ @jsquash default. (UI stays gated — fix-protocol:35.)
  avifQualityAlpha?: number;   // Omit ⇒ -1.
  scaleAwareQuality?: boolean; // Pure formula (settings.ts:26). Omit ⇒ off.
}
```
**Determinism**: all numbers integer/finite, no Date/random.

## 3. Protocol (`apps/web/src/worker/fix-protocol.ts`)

**`FixOptions`** (after `scaleTiers` @54):
```ts
/** Config-driven export profile (design §2). ADDITIVE: absent ⇒ byte-identical to today. When present it
 *  is the SOLE source of formats + resolutions + per-format compression for the loose-transcode /
 *  loose-resize / tier paths; SUPERSEDES legacy targetMime + scaleTiers + webpNearLossless for those paths.
 *  Repack/merge sheets (lossless WebP) + Spine pages (PNG) UNCHANGED. Validated fail-closed (validateProfile):
 *  ≥1 format, ≥1 tier with a scale===1 top, no lossless-AVIF, valid suffix tokens, no dup targets.
 *  Invalid ⇒ NO emit + honest skipped[] entry. MUTUALLY EXCLUSIVE with scaleTiers (buildOptions omits
 *  scaleTiers when a profile is sent — never both, §7). */
exportProfile?: ExportProfile;
```

**`EffectiveOptions` gains `lossless` (B1 fix) — see §4b.**

**`FixReceipt`** (after `tierVram` @219):
```ts
/** Export-profile summary. `formats`/`tiers` = validated counts; `filesEmitted` = total variant files
 *  (Σ assets × emitted formats × tiers); `assets` = assets fanned out. Absent ⇒ no profile ran. The
 *  per-tier VRAM ladder is STILL `tierVram` (never summed; invariant 5). Format fan-out adds DISK only —
 *  the runtime loads ONE format × ONE tier — so it contributes 0 to vramBytesAfter. */
exportProfile?: { formats: number; tiers: number; assets: number; filesEmitted: number };
```

## 4. Pure module changes

### 4a. `packages/fix/src/scale.ts` — `validateProfile` + `tiersOf` + format-token helpers
`validateTiers` (scale.ts:73-101) reused **unchanged** for the resolution axis.
```ts
/** Strip ResolutionTier → ScaleTier (drop label). Pure, order-preserving. */
export function tiersOf(tiers: ResolutionTier[]): ScaleTier[];

export type ProfileValidation =
  | { ok: true; formats: FormatTarget[]; tiers: ScaleTier[] }
  | { ok: false; errors: string[] };

/** Fail-closed validation. Rejects: empty formats; non-png/webp/avif format; lossless:true on avif
 *  (no honest path, encodeCanvas:1721); quality∉[0,100]; near∉[0,100]; DUPLICATE (format,lossless,
 *  quality,near) targets (clobber risk); + every validateTiers rejection (delegated). Deterministic:
 *  formats in given order, tiers via validateTiers' high→low sort. */
export function validateProfile(p: ExportProfile): ProfileValidation;

/** Format token: '' when !multi (single-format ⇒ byte-identical legacy naming), else '.webp'/'.avif'/'.png'. */
export function formatToken(mime: ImageMime, multi: boolean): string;
/** Variant manifest/skeleton/atlas name with the format token BEFORE the resolution suffix's ext:
 *    btn → "btn_720p.json" (single) | "btn_720p.webp.json" (multi). Pure string math. */
export function variantManifestName(manifestPath: string, suffix: string, mime: ImageMime, multi: boolean): string;
```
Re-export all from `packages/fix/src/index.ts` (alongside the existing `scale` re-export @35).

### 4b. `packages/fix/src/settings.ts` — add `lossless` to `EffectiveOptions` (B1) + `formatEncode`
**This is the B1 fix — not optional.**
```ts
export interface EffectiveOptions {
  quality: number; effort: number; targetMime: ImageMime; webpNearLossless: number;
  lossless: boolean; // NEW — defaults false; resolveOptions threads it (overrides may NOT set it in v1).
}

/** Map one FormatTarget + scale + global knobs → EncodeOpts-shaped fields the worker passes to
 *  encodeCanvas. Folds scaleAwareQuality (settings.ts:26, floor 50) onto the format's quality. Pure.
 *  PNG: quality irrelevant (native lossless); lossless implied. WEBP: lossless | near | lossy.
 *  AVIF: lossy only (validateProfile rejected lossless-avif). */
export interface FormatEncode {
  targetMime: ImageMime; quality: number; lossless: boolean; effort: number; webpNearLossless: number;
  avifQualityAlpha?: number; avifSubsample?: number; pngRecompressLevel?: number;
}
export function formatEncode(
  fmt: FormatTarget, scale: number,
  global: { effort: number; scaleAwareQuality: boolean; avifQualityAlpha?: number; avifSubsample?: number; pngRecompressLevel?: number },
): FormatEncode;
```
Existing callers of `EffectiveOptions` construct it in **one place** (`baseEffective`, fix.worker.ts:313) plus `resolveOptions` spread — both updated to default `lossless:false` (back-compat: today never sets lossless on loose, so default-false is byte-identical).

### 4c. `packages/fix/src/plan.ts` — no signature change
When `exportProfile` present, the worker derives `scaleTiers = tiersOf(profile.tiers)` **only for the resolution axis** and passes it to `planFix` exactly as today (so resize/transcode exclusion via `tiered` works for **multi-tier** profiles). **For format-only profiles (single scale-1 tier), the worker does NOT pass scaleTiers to planFix** (avoids B3's tier-machinery side effects); instead it routes format-improvable refs through the profile loop and excludes them from standalone transcode via a **worker-side `profileOwned` set** (mirroring how `replaced`/`dropped` already gate, fix.worker.ts:1438). No plan.ts edit.

## 5. Worker changes (`apps/web/src/worker/fix.worker.ts`) — anchors corrected (B5)

### 5a. Resolve + validate the profile once (near `baseEffective`, **fix.worker.ts:313**, not 1683)
```ts
let profileOn = false; let profileFormats: FormatTarget[] = []; let profileTiers: ScaleTier[] = [];
let profileMulti = false;
if (opts.exportProfile) {
  const v = validateProfile(opts.exportProfile);
  if (!v.ok) v.errors.forEach((e) => skipped.push({ assetRef: '(profile)', reason: `export profile rejected: ${e}` }));
  else { profileFormats = v.formats; profileTiers = v.tiers; profileMulti = v.formats.length > 1; profileOn = true; }
}
```
**Tier-axis wiring (B3-safe):** when `profileOn`, the worker sets the existing `tiers`/`tieringOn` (fix.worker.ts:238-239) from `profileTiers` **only if `profileTiers` has a real lower tier** (`some(scale<1)`). A format-only profile (single scale-1 tier) keeps `tieringOn=false` — the tier loop is NOT entered, and fan-out happens in the transcode/resize handlers (§5d). This is the key fix: **format fan-out is decoupled from the tier multiplier.**

### 5b. Naming (B4-safe)
- **Image**: `tieredName(imagePath, suffix, enc.mime)` — ext disambiguates formats. **But** collisions are possible when two targets resolve to the **same actual mime** post-encode (AVIF→WebP→PNG fallbacks). Detect by a per-asset-per-tier `Set<string>` of emitted paths; on collision, **skip the later variant** with an honest `skipped` note (B4) — never overwrite.
- **Manifest/.atlas/skeleton**: `variantManifestName(path, suffix, enc.mime, profileMulti)` — format token only when `profileMulti` (single-format ⇒ byte-identical legacy `.json`).

### 5c. Inner format loop inside the tier loop (**fix.worker.ts:1489-1531**)
Wrap the single-mime emit body in `for (const fmt of formatsToEmit)` where `formatsToEmit = profileOn ? profileFormats : [legacyTarget]`:
```ts
const emittedThisTier = new Set<string>();      // B4 collision guard, per (asset,tier)
for (const fmt of formatsToEmit) {
  const tierMime: ImageMime = isSpine ? 'image/png' : fmt.format; // Spine stays PNG (:1490)
  const fe = formatEncode(fmt, tier.scale, globalKnobs);          // pure §4b
  const enc = await encodeCanvas(canvas, c2d, tierMime, {
    quality: fe.quality/100, lossless: fe.lossless, effort: fe.effort,        // ← lossless now threaded (B1)
    webpNearLossless: fe.webpNearLossless, avifQualityAlpha: fe.avifQualityAlpha,
    avifSubsample: fe.avifSubsample, pngRecompressLevel: fe.pngRecompressLevel, allowPngFallback: true,
  });
  if (!enc) { skipped.push({assetRef:ref, reason:`tier skipped: encode to ${tierMime} unavailable`}); continue; }
  const imgPath = tieredName(imagePath, tier.suffix, enc.mime);
  if (emittedThisTier.has(imgPath)) { skipped.push({assetRef:ref, reason:`variant ${fmt.format} fell back to ${enc.mime}, collides — skipped`}); continue; } // B4
  emittedThisTier.add(imgPath);
  out.push({ path: imgPath, bytes: enc.bytes }); tierFilesEmitted++;
  // manifest/skeleton via variantManifestName(..., profileMulti); push tierTargetPaths variant; tierVram[ti] += dst.w*dst.h*4
}
```
Canvas composed **once per tier** (`:1483-1484`), reused across formats (multiple `getImageData`/`convertToBlob` off the same `c2d`) — honesty + cost cap preserved. Spine multi-format degrades to PNG with one honest note (edge case 5).

### 5d. Loose transcode (**:1029-1057**) + loose resize (**:1006-1027**) format fan-out
When `profileOn` and the ref is **not** tier-owned, fan out across `profileFormats`:
- record `profileOwned.add(ref)` so the standalone transcode/resize op is not also run (replaces the B3 `_1x`-tier hack);
- for transcode: `for (fmt of profileFormats) { transcode(bytes, fmt.format, formatEncode(fmt,1,…)) }`, dedup actual-mime collisions (B4), push `looseRenameChange` rows for each variant;
- the **first** emitted variant uses `renamedTo(path, mime)` and `replaced.add(path)`; subsequent variants are additional `out.push` entries.
**Note**: format-only profiles never enter the tier loop (§5a), so these handlers fan out the assets the analysis *flagged* (a `format` finding ⇒ `transcode` op, an oversize finding ⇒ `resize` op) — single, clean path, no tier-machinery side effects.

### 5d-bis. First-class format-only folder pass (finding [0] — scope decision)
The riding fan-out in §5d only covers assets the analysis FLAGGED, because `planFix` emits a `transcode` op only for a `format` finding (plan.ts:262) and a `resize` op only for a `dimensions-oversize` finding (plan.ts:234). A **format-only export profile is an EXPLICIT request to emit the chosen formats for the folder**, not a fix that rides a finding — so a clean loose image (already a good format, not oversized) would otherwise produce zero ops, no variants, and no feedback (silent no-op; violates surfaced-never-silent, invariant 3).

**Chosen scope (fix option a):** a dedicated pass after the tier loop runs the fan-out over **every eligible loose asset** (mirroring how the tier loop iterates `merged`), independent of whether the analysis flagged it. Gated to format-only profiles (`profileOn && !profileHasLowerTier`) — multi-tier profiles already iterate all of `merged` in the tier loop, so they are unaffected. The pass respects every prior claim: `profileOwned` (already fanned out via a riding op), `replaced`/`dropped` (claimed by a transform), and atlas pages (loose-only scope; an atlas keeps its single-format manifest so meta.image isn't left dangling). Each eligible image is decoded once to a scale-1 canvas and handed to `emitLooseProfileFanout` (owns the per-format emit + B4 collision guard + dedup-owner bookkeeping).

**Honest feedback:** `receipt.exportProfile` is surfaced whenever a VALID profile ran (gated on `profileOn`, not `profileAssets>0`), so the user always sees the produced counts INCLUDING `assets=0`. When a valid profile fans out nothing (atlas-only folder, or every loose image already dropped/repacked/owned), an honest `(profile)` skipped[] entry explains why. Tested at the decision level in `packages/fix/test/export-profile-fanout.test.ts` (no worker/OffscreenCanvas harness exists — B2).

### 5e. Loader-migration + receipt
`tierChanges`/`looseRenameChange` `to[]` grows to one entry per emitted variant (already `string[]`, fix-protocol.ts:135). Set `receipt.exportProfile = {formats, tiers, assets, filesEmitted}`. Keep `tierVram` as the sole per-tier VRAM ladder. `referencesChanged=true` (profile renames sources). Add `fix.profile.noBundleNote` (no bundle manifest in v1 — honest).

## 6. Honesty / invariants
- **Inv 1**: all encodes via `encodeCanvas` (OffscreenCanvas + lazy `@jsquash/{avif,webp,oxipng}`, :1718/:1741/:1703). No native lib. pngquant/kernel/pre-blur/JPEG **rejected at type level + disclosed** (en.json:241-244 reused).
- **Inv 2**: zero backend.
- **Inv 3**: fix-engine generation only; **lossless-AVIF rejected** (no faked-lossless) and **lossless WebP/PNG now genuinely lossless** via the B1 plumbing (without it, the toggle would have lied).
- **Inv 4**: execute-time only; lazy WASM unchanged; canvas composed once per tier; progress per asset×tier×format via `fix-progress` (:769). Soft cap warning when `formats×tiers×assets` large; no hard cap needed.
- **Inv 5**: fan-out is **disk-only**; `tierVram` never summed; UI says "ships N variants; the device downloads one."

## 7. UI (`apps/web/src/App.tsx`, FixCard)
New `ExportProfilePanel` (`<details>`, sibling of `TierPanel`):
- **Master toggle** (default OFF ⇒ `exportProfile:undefined` ⇒ today; `TierPanel` used as-is when OFF).
- **Formats**: PNG/WebP/AVIF checkboxes; each reveals quality slider 0..100 (hidden when lossless), a lossless checkbox (**disabled for AVIF** + `fix.profile.avifNoLossless` note), WebP near-lossless toggle. Defaults reproduce today (AVIF q85).
- **Resolutions**: reuse `DEFAULT_SCALE_TIERS` rows + an "add custom tier" row (scale ∈ (0,1], auto-suffix validated against `RESOLUTION_TOKEN` scale.ts:31).
- **Shared knobs**: reuse existing `effort`/`scaleAwareQuality`/`pngRecompress` controls. `avifSubsample` stays gated (no new control).
- **Honesty notes**: reuse `whyNoKernel`/`whyNoPreBlur`/`whyNoPngquant`/`tier.diskNote`; new `fix.profile.noBundleNote` + `fix.profile.diskNote`.

**`buildOptions` (App.tsx:853)**: when enabled →
```ts
exportProfile: { formats, tiers, effort, scaleAwareQuality, pngRecompressLevel, avifSubsample, avifQualityAlpha }
```
and **omit `scaleTiers` + `webpNearLossless`** (mutual exclusion, B3/edge-4). Disabled ⇒ omit `exportProfile` (today's branch unchanged). Add profile state to the deps array (App.tsx:949).

## 8. i18n (`packages/i18n/src/catalogs/en.json`, EN source, run drift baker)
Add under `fix.*`:
```
"fix.profile.title", "fix.profile.enable", "fix.profile.hint",
"fix.profile.formats", "fix.profile.format.png|webp|avif",
"fix.profile.quality", "fix.profile.lossless", "fix.profile.nearLossless",
"fix.profile.avifNoLossless": "Browser AVIF has no true lossless mode — omitted (no faked-lossless claim).",
"fix.profile.resolutions", "fix.profile.addTier", "fix.profile.tierScale", "fix.profile.tierBadSuffix",
"fix.profile.noBundleNote", "fix.profile.diskNote",
"fix.op.profile": "Custom export variants (references changed)",
"fix.skipped.profileRejected": "Export profile rejected — {reason}",
"fix.skipped.variantCollision": "{format} fell back to {actual} and collides with another variant — skipped"
```
Reuse existing `whyNoKernel/whyNoPreBlur/whyNoPngquant/tier.label.*`.

## 9. Determinism & naming
- Single-format ⇒ `formatToken` empty ⇒ byte-identical legacy names.
- Multi-format image: ext disambiguates; manifest/skeleton get the format token (`btn_720p.webp.json`).
- Emit order: tiers high→low (validateTiers), formats in given order; one drawImage per tier, canvas reused. Same inputs ⇒ same zip bytes.

## 10. Edge cases
1. Empty/no-format/no-tier profile → `validateProfile` rejects → `(profile)` skip, no emit.
2. Lossless-AVIF → rejected, never degraded.
3. **Fallback collision (B4)**: any two targets resolving to the same actual mime (AVIF→WebP→PNG, WebP→PNG) → emit first, **skip later with honest note** (keyed on post-encode mime, all pairs — not just AVIF/WebP).
4. **Profile + legacy `scaleTiers` both set** → impossible: buildOptions omits `scaleTiers` when profile enabled (mutual exclusion).
5. Spine + profile requesting webp/avif → PNG pages anyway + honest note.
6. Repacked/merged/packed asset + profile → `tierTransformed`/`profileOwned` skip (not re-fed in v1).
7. Custom tier scale>1 → `validateTiers` upscale reject.
8. No scale===1 top tier → `validateTiers` noTopTier reject.
9. Duplicate format targets → `validateProfile` reject.
10. PNG + lossless:false → PNG native-lossless; quality ignored; oxipng if `pngRecompressLevel` set (no faked lossy-PNG).
11. **Format-only profile (B3)** → tier loop NOT entered; fan-out in transcode/resize handler; no `tier` op, no owner rename beyond the loose rename, dedup repoint NOT disabled.

## 11. Test plan (rescoped to the REAL harness — B2)
**Pure (Vitest, `packages/fix/test/`, alongside existing `scale.test.ts`/`settings.test.ts`):**
- `validateProfile`: accepts valid multi-format/multi-tier; rejects empty formats, lossless-AVIF, bad quality/near, dup targets, + every delegated `validateTiers` rejection. Golden error lists.
- `tiersOf`/`formatToken`/`variantManifestName`: single-format ⇒ empty token ⇒ legacy names; multi ⇒ `name_720p.webp.json`. Deterministic strings.
- `formatEncode`: scaleAwareQuality folding (floor 50), lossless/near/effort mapping, PNG-quality-ignored, AVIF-lossy-only.
- **`EffectiveOptions.lossless` default** (B1): existing `settings.test.ts` cases still pass with the new field defaulting false (back-compat assertion).

**Worker path (NO e2e harness exists — assert by code-review + a thin pure shim):**
- Extract the fan-out **decision** (which formats/names/encodeOpts per asset×tier) into the pure helpers above so it is unit-tested **without** OffscreenCanvas. The worker becomes a thin caller; byte-identity for the no-profile case is guaranteed structurally (profile absent ⇒ `formatsToEmit=[legacyTarget]`, `profileMulti=false` ⇒ identical names + identical `encodeCanvas` opts).
- Document (do not fake) that full pixel byte-identity is verified manually via `pnpm dev` + a sample folder, since no worker test harness exists.

**i18n drift:** run the existing en→baked drift test after adding keys.

## 12. Ordered task breakdown (small commits)

| id | title | files | deps | acceptance |
|----|-------|-------|------|-----------|
| **T1** | Core types `ExportFormat`/`FormatTarget`/`ResolutionTier`/`ExportProfile` | `packages/core/src/index.ts` | — | typechecks; exported; doc comments |
| **T2** | **B1**: add `lossless` to `EffectiveOptions`; default-false in `resolveOptions`; update `baseEffective` + `settings.test.ts` | `packages/fix/src/settings.ts`, `apps/web/src/worker/fix.worker.ts:313`, `packages/fix/test/settings.test.ts` | — | existing settings tests green with new field |
| **T3** | Pure `validateProfile`+`tiersOf`+`formatToken`+`variantManifestName` (+index re-export) | `packages/fix/src/scale.ts`, `packages/fix/src/index.ts`, `packages/fix/test/scale.test.ts` | T1 | pure suite green; delegates to `validateTiers` |
| **T4** | Pure `formatEncode`+`FormatEncode` | `packages/fix/src/settings.ts`, `packages/fix/test/settings.test.ts` | T1,T2 | quality/lossless/near/scaleAware/png-ignored golden |
| **T5** | Protocol: `exportProfile` on `FixOptions` + `FixReceipt` | `apps/web/src/worker/fix-protocol.ts` | T1 | typechecks; back-compat + mutual-exclusion doc |
| **T6** | Worker: resolve+validate profile; set `tieringOn` from profile **only when a lower tier exists** (B3) | `fix.worker.ts:313,238` | T3,T5 | multi-tier profile reproduces tier behavior; invalid ⇒ skipped |
| **T7** | Worker: inner **format loop** in tier loop + `variantManifestName` + `formatEncode`-driven `encodeCanvas` (incl. lossless, B1) | `fix.worker.ts:1489-1531` | T4,T6 | multi-format fan-out distinct image+manifest; single-format byte-identical |
| **T8** | Worker: format-only profile fan-out in transcode/resize handlers + `profileOwned` exclusion (B3) | `fix.worker.ts:1006-1057` | T7 | format-only profile fans out; no `tier` op; dedup repoint intact |
| **T9** | Worker: **B4** actual-mime collision guard (all pairs) + Spine-PNG note + receipt `exportProfile` + loader-migration variants | `fix.worker.ts` | T7,T8 | collision/edge tests' decision-helpers green; receipt populated |
| **T10** | i18n EN keys + drift bake | `packages/i18n/src/catalogs/en.json` | — | drift test green |
| **T11** | UI `ExportProfilePanel` (formats+quality+lossless+near, custom tiers, AVIF-no-lossless disabled) | `apps/web/src/App.tsx` | T10 | panel edits state; suffix validated client-side |
| **T12** | UI `buildOptions`: wire `exportProfile`, **omit `scaleTiers`+`webpNearLossless`** when on; deps array | `apps/web/src/App.tsx:853,949` | T11,T5 | OFF ⇒ today exactly; ON ⇒ profile sent, no scaleTiers |
| **T13** | Pure decision-helper tests (fan-out names/opts) + i18n drift + manual `pnpm dev` byte-identity check (no e2e harness — B2) | `packages/fix/test/**` | T3-T9,T12 | decision goldens; documented manual verification |

T1-T5 = zero-behavior scaffolding (incl. the **B1 lossless plumbing**). T6-T9 = engine (B3 routing, B4 collisions). T10-T12 = surface. T13 = honest verification within the real harness.

## 13. Deferred to follow-up
PixiJS bundle manifest (turns variant files into a one-line load); content-hash cache-busting + ref rewrite (reuse `dedup-repoint`); `name@2x.webp.json` resolver convention (T3 plumbs `formatToken`); `includeFileSizes` metadata; per-folder/tag profile overrides (over `resolveOptions`); animation-frame autodetection; per-folder AVIF 4:4:4 forcing.

---

**Bottom line for the caller:** The draft's architecture is sound and the additive/byte-identity discipline is correct, but it shipped **3 real defects**: (B1) per-format `lossless` is NOT wired through the loose/tier encode path — `EffectiveOptions`/`encOptsFor` drop it, so the lossless toggle would silently lie (invariant-3 violation) unless you add a `lossless` field (now T2, a prerequisite); (B3) the "format-only = fake `_1x` tier" trick would regress dedup-repoint and mislabel ops — replaced with a first-class fan-out in the transcode/resize handlers gated by a `profileOwned` set; (B4) collision detection must key on the **actual post-encode mime across all fallback pairs** (AVIF→WebP→PNG), not just AVIF-vs-WebP. Also (B2) the cited worker/Playwright test harness **does not exist** — tests rescoped to the real `packages/fix/test/` pure suite + documented manual verification. All browser-capability claims check out: native `convertToBlob` does lossy WebP; `@jsquash` does AVIF + lossless/near-lossless WebP + oxipng PNG; AVIF-lossless correctly cut as not browser-achievable. Key files: `packages/core/src/index.ts:107`, `packages/fix/src/scale.ts:73-101`, `packages/fix/src/settings.ts:49-89`, `apps/web/src/worker/fix.worker.ts:313-334,1006-1057,1409-1552,1712-1772`, `apps/web/src/App.tsx:813-815,853-887,949`, `packages/i18n/src/catalogs/en.json:241-298`.