`fmtBytes` is already tested in `apps/web/test/lib.test.ts`. This is the correct home for `fmtSignedBytes` — and it argues for putting the helper in `lib/format.ts` (exported, testable) rather than as a local TSX function. I have everything. Producing the final revised design.

---

# Adversarial Review + Revised Mini-Design: Per-texture VRAM/probe breakdown card in FilmViewer

## Verdict on the premise: **TRUE — ship it (with revisions).**

I verified every load-bearing claim against the code on branch `feat/asset-pipeline`:

- ✅ `ProbeReading.{liveTextures, textureUploads, shaderCompiles, vramBytes, drawCalls}` all exist (`packages/core/src/index.ts:286–298`) and are **really instrumented** — `probeAtlas` returns them from live GL counters (`packages/probe/src/probe.ts:71–76`, `gl-instrument.ts:79,113`), not stubs.
- ✅ `metrics.probe` carries the **full** `ProbeReading` per-asset: `attachProbeReadings` does `{ ...a, probe: r }` (`apps/web/src/lib/probe-run.ts:104`). So all three counters are genuinely measured-but-unsurfaced. **Premise confirmed.**
- ✅ `vramBytesMipmapped = ceil(vramBytes × MIP_OVERHEAD)` (`packages/analysis/src/rules.ts:16`); strictly > base for any nonzero size, 0 for zero size — the draft's edge-case logic holds.
- ✅ All 9 catalogs have exactly **231** keys (verified). `readout.declared`, `readout.measured` already exist; `readout.batched` is a plural object.
- ✅ `catalogs.test.ts` enforces `Object.keys(c).sort()).toEqual(enKeys)` + placeholder-token parity across 9 locales (lines 20, 27). `render.test.ts` is unrelated to `readout.*`.
- ✅ `useI18n()` returns `{ t }`, already in scope at `FilmViewer.tsx:37`. Color tokens `text-film-soft`/`text-warn`/`text-info`/`text-ok` all real (`index.css`).

Now the problems I found — and what changes because of them.

---

## Blockers
**None.** The design is browser-side, additive, contract-neutral, and honest. Nothing violates an invariant.

## Majors

**MAJOR-1 — Row group (3) "declared vs measured" is largely REDUNDANT with what's already on screen.** The draft did not account for the *existing* render: when `probe` is present, cell 1 of the top strip is already relabelled `readout.declared` showing `metrics.vramBytes` (`FilmViewer.tsx:120–121`), and the MEASURED strip already shows `readout.measured` = `probe.vramBytes` (`:136–137`). The draft's group (3) re-prints **both of those same two numbers a second time** plus a delta. That's three of the same value on one card. *Rebuttal partly accepted:* the **signed delta** is genuinely new and valuable. **Revision:** collapse group (3) to a **single delta cell** (no re-print of declared/measured — they're 2 cm above it), rendered as a one-cell row or appended to the breakdown header. This removes 2 redundant `ReadCell`s and drops `readout.declared`/`readout.measured` re-use from this block (keys already exist anyway).

**MAJOR-2 — Test file path violates the repo convention.** The draft proposes `apps/web/src/components/FilmViewer.test.ts` (colocated). This repo puts web tests in **`apps/web/test/`** (verified: `lib.test.ts`, `dir-aware-loose.test.ts`, `i18n-app-keys.test.ts`), and `fmtBytes` is already tested in `apps/web/test/lib.test.ts:53`. **Revision:** put `fmtSignedBytes` in **`apps/web/src/lib/format.ts`** (exported, beside `fmtBytes`) and test it in **`apps/web/test/lib.test.ts`** — not a new colocated file. This also makes the helper reusable and matches the existing pattern exactly.

## Minors

**MINOR-1 — Key count: the draft says "9 keys" in the prose but the table T1 lists 9 while the JSON block shows 9 entries — internally consistent at 9, but the title says "6"/"~6".** Settled: **9 keys**, 231→240. (The draft's own NOTE already corrects the "~6" undercount; I'm just confirming 9 is right and final.)

**MINOR-2 — `readout.declaredVsMeasured` label + `readout.deltaTooltip` survive into the revised group (3); but with declared/measured cells removed, `readout.declared`/`readout.measured` are NOT new (already exist) — the draft's table correctly never lists them as new. No change, just confirming the new-key list stays at 9 and none collide with existing keys.** Verified no collision: none of the 9 proposed keys exist today.

