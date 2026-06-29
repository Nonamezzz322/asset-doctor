# Declared-vs-real atlas dimension mismatch detector (manifest meta.size ≠ actual image pixels) (PROCEED)


# PROCEED — premise re-verified against the real code

## 1. Problem (verified, cited)

For an atlas `Asset`, two sizes are independently parsed and they are NOT compared anywhere in analysis:

- **Declared** `atlas.size` — the manifest's stated canvas. TexturePacker/Pixi: `packages/parsers/src/atlas.ts:190` `const size = readSize(meta.size) ?? opts.imageSize;` (declared preferred; image dims only a fallback). Spine: `packages/parsers/src/spine-atlas.ts:181` `size: page.size ?? info.size` (declared `page.size` preferred; falls back to real dims ⇒ never diverges when the page header omits `size:`).
- **Real** `image.size` — the actual decoded pixel header, zero-decode. `packages/parsers/src/atlas.ts:242` and `spine-atlas.ts:188` both `size: info.size` where `info = readImageInfo(image.bytes)` (header-only read).

`packages/analysis/src/analyze.ts` charges VRAM on the DECLARED value (`vramBytes(atlas.size)` line 203, `vramBytesMipmapped(atlas.size)` line 204), runs `dimensionFindings(atlas.name, atlas.size, cfg)` on the declared value (line 211), and **never reads `image.size` in the atlas branch** (the atlas branch only touches `image.byteSize` lines 193/202; grep of `packages/analysis/src` confirms `image.size` appears ONLY in the loose-image branch lines 261/262/264/266, `folder.ts:117`, `variants.ts:63`, `rules.ts:426` — all loose-image paths). So the declared↔real divergence is invisible to the always-on static audit.

Worse (the strong signal): the parser's own out-of-bounds frame pass tests against the DECLARED size — `packages/parsers/src/atlas.ts:199` `if (s.frame.x + s.frame.w > size.w || s.frame.y + s.frame.h > size.h)`. When declared `size` is LARGER than the real image, a frame can pass this OOB check yet place/sample OUTSIDE the smaller real texture → silent transparent/garbage seams at runtime, surfaced today only by an optional render-probe label (`apps/web/src/components/FilmViewer.tsx:130` relabels static VRAM "declared" and shows a probe "measured" sibling — main-thread, WebGL-only, opt-in), never in the free baseline audit.

