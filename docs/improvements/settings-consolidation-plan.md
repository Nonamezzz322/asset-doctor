# Settings consolidation plan (audit wf ce30de32)

I have verified all the load-bearing claims against the real code. The key findings that separate genuine duplication from false positives are confirmed. Here is my grounded, ranked consolidation plan.

---

# Settings-UX consolidation plan — verified against source

## What I independently confirmed in the worker/config code

- **`webpNearLossless` (RulesCard) is HARD-dead under a profile — everywhere, including atlas pages.** `buildFixOptions` emits `undefined` when a profile is sent (`build-settings.ts:223`) ⇒ `baseEffective.webpNearLossless = opts.webpNearLossless ?? 100 = 100` (`fix.worker.ts:690`). The atlas path (`forceAtlasFormat` → `effectiveForTranscode` → `baseEffective`) also sees `100`. So no WebP encode gets near-lossless from this control under a profile. The profile's own `near` (`build-config.ts:142` `{ near: 60 }`) is the only source. Both land on the identical constant `near_lossless: 60` (`fix.worker.ts:4611-4621`). **Genuine same-value duplicate.**
- **The legacy tier ladder (`tierEnable`/`tierSuffixes`) is HARD wire-omitted under a profile.** `scaleTiers` is `undefined` when a profile is sent (`build-settings.ts:247`); the worker's single tier axis prefers `profileTiers` (`fix.worker.ts:562-567`). **Genuine mutual exclusion.**
- **PRECISION CORRECTION to Lens 1 & Lens 4 (they over-reached): `defaultTarget` AND `defaultQuality` are NOT fully dead under a profile.** For a prebuilt atlas page that earns a `format` finding, the worker transcodes it via `forceAtlasFormat(ref, atlasOfRef, path, sidecar, op.targetMime, …)` (`fix.worker.ts:2745`) → `effectiveForTranscode(ref, targetMime)` (`:1870`) → `baseEffective.targetMime = opts.targetMime` (=`defaultTarget`) and `baseEffective.quality = opts.quality` (=`defaultQuality`) (`:687-689`). This fires **even when a profile is active** — the profile never governs prebuilt-atlas-page format (see the explicit "atlas pages stay single-format" note at `:2738`). Lens 2 & Lens 3 got this right. **Consequence: these two controls must NOT be hard-hidden under a profile — that would strip a live, user-facing knob. The fix is to rescope their labels, not gate them out.**
- **Legacy `overrides` is likewise still live for atlas pages under a profile** — `effectiveForTranscode` passes `opts.overrides` (`fix.worker.ts:719`), and `forceAtlasFormat` calls it. It is inert only on the loose fan-out/tier paths (which route through `resolveProfileForRef`/`profileOverrides`). So it is *narrowly* live, not fully dead.

## DROPPED — false positives I refuted with code

- **`trimMargin` (rule) vs `packTrim` (pack) — NOT duplicates.** `trimMarginOn = opts.trimMargin !== false` (`fix.worker.ts:431`) drives `buildTrimArrays([atlas])` on the repack/merge paths (`:2002, :2166`) — it tightens frames of **existing atlas sprites**. `packTrim` becomes `op.trim`, consumed only inside `packLoose` (`:2908 if (!op.trim)`, `:2986 trim: op.trim`) — it trims **loose images being packed into a brand-new sheet**. Different asset populations, different worker primitives, non-overlapping. There is no third "profile trim". Only the shared word "trim" collides — a copy issue at most.
- **`effort`, `scaleAwareQ`, `pngRecompressLevel` — single-sourced, NOT duplicated.** One RulesCard control each; folded into the profile by `buildProfileFromState` (`build-config.ts:169-171`) and read from `profileGlobal` under `profileOn`. Same knob feeds both paths. This is the *correct* model, not a duplicate.
- **`maxEdge` — additive, NOT a second tier ladder.** Sent unconditionally (`build-settings.ts:215`), fed to `planFix` regardless of profile (`fix.worker.ts:606`) and re-applied as the top clamp inside both profile and legacy tier loops (`:3353-3357`). Keep it always visible. `padding`/`maxSize` likewise additive.
- **`packMode`/`packGranularity`/`packTrim` — already correctly nested** under `{s.packLoose ? …}` (`SettingsPage.tsx:565-586`) and undefined on the wire unless `packLoose` (`build-settings.ts:241-243`). No fix.
- **`avifSubsample` already nested** under `formats['image/avif'].enabled` (`:405`); **`includeFileSizes` already `disabled={!s.emitPixiManifest}` + indented** (`:707-719`). These are the exemplars to copy, not findings.
- **`bestFormatPerImage` vs `defaultTarget` — overlap, not duplication.** `bestFormatPerImage` routes each loose transcode to the diagnosis-measured winner but only on the profile-OFF path and only for images with a `format` finding; `defaultTarget` is still the fallback base. Not the same effective behavior. Optional copy tweak only (see item 3 note).