**MINOR-3 — `grid-cols-3` with conditionally-rendered cells (probe internals) can leave visual gaps** (draft §7.3 acknowledges this). Since `liveTextures ≥ 1` after any successful render, the row always has ≥1 cell. *Accepted as-is* but with a cheap hardening: render the probe-internals row only when at least one counter is nonzero AND size the grid to the actual count, OR keep `grid-cols-3` and accept trailing empty tiles (they're `bg-film`, visually neutral). **Recommendation: keep `grid-cols-3`, accept the rare gap — not worth dynamic class computation.**

**MINOR-4 — `metrics!` non-null assertions.** Lint/strict-TS friendly but the reviewer-preferred form is a local narrow. **Revision:** add `const m = metrics;` is unnecessary since `showMip` already implies defined; instead compute the breakdown values into locals guarded by the flags. Keep `!` only if `showMip`/`probe` provably narrow — they do for `showMip` (`metrics !== undefined && …`) but NOT automatically for `probe` (TS won't infer `metrics` defined from `metrics?.probe` being truthy in a separate branch). **Fix:** derive `const m = metrics` once and gate the whole block on `m` to avoid `!` entirely.

---

## REVISED DESIGN

### 1. Scope (unchanged intent, group 3 trimmed)
Append a **breakdown block** below the two existing strips in `FilmViewer.tsx`, three independently-gated rows:
1. **Mipmap-ceiling** — base VRAM → `+33%` ceiling (`vramBytesMipmapped`), "if mipmaps on". Gated on `m.vramBytesMipmapped > m.vramBytes`.
2. **Probe internals** — `liveTextures / textureUploads / shaderCompiles`, each cell gated nonzero, sub-copy "on first render".
3. **Signed declared-vs-measured DELTA** — *single neutral cell* (`text-film-soft`), value `fmtSignedBytes(probe.vramBytes − m.vramBytes)`, tooltip "two measurements, never a saving." **No re-print of declared/measured** (already on the card — MAJOR-1).

**Non-goals:** no `core`/worker/probe/analysis change; byte-identical render when both probe and mip data absent; no new measurement (Invariant 3).

### 2. Contract additions
**None to `core`.** Only the i18n key set. **9 new keys** in all 9 catalogs (231→240), **zero `{...}` placeholders** (numbers formatted in TSX via `fmtBytes`/`fmtSignedBytes`/template literals — keeps `catalogs.test.ts` placeholder-parity trivially `[]===[]`):

```jsonc
"readout.breakdown":          "vram breakdown",
"readout.mipCeiling":         "if mipmaps on",
"readout.mipCeilingTooltip":  "Upper bound if mipmaps are enabled (Pixi/Phaser autoGenerateMipmaps): base × 4/3 (+33%). A ceiling, not asserted residency — disabled mipmaps cost nothing here.",
"readout.liveTextures":       "live textures",
"readout.uploads":            "uploads",
"readout.shaders":            "shaders",
"readout.onFirstRender":      "on first render",
"readout.declaredVsMeasured": "declared vs measured",
"readout.deltaTooltip":       "Two measurements, not a saving: declared = manifest atlas geometry, measured = real decoded pixels from a WebGL render. The signed difference is the gap between the two methods, never a savings."
```

### 3. Pure module
Add to **`apps/web/src/lib/format.ts`** (exported, beside `fmtBytes` — MAJOR-2):
```ts
/** Signed byte delta for the declared-vs-measured line: "+1.2 MB" / "−0.4 MB" / "0 B".
 *  Sign is explicit so the reader sees a directional gap between two methods, not a magnitude saving. */
export function fmtSignedBytes(delta: number): string {
  if (delta === 0) return fmtBytes(0);
  return `${delta > 0 ? '+' : '−'}${fmtBytes(Math.abs(delta))}`; // U+2212 minus
}
```
Reuse existing `ReadCell` for every cell. No new component.

### 4. UI changes (`FilmViewer.tsx` only)
Beside `const probe = metrics?.probe;` (≈line 97):
```ts
const m = metrics;
const showMip = m !== undefined && m.vramBytesMipmapped > m.vramBytes;
```
After the MEASURED strip block (after line 148), before `</div>` (line 149), insert a block gated on `m && (showMip || probe)`, containing: breakdown header (`readout.breakdown`); mip row (gated `showMip`); probe-internals `grid-cols-3` row (each cell gated nonzero, sub `readout.onFirstRender`); single delta cell (gated `probe`, `text-film-soft`, `fmtSignedBytes(probe.vramBytes - m.vramBytes)`, `title={t('readout.deltaTooltip')}`). All values via `t()` — no inline English. (Implementation body as in draft §4, minus the two redundant declared/measured cells in group 3, using `m.` instead of `metrics!`.)

### 5. Honesty / invariants
Unchanged and correct: Invariant 3 — only renders already-measured/already-computed fields; mip line is an explicit *conditional ceiling*; delta is *two measurements, never a saving* (neutral color, never `ok`/`crit`); probe sub-copy "on first render" disambiguates from the gameplay-time runtime profiler (`uploadsDuringGameplay`/`shaderCompilesDuringGameplay`). Invariants 1/2/4 untouched (probe already runs async post-analysis; this only renders).

### 6. Determinism
Pure render of integer/float state; signed delta is a fixed subtraction; `fmtSignedBytes` pure. New keys carry zero placeholders → `catalogs.test.ts` placeholder-parity is `[]===[]` per locale. `render.test.ts` unaffected.

### 7. Edge cases (verified against code)
1. No probe & no mip gap → block not rendered → **byte-identical to today**.
2. `vramBytes===0` → `vramBytesMipmapped===0` → `showMip` false → mip hidden. ✅
3. Loose images: `vramBytesMipmapped > vramBytes` → mip line shows (correct; honest for any texture). Probe absent for loose → no probe rows.
4. `probe.vramBytes===metrics.vramBytes` (clean case) → delta `0 B`, neutral — "the two methods agree."
5. Measured < declared → `−X` with U+2212, neutral color (no implied saving).
6. Probe present, all counters 0 (unrealistic; `liveTextures≥1` post-render) → row hidden or 1-cell. Acceptable (MINOR-3).

### 8. Test plan
- **Gate (must stay green):** `pnpm --filter @asset-doctor/i18n test` — after 9 keys × 9 catalogs, `toEqual(enKeys)` passes at 240 keys, placeholder-parity passes (all empty).
- **New i18n assertion** in `catalogs.test.ts` (inside the existing "no leftover braces" `it`): loop the 7 label keys per locale, assert non-empty + no `{`.
- **Pure unit:** add `fmtSignedBytes` cases (`+`, `−`, `0 B`) to **`apps/web/test/lib.test.ts`** (beside the existing `fmtBytes` describe — MAJOR-2), not a new colocated file.
- **Typecheck/lint:** `pnpm typecheck`, `pnpm lint` (the `const m` narrowing avoids `!`).
- **Manual:** `pnpm dev` — (a) loose-only folder: 2 strips + mip line, no probe rows; (b) probed atlas with WebGL: probe-internals + single delta cell; (c) confirm no third copy of declared/measured (MAJOR-1).

### 9. ORDERED TASK BREAKDOWN

| id | title | files | tag | deps | acceptance |
|----|-------|-------|-----|------|------------|
| T1 | Add 9 `readout.*` breakdown keys to en source | `packages/i18n/src/catalogs/en.json` | i18n | — | 9 keys present; no `{...}`; valid JSON; 231→240. |
| T2 | Bake same 9 keys into the other 8 catalogs (ru/de/es/pt/fr/it/zh/hi), native, mirroring en honesty wording | `packages/i18n/src/catalogs/{ru,de,es,pt,fr,it,zh,hi}.json` | i18n | T1 | Each catalog 240 keys; values non-empty, no `{...}`; `catalogs.test.ts` `toEqual(enKeys)` + placeholder-parity green for all 9. |
| T3 | Extend `catalogs.test.ts` to assert the 7 new label keys render non-empty + brace-free per locale | `packages/i18n/test/catalogs.test.ts` | test | T2 | Loop added in existing locale block; `pnpm --filter @asset-doctor/i18n test` green. |
| T4 | Add exported `fmtSignedBytes` + unit test | `apps/web/src/lib/format.ts`, `apps/web/test/lib.test.ts` | web/test | — | `+X`/`−X`(U+2212)/`0 B`; test green. |
| T5 | Add `const m`/`showMip` derived flags in FilmViewer | `apps/web/src/components/FilmViewer.tsx` | web | T4 | `showMip = m && m.vramBytesMipmapped > m.vramBytes`; no `metrics!`; typechecks. |
| T6 | Render breakdown block (mip row + probe-internals row + single signed-delta cell) below existing strips, each row independently gated, reusing `ReadCell` | `apps/web/src/components/FilmViewer.tsx` | web | T1,T5 | Block renders only when `m && (showMip || probe)`; mip uses `vramBytesMipmapped` + "if mipmaps on"/"+33%"/ceiling tooltip; probe cells gated nonzero + "on first render"; **single** neutral delta cell (no re-printed declared/measured — MAJOR-1) + "never a saving" tooltip; both data absent ⇒ output byte-identical to before. |
| T7 | Full verification | — | verify | T2,T6 | `pnpm typecheck`, `pnpm lint`, `pnpm test` green; `pnpm dev` smoke confirms §7 cases incl. no triplicate VRAM number. |

**Key facts for the implementer (decided, don't re-litigate):**
- All strings via `t()` — never inline English (matches `readout.*` usage).
- New keys carry **no** placeholders; numbers formatted in TSX (`fmtBytes`/`fmtSignedBytes`).
- `fmtSignedBytes` lives in `apps/web/src/lib/format.ts`, tested in `apps/web/test/lib.test.ts` (repo convention — NOT colocated).
- Group (3) is **one** neutral delta cell, not three cells — declared & measured are already on the card.
- Governing test: `packages/i18n/test/catalogs.test.ts` (9-locale same-keys + placeholder parity); `render.test.ts` unaffected.
- Files touched: **9 JSON catalogs + 1 TSX + format.ts + 2 test files.** Zero changes to `core`/`probe`/`analysis`/workers.