**Re-verification of load-bearing claims I did NOT take on faith:**
- **CLI reachability** (the brief's "fires on CLI honestly"): `apps/cli/src/pipeline.ts:81` calls `analyze(merged, resolveThresholds(config?.thresholds), …)`; `audit` and `init` call `auditDir(dir)` with NO config (`apps/cli/src/commands/audit.ts:21`, `init.ts:35`). `packages/budget/src/config.ts:99-111` `resolveThresholds(undefined)` returns `DEFAULT_THRESHOLDS` whole. ⇒ a key placed in `DEFAULT_THRESHOLDS` DOES fire on `audit`/`init`. (`budget` with a config keeps only the seven enumerated groups, so a config-driven gate stays opt-out — honest and consistent with bleeding/wastedAlpha.) The data is present headlessly: `parseAtlas` (CLI line 53) fills `image.size` from `readImageInfo`.
- **No golden breakage:** I ran the REAL parsers (`parseAtlas`/`parseSpinePage` via a throwaway vitest in `packages/analysis/test`) over EVERY `fixtures/sample-projects/*` dir. Result: **zero** atlases with `atlas.size != image.size`. The three `ATLAS_CASES` goldens (`tp-hash-symbols` 512², `tp-array-oversize` 4100×1024, `pixi-packed-ok` 1024²) all have `meta.size === real PNG dims`. So adding the rule to `DEFAULT_THRESHOLDS` keeps `analysis.test.ts:51` `expect(sig(report.findings)).toEqual(sig(expected.findings))` green with NO expected.json edits.

Premise confirmed true and unhandled. PROCEED.

## 2. v1 scope

A new pure rule `dimensionMismatchFinding(atlas, image, cfg)` in `packages/analysis/src/rules.ts`, wired into the atlas branch of `analyze.ts`, that compares DECLARED `atlas.size` against REAL `image.size` and emits ONE objective correctness finding when they diverge beyond a calibrated tolerance, with explicit DIRECTION handling. NO decode, NO WebGL, NO host data, NO new worker plumbing (the data already flows into the `Asset`).

**Direction + severity (the crux):**
- **real < declared (DANGEROUS):** the real texture is SMALLER than the manifest claims. Sub-case A — at least one placed frame's rect exceeds the REAL bounds (`f.x+f.w > image.size.w || f.y+f.h > image.size.h`): frames sample off the real edge ⇒ `crit` (frames literally fall off; this is the bug the OOB pass misses). Sub-case B — no frame exceeds real bounds but declared still > real beyond tolerance: VRAM is over-charged vs real pixels and UVs may shift ⇒ `warn`.
- **real > declared (MILD):** the image has extra border the manifest doesn't address; frames stay in-bounds. Honest waste note ⇒ `info`.

**Honesty (invariant 5 — no over-claim, no conflation):** by default the finding carries **NO `estimate`** (it is a CORRECTNESS finding — exact precedent: `bleedingFinding`, `rules.ts:623` "NO estimate field — a CORRECTNESS finding, not a saving"). It states TWO MEASUREMENTS (declared W×H vs real W×H) verbatim, never a delta-saving, never a fabricated VRAM number. It is framed as the always-on static sibling of the probe's declared-vs-measured label, with copy that explicitly says "the real pixels are the truth" without claiming a fix-saving.

## 3. Out of scope / deferred (stay contained)
- NO film-viewer overlay (no new `OverlayZone.kind`; this is a non-visual correctness verdict, like strippable-metadata).
- NO change to VRAM accounting — `analyze.ts:203/204` keep charging `atlas.size` (changing the basis is a separate, riskier decision; deferred). The finding merely DISCLOSES the over/under-charge in words.
- NO change to the OOB-frame partition in the parser (`atlas.ts:199`) — fixing that to test real bounds is a separate parser change; deferred. v1 only DETECTS.
- NO fix-engine work (no auto-rewrite of meta.size; invariant 3 — we diagnose, generate nothing).
- NO `resolveThresholds` enumeration entry (keep it browser+CLI-default-on via DEFAULT_THRESHOLDS, OFF when a budget config is supplied — same posture as bleeding).
- NO Spine special-casing beyond the shared code path (Spine only diverges when a page `size:` header is present and wrong; `page.size ?? info.size` means no false positive when absent — already handled by the shared comparison).

## 4. Additive contract/type changes (absent ⇒ byte-identical)

`packages/core/src/index.ts`:
- Add to the `Rule` union (near line 283, beside `'bleeding'`): `| 'dimension-mismatch'`. Purely additive to a string-literal union.
- Add to `ThresholdConfig` (after `bleeding?` line 605), optional:
  ```ts
  /** Declared-vs-real atlas dimension mismatch gate (browser + headless via DEFAULT_THRESHOLDS; a budget
   *  config that omits it suppresses it, mirroring bleeding). Fires ONLY when atlas.size (declared meta.size /
   *  Spine page size:) differs from image.size (the real decoded pixels) by MORE than `tolerancePx` on either
   *  axis. CORRECTNESS finding — carries NO diskBytesSaved/vramBytesSaved (it states two measurements, never a
   *  saving; invariant 5). crit when real<declared AND a placed frame exceeds the real bounds (samples off the
   *  smaller texture); warn when real<declared within frame bounds; info when real>declared (extra border).
   *  Optional/additive: absent ⇒ suppressed. NOT enumerated by resolveThresholds. */
  dimensionMismatch?: { tolerancePx: number };
  ```
- No new `FindingEstimate`/`OverlayZone` shape (reuses existing fields; estimate omitted entirely).

`packages/analysis/src/config.ts` — add to `DEFAULT_THRESHOLDS`:
```ts
dimensionMismatch: { tolerancePx: 2 }, // CALIBRATE — declared(meta.size)-vs-real(image pixels) gate. Fires
// only when |declared − real| > 2px on either axis. WHY 2px: a 0–2px difference is benign rounding (an
// odd-trimmed export, a 1px content-extent shave) and must stay SILENT; a real stale/downscaled/POT-rounded
// manifest diverges by ≥ a meaningful margin (typ. 24/48/whole-power-of-two px). Healthy trimmed atlases do
// NOT diverge at all (TexturePacker writes meta.size == the trimmed sheet == the real image). CORRECTNESS
// finding — NO disk/VRAM saving (invariant 5). Fires on CLI audit/init (DEFAULT_THRESHOLDS) honestly; a budget
// config that omits the key suppresses it (mirrors bleeding).
```
Why `tolerancePx: 2` and not a percentage: the dangerous physics is absolute pixels (a frame at x+w sampling 1–2px past the real edge is negligible bleed; a 24px+ overrun is a torn sprite). A percentage would let a tiny absolute overrun on a huge sheet fire (false positive) and a large absolute overrun on a small sheet stay silent (false negative). 2px is the smallest margin that swallows benign odd-dimension trim while catching every genuine stale-manifest case in the brief (downscaled build, wrong-scale authoring, POT-rounding — all ≫ 2px).

## 5. Pure module + signature

In `packages/analysis/src/rules.ts` (new export, modeled on `bleedingFinding`):
```ts
/** Declared (atlas.size, from manifest meta.size / Spine page size:) vs REAL (image.size, the decoded
 *  pixel header — zero decode) atlas dimensions. A pure integer compare of two numbers the parser already
 *  holds; generates nothing (invariant 3). CORRECTNESS finding — NO saving (invariant 5); states the two
 *  measurements, never a delta. Direction matters: real<declared is the dangerous case (frames can sample
 *  off the smaller real texture — the parser's OOB pass tests the DECLARED size and misses it), real>declared
 *  is a mild extra-border note. Returns null with no config or within tolerancePx on BOTH axes. */
export function dimensionMismatchFinding(
  atlas: Atlas,
  image: ImageAsset,
  cfg: ThresholdConfig,
): Finding | null
```
Logic (deterministic, integer-only):
1. `if (!cfg.dimensionMismatch) return null;`
2. `const dw = atlas.size.w - image.size.w, dh = atlas.size.h - image.size.h;`
3. `const tol = cfg.dimensionMismatch.tolerancePx; if (Math.abs(dw) <= tol && Math.abs(dh) <= tol) return null;`
4. `const realSmaller = atlas.size.w > image.size.w || atlas.size.h > image.size.h;`
5. If `realSmaller`: scan placed frames for any exceeding REAL bounds: `const offEdge = atlas.sprites.filter((s) => s.frame.x + s.frame.w > image.size.w || s.frame.y + s.frame.h > image.size.h);` (count + first few names for the proof, sorted for determinism). `severity = offEdge.length > 0 ? 'crit' : 'warn'; direction = 'shrunk'`.
6. Else (real ≥ declared on every axis, i.e. real larger somewhere): `severity = 'info'; direction = 'grown'; offEdge = []`.
7. Build the finding: `id: \`${atlas.name}:dimension-mismatch\``, `rule: 'dimension-mismatch'`, `assetRef: atlas.name`, `messageKey: 'dimension-mismatch'`, **NO `estimate`**, **NO `overlay`**, `params: { dw: atlas.size.w, dh: atlas.size.h, rw: image.size.w, rh: image.size.h, off: offEdge.length, dir: direction }`. Title/detail baked English must byte-match the en catalog template (drift guard).

Baked English (single template family; the title varies by direction via a `{dir}` param-selected catalog, OR — simpler & drift-safe — keep ONE neutral phrasing that reads truthfully for both directions and let `off`/`dir` drive a clause). Recommended baked strings (one title, one detail, no plural needed if phrased with explicit numbers):
- title: `Manifest declares ${atlas.size.w}×${atlas.size.h} — image is actually ${image.size.w}×${image.size.h}`
- detail (real<declared, off>0): `The manifest's declared size ${declared} is larger than the real texture ${real}. ${off} frame(s) reference pixels past the real edge and will sample transparent/garbage at runtime (the bounds check uses the declared size and misses this). The static VRAM estimate (w·h·4) is charged on the DECLARED size, so it OVER-states the real footprint. These are two measurements, not a saving.`
- detail (real<declared, off=0): `…declared ${declared} larger than real ${real}; frames stay in bounds, but UV mapping assumes the declared canvas and the static VRAM estimate over-states the real pixels. Two measurements, not a saving.`
- detail (real>declared): `…declared ${declared} smaller than real ${real}; the image carries extra border the manifest doesn't map. Frames stay in bounds; the static VRAM estimate under-states the real pixels. Two measurements, not a saving.`
- fix: `Re-export the atlas so meta.size matches the actual image, or re-export the image at the declared size — the manifest and the texture must agree.`

To stay drift-simple (the guard byte-compares ONE baked string per finding instance in `realFindings()`), implement the three detail variants as THREE separate catalog detail keys selected by a `{dir}`-style branch in the catalog OR (cleaner, matching the codebase's plural precedent) keep the rule emitting ONE `detail` string per call and the catalog `find.dimension-mismatch.detail` as a plural/select object keyed on a discriminator param. Given the codebase already uses plural objects (`$count`) but not arbitrary select, the lowest-risk choice is: emit the direction discriminator as the **plural count** is wrong here; instead pick the simplest path — **one catalog detail template with placeholders that read truthfully in all three cases** is hard. Recommended: model it exactly like `corr.*` variant routing is NOT available for `find.*`. So use the proven `find.*` plural mechanism is also not a fit. ⇒ Decision: emit the SAME messageKey but make the detail a `$count: 'off'` plural object — `one`/`other` cover the frame-count plural for the dangerous case, and the rule itself only ever emits the dangerous (real<declared) finding's wording with `{off}` frames, while the `dir`-distinct `info`/`crit`/`warn` wording differences are folded into the title+detail via `{dir:sev}`-style raw params already supported (`interpolate` supports `:sev` raw catalog lookup, `index.ts:101`). Net: ONE title key (placeholders `{dw}{dh}{rw}{rh}`), ONE detail key as a plural-on-`off` object whose `one`/`other`/`zero` forms carry the direction-appropriate sentence, ONE fix key. This fits the existing renderer with no engine change.

## 6. Worker / UI / backend changes
- **Worker:** NONE. `apps/web/src/worker/analyze.worker.ts:69-72` already builds the same `Asset` with `image.size` populated; `analyze()` reads it. The finding renders in the existing TriageLedger + FilmViewer detail card via `renderFinding` (it picks up any new `find.<key>` family automatically, `index.ts:134`).
- **UI:** NONE required (the finding flows through the generic finding list). Optional later: a `readout.declaredVsMeasured`-adjacent static note — explicitly DEFERRED to keep contained.
- **Backend:** NONE (invariants 1/2 untouched; pure client/CLI analysis).
- **`analyze.ts` wiring** (the one production edit): in the atlas branch, after `bleedingFinding` (line 217), add:
  ```ts
  const dm = dimensionMismatchFinding(atlas, image, cfg);
  if (dm) findings.push(dm);
  ```
  `image` is already in scope (line 191). Import `dimensionMismatchFinding` from `./rules` (analyze.ts import block) and re-export it from `packages/analysis/src/index.ts` (beside `bleedingFinding`, line 19).

## 7. Honesty + invariant compliance
- **Inv 3 (objective, generate nothing):** compares two parsed integers, emits a verdict; no generation. Mirrors bleeding/strippable-metadata.
- **Inv 5 (disk≠VRAM, never over-claim/conflate):** NO `estimate` field at all — no `diskBytesSaved`, no `vramBytesSaved` (precedent `rules.ts:623`). The copy states the VRAM estimate is charged on the declared size and therefore OVER- (or UNDER-) states the real footprint — a factual disclosure of the existing accounting, framed as TWO MEASUREMENTS, never a saving and never a "fix saves X". This is strictly more honest than today (which silently charges the wrong basis).
- **Inv 4 (instant-wow):** zero decode, zero WebGL, O(sprites) integer scan only in the dangerous branch (and O(1) otherwise). Fires in the worker on the free path.
- **Inv 1/2:** pure client/CLI; no network, no backend.
- **Sibling, not duplicate:** copy explicitly references that the always-on static finding complements the optional probe's declared-vs-measured label (the probe MEASURES decoded residency; this DETECTS the manifest/image disagreement without a GPU). Different mechanism, different surface.

## 8. Determinism
Pure integer arithmetic; frame scan in `atlas.sprites` source order; proof names sorted before joining. No floats, no Map iteration order dependence (filter over an array). Same input ⇒ same output on browser and Node.

## 9. Edge cases
- Spine page with no `size:` header ⇒ `page.size` undefined ⇒ `atlas.size = info.size = image.size` ⇒ `dw=dh=0` ⇒ silent (verified: `spine-atlas.ts:181`). No false positive.
- Within tolerance (≤2px both axes) ⇒ null (POT-odd-trim noise stays quiet).
- Declared larger but ALL frames in-bounds ⇒ warn (not crit) — honest milder signal.
- Real larger (extra border) ⇒ info.
- Zero/degenerate `image.size` impossible for a parsed atlas (`readImageInfo` returns null ⇒ parse fails before analysis).
- Rotated frames: `frame` is the rect AS PLACED (already w/h-swapped, per `atlas.ts:196` comment), so the off-edge test is correct without further swap.
- Aliased frames on the same rect: counted as-is in `off` (a frame that overruns is a frame that overruns regardless of aliasing; not double-jeopardy — it's a count of offending placements, stated as a fact).
- Loose images: never reach this rule (atlas branch only).

## 10. Test plan (against the actual harness)
1. **`packages/analysis/test/analysis.test.ts`** — new `describe('dimension-mismatch')`:
   - crit: atlas declared 1024² (meta.size), real image 512² (synthesize an `ImageAsset` with `size:{512,512}` + an atlas with a frame at `{x:600,y:0,w:100,h:100}` exceeding 512) ⇒ finding `rule:'dimension-mismatch', severity:'crit'`, no `estimate`.
   - warn: declared 1024², real 512², all frames within 512 ⇒ `severity:'warn'`, no estimate.
   - info: declared 512², real 1024² ⇒ `severity:'info'`.
   - silent within tol: declared 1026×1024, real 1024² ⇒ null (≤2px).
   - silent equal: declared==real ⇒ null.
   - `params` shape assertion (`{dw,dh,rw,rh,off,dir}`), `estimate` undefined, `overlay` undefined.
   - **Golden non-regression:** re-run `analyze — atlas goldens`; assert all three still green (verified ahead of time: zero fixtures diverge).
2. **New on-disk golden fixture** via the `make-fixture` skill: `fixtures/sample-projects/dimension-mismatch/` — a hand-authored TP-hash manifest with `meta.size:{w:1024,h:1024}` plus a REAL 512×512 PNG and one frame placed past 512, `expected.json` listing `{rule:'dimension-mismatch',severity:'crit'}` alongside whatever generic findings fire (occupancy etc.). Add its dir to `ATLAS_CASES` in `analysis.test.ts` and reconcile its `findings` signature honestly (run the test, copy the real `sig`). This is the golden reconciliation.
3. **i18n drift guard `packages/i18n/test/render.test.ts`:**
   - Add a `dimension-mismatch` finding to `realFindings()` (construct an atlas + ImageAsset that produces the crit case, calling `dimensionMismatchFinding`).
   - Add `'dimension-mismatch'` to the expected `keys` Set (line 120).
   - The per-finding loop then byte-asserts `renderFinding(f,'en').{title,detail,fix} === f.{title,detail,fix}` and ru braces-free — forcing the en catalog template to byte-match the baked strings.
4. **i18n catalog parity `packages/i18n/test/catalogs.test.ts`:** add the three keys (`find.dimension-mismatch.{title,detail,fix}`) to ALL 9 catalogs (en/ru/de/es/pt/fr/it/zh/hi) with identical placeholders and (for the plural detail) `$count`+`other` structure; the per-locale `toEqual(enKeys)` + placeholder-parity tests guard it. Add an explicit `translate(loc,'find.dimension-mismatch.title',{dw,dh,rw,rh})` brace-free assertion in the per-locale loop.
5. **CLI:** add a `apps/cli/test` case (or extend the existing fixture audit) asserting the new fixture surfaces `dimension-mismatch` via `auditDir` with NO config (confirms DEFAULT_THRESHOLDS opt-in on CLI). Confirm `budget` with a config that omits `dimensionMismatch` suppresses it.
6. **Suite:** `pnpm test` + `pnpm typecheck` (Rule union exhaustiveness, ThresholdConfig optional). Use `export PATH="$HOME/.local/bin:$PATH"` prefix (pnpm 10, Node 20).

## 11. Ordered small-commit breakdown
1. `feat(core): add dimension-mismatch Rule + optional ThresholdConfig.dimensionMismatch` (additive union + optional field + doc comment).
2. `feat(analysis): dimensionMismatchFinding (pure, no estimate, direction-aware) + DEFAULT_THRESHOLDS tolerancePx:2` (rule + config + export from index.ts; unit tests; assert goldens still green).
3. `feat(analysis): wire dimension-mismatch into analyze atlas branch` (2-line wiring; report-shape test that it fires only on divergence).
4. `feat(i18n): dimension-mismatch catalog family across 9 locales` (en byte-matching baked strings + 8 translations; update render.test.ts keys Set + realFindings; catalogs.test.ts brace-free assertions).
5. `test(fixtures): dimension-mismatch golden + add to ATLAS_CASES` (make-fixture skill; expected.json reconciled honestly).
6. `test(cli): dimension-mismatch fires on audit (DEFAULT_THRESHOLDS), suppressed by a budget config omitting it`.
7. `docs(FEATURES): add the always-on declared-vs-real dimension mismatch detector to §1` (one bullet, framed as the static sibling of the probe label).

Each commit is one self-contained meaning, tests green at every step.