---

## Ranked consolidation (UI-only in `SettingsPage.tsx`; zero worker/wire/default change)

### RANK 1 — Hide the RulesCard "WebP near-lossless" switch when a profile is active
- **Control:** `RulesCard` `<Switch label={t('fix.settings.nearLossless')} … checked={s.webpNearLossless} …/>` at `SettingsPage.tsx:629`. Duplicate of the profile per-format `near` checkbox at `:390-395`.
- **Exact change:** wrap line 629 in `{!s.profileEnable ? (<Switch …/>) : null}`. Driver: `s.profileEnable`.
- **Why safe:** `buildFixOptions:223` already omits `webpNearLossless` under a profile, so every encode path (loose, tier, *and* atlas) sees `100` = no near-lossless regardless of this control. Hiding it changes nothing on the wire. Default is `profileEnable:false` ⇒ still rendered ⇒ `settingsDefaults()` run byte-identical.
- **i18n:** none. (If the team prefers discoverability over hiding, reuse the `includeFileSizes` exemplar: keep it rendered but `disabled` with the existing hint plus a note — needs one new key, e.g. `fix.settings.nearLossless.profileNote`.)
- **Value:** highest — a genuinely same-constant duplicate that today silently ignores user input under a profile; zero risk.

### RANK 2 — Gate the legacy resolution-tier block behind `!s.profileEnable`, keep `maxEdge` always visible
- **Controls:** `ResolutionsCard` `<Switch label={t('fix.tier.enable')}…>` (`:503`), the `⚠ inlineWarn` line (`:504`), and the whole tier sub-block (`:506-528`, `tierSuffixes` checkboxes + notes). Mutually exclusive with the profile's `customTiers` editor (`:422-443`).
- **Exact change:** wrap `:503-528` (the `tierEnable` Switch + inlineWarn + `{s.tierEnable ? …}` block) in `{!s.profileEnable ? ( … ) : ( <p className="font-mono text-[13px] text-ink-soft">{t('fix.tier.profileNote')}</p> )}`. **Leave `maxEdge` NumberRow (`:501`) and its hint (`:500`) outside the gate — always visible** (additive). Driver: `s.profileEnable`.
- **Why safe:** `scaleTiers` is wire-omitted whenever a profile is sent (`build-settings.ts:247`); the worker never consults the legacy ladder under a profile (`fix.worker.ts:562-567`). State (`tierEnable`/`tierSuffixes`) persists and reappears when the profile is turned off. Default path unchanged.
- **i18n:** 1 new key `fix.tier.profileNote` ("Resolutions come from the active export profile below") across the 9 languages. (Optional — could render `null` instead and add no key.)
- **Value:** high — removes a full dead tier UI that visibly "does nothing" under a profile; hard-omitted so zero behavior risk.

### RANK 3 — Rescope (do NOT hide) the profile-OFF "default target / default quality" row when a profile is active
- **Controls:** the defaults `<div className="rounded border border-line/70 p-1.5">` at `SettingsPage.tsx:338-350` — `Segmented` `defaultTarget` (`:340-346`) + `NumberRow` `defaultQuality` (`:348`). Sits directly above the profile's own format list + per-format quality sliders in the **same card**, reading like a dead second copy.
- **Exact change (label-only, no gating):** make the two hints conditional on `s.profileEnable`:
  - `hint={t(s.profileEnable ? 'settings.defaultTarget.hintProfile' : 'settings.defaultTarget.hint')}` on the `Segmented`.
  - For `defaultQuality`, add a `hint` prop (NumberRow supports it) = `t(s.profileEnable ? 'settings.defaultQuality.hintProfile' : 'settings.defaultQuality.hint')`.
  - Optionally add one note line inside the div when `s.profileEnable`: `{s.profileEnable ? <p className="font-mono text-[12px] text-ink-soft">{t('settings.defaults.atlasScopeNote')}</p> : null}`.
- **Why NOT hide, and why safe:** verified above — `defaultTarget`/`defaultQuality` remain LIVE for prebuilt-atlas-page transcodes under a profile (`fix.worker.ts:2745 → 1870 → 687-689`). Hard-hiding them would freeze that path at the last-set value and remove the only UI to tune it ⇒ that is "removing real functionality," which is out of bounds. A label change touches neither the wire nor the default run. It converts the *false* "dead duplicate" impression into an accurate "this governs prebuilt atlas pages; the profile governs loose images + composed sheets" statement.
- **i18n:** 3 new keys — `settings.defaultTarget.hintProfile`, `settings.defaultQuality.hintProfile`, `settings.defaults.atlasScopeNote` (×9 languages). Copy: "While a profile is active, this applies to prebuilt atlas pages only; loose-image formats come from the profile below."
- **Value:** high user-clarity (this is the single most confusing adjacency), zero behavior risk. This is the item Lens 1/Lens 4 mis-prescribed as a hard hide.

### RANK 4 — Collapse + rescope the RulesCard legacy per-folder overrides when a profile is active
- **Controls:** `RulesCard` legacy overrides block (`SettingsPage.tsx:648-687`, match + quality-only) vs the richer `FormatsCard` `profileOverrides` editor (`:445-475`, match + mode quality/lossless/fonts444). Two "add override" editors targeting the same folders.
- **Exact change:** when `s.profileEnable`, wrap the legacy overrides block (`:648-687`) in a collapsed `<details>` whose `<summary>` uses a rescoped label `t('fix.settings.overrides.atlasScope')`; when `!s.profileEnable` render it open exactly as today. Keep it editable (do not remove) — it stays live for atlas pages. This yields ONE prominent override list (the profile's, the active loose path) with the legacy one demoted-but-reachable. Driver: `s.profileEnable`.
- **Why safe:** legacy `overrides` is still sent (`build-settings.ts:238`) and consulted for atlas-page transcodes (`fix.worker.ts:719`), so it cannot be dropped; but it is inert on the loose fan-out/tier paths under a profile. Collapsing (not removing) preserves the live-for-atlas path and all state. Default (`profileEnable:false`) renders open ⇒ byte-identical.
- **i18n:** 1 new key `fix.settings.overrides.atlasScope` ("Per-folder overrides — prebuilt atlas pages (profile-OFF loose path)"), ×9.
- **Value:** medium — removes the "two identical-purpose override buttons" confusion while honestly preserving the narrow atlas-page path. Note: a true single-list *merge* is impossible without a schema/worker change (legacy is match+quality; profile is match+mode+quality/lossless/fonts444), so collapse+rescope is the correct UI-only move.

---

## Optional, low-priority copy-only tweaks (no gating, no risk)
- **Disambiguate the two "trim" labels** (DROPPED as behavior-duplication, but the shared word misleads): PackingCard `fix.pack.trim` → "Trim margins before packing (loose→new sheet)"; RulesCard `fix.settings.trimMargin` → "Tighten margins in existing atlases (repack)". i18n copy edit to existing keys.
- **`bestFormatPerImage` hint** (`:644`): when `s.bestFormatPerImage`, relabel the `defaultTarget` row hint as "fallback when no measured winner." Overlap clarification only.

## Files
- Edit target: `/home/nonamezzz/Рабочий стол/projects/apps/web/src/components/SettingsPage.tsx` (all four items are JSX-only, driven by the existing `s.profileEnable` / `s.tierEnable` / `s.packLoose` state).
- No changes to `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/build-settings.ts`, `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/build-config.ts`, or `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix.worker.ts` — worker behavior, wire payload, and the byte-identical `settingsDefaults()`/`buildFixOptions` default run are untouched (every gate uses `!s.profileEnable`, and the default is `profileEnable:false`, so the default state renders and emits exactly as today).
- New i18n keys total: RANK 2 (1) + RANK 3 (3) + RANK 4 (1) = **5 keys ×9 languages**; RANK 1 needs none. Add to the `en` source catalog (drift-test regenerates the baked copies).