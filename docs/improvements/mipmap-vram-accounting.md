I now have everything I need. The probe comment at L4 and L22 is explicit: "+33% **where mipmaps were generated**" — it tracks `generateMipmap` calls. The design's framing that the runtime "does `* 4/3` when `t.mip`, so static should always do `* 4/3`" inverts the actual semantics. The probe is honest (conditional); the design proposes unconditional, which is the opposite of matching.

I have enough verified evidence. Producing the adversarial review and final revised design.

---

# Adversarial Review + Revised Mini-Design: Mipmap-cost VRAM accounting

## Review verdict: REVISE (1 blocker, 4 majors, several minors). The improvement is worth shipping, but the draft's central premise is factually inverted and must be re-grounded before it touches the contract.

### BLOCKER B1 — The "match the runtime" premise is inverted; the draft would make static and runtime *disagree more*, and violates objectivity.
The draft asserts the static path should always multiply by `4/3` to "match what `gl-instrument.ts` already does (`* 4/3` when `t.mip`, L141)." Verified against source — this is backwards:

- `gl-instrument.ts:141`: `total += t.w * t.h * 4 * (t.mip ? 4/3 : 1)` — the factor is applied **only when `t.mip` is true**.
- `t.mip` is set **only inside the `generateMipmap` monkeypatch** (L111-113: `if (t) t.mip = true;`). It is `false` by default (L90).
- The file's own doc comment (L4, L22) is explicit: *"+33% **where mipmaps were generated**."*

So the runtime does **not** assume mipmaps are default-on — it **measures** whether `generateMipmap` was actually called per texture, and only then charges +33%. The draft proposes the opposite: charge +33% on **every** static texture unconditionally, justified by "Pixi/Phaser default-on." That is:
1. **Not matching runtime** — it makes the two paths diverge for the (common) case where a texture is never mipmapped (UI atlases, `scaleMode` nearest, Pixi sources created with `autoGenerateMipmaps: false`, which is in fact Pixi v8's *default* for most texture sources — mipmaps are opt-in via `autoGenerateMipmaps`/source options, not universal).
2. **An objectivity violation (Inv 3)** — static analysis cannot observe whether mips are generated; asserting they always are is a guess presented as a measurement. The draft even admits this ("we assume Pixi/Phaser default-on") then files it under "honesty note," which does not make a guess objective.
3. **A double-count risk** the draft never addresses: the existing `loadedVramBytes` header number is *base* VRAM. If we add a `+mip` number that silently assumes all textures mipmap, a user whose engine doesn't mipmap sees an inflated VRAM claim — exactly the "faked footprint" the invariants forbid.

**Required fix (adopted below):** Reframe from a *certainty* to a *conditional upper bound*. Static analysis reports VRAM **with-mipmaps as an explicit "if mipmaps enabled" ceiling**, clearly labeled as conditional, never replacing or inflating the base number. The finding's verdict severity stays `info` and its copy must say *"if mipmaps are enabled"* — not *"this pins."* This keeps it objective (we measure the geometry; we disclose a conditional cost), keeps it honest, and makes it genuinely consistent with the runtime probe, which charges the same `4/3` **conditionally**.

### MAJOR M1 — `gl-instrument.ts` imports nothing; the "extract MIP_OVERHEAD to core, import it in both" plan is not free and may be wrong for this file.
Verified: `gl-instrument.ts` has **zero `import` statements** (it's a self-contained monkeypatch module; only `package.json` lists `@asset-doctor/core`, used by *other* probe files). Adding `import { MIP_OVERHEAD } from '@asset-doctor/core'` is *technically* fine for the bundler, but:
- The draft's stated drift-elimination benefit ("the two paths are mechanically locked") is real only if both paths use the constant **the same way**. Since runtime is conditional and the corrected static path is also conditional (per B1), the shared constant is now genuinely meaningful — good. But the draft's T2 acceptance ("No literal `4/3` in file") is a cosmetic refactor that adds a cross-package import to a deliberately self-contained instrument. **Keep it** (it now pays for itself once both sides share the conditional semantics), but the task note "grep shows core types used elsewhere in probe, so it should already [be a dep]" must be corrected: the dep exists in package.json, but *this file* gains its first import. Confirm the probe build (it may be string-serialized/injected into a page context in some call sites — verify it isn't, or the import breaks at runtime). T2 must include a build+test check, not just a grep.

### MAJOR M2 — Threshold default risks firing on nearly every real atlas → noise, contradicting "instant wow / objectivity-quiet-by-default."
`mipmapOverhead.warn = 1_398_101` (~1.33 MB) fires at exactly a 1024² RGBA texture and above. Real game atlases are routinely 2048² (5.59 MB overhead) — so this finding fires on **every atlas page in a typical project**, adding an `info` finding per atlas. Combined with B1's correction (conditional), an info-storm of "if mipmaps enabled, +X MB" on every page is low-signal. Two corrections:
- Gate on a **higher** default (e.g. one finding per project at the *worst* texture, or a threshold tied to the existing `oversizePx` family so it co-fires with genuinely large textures), OR
- Make it a **single aggregate folder finding** ("Mipmaps would add {totalOverhead} across {n} textures if enabled") instead of N per-texture findings. This is more honest (it's a portfolio cost), quieter, and matches the existing `format-aggregate` pattern already in the codebase. **Adopted: aggregate folder finding** + keep a per-texture threshold only for the single largest contributor if desired. This also sidesteps M5.

### MAJOR M3 — Golden-fixture blast radius is under-scoped and the regeneration is hand-waved.
The draft says "only the 2048-edge fixtures fire; verify per fixture." With the draft's 1.33 MB gate, **any fixture with a ≥1024² texture fires**, which is most non-trivial fixtures, not just oversize ones. The draft offers no list and no deterministic regen command — "use make-fixture skill conventions / regen script" is not a procedure. T10 is therefore an effort under-estimate. **Adopted:** the aggregate-folder-finding design (M2) drops at most **one** finding signature per affected fixture (not N), shrinking the blast radius; and the task must enumerate affected fixtures via a dry-run diff (`pnpm test` failing-golden list) before editing, with the regen mechanism named explicitly.

### MAJOR M4 — i18n parity test is stricter than the draft claims; `{var:bytes}` tokens must match by full token including var name.
Verified `catalogs.test.ts`: it extracts every `\{[^}]+\}` token and asserts the **set is identical** across locales, per key. That means a translation of `find.mipmap.detail` must contain the **exact** tokens `{base:bytes}`, `{overhead:bytes}`, `{mip:bytes}`, `{w}`, `{h}` — same variable names, same `:bytes` hint, same count. The draft says "preserve every `{…}` and `:bytes`" which is roughly right, but the title token `{overhead:bytes}` and the detail's three byte-tokens differ between title and detail — translators must keep each string's own token set. Also: the existing convention is `find.<family>.*` where family ≠ rule id (`oversize` not `dimensions-oversize`; `npot` not `dimensions-npot`). The draft's `messageKey: 'mipmap'` → `find.mipmap.*` is **consistent** with that convention (good), but T1's note calling it part of "the `dimensions*` family" is misleading: the rule id is `dimensions-mipmap`, the message family is `mipmap`. Keep both, documented.

### Minors
- **m1 — `vramBytes` field comment drift.** `AssetMetrics.vramBytes` doc (core L270) says "Σ w×h×4." Adding a sibling field is fine, but update the comment to point to the new conditional field so future readers don't assume base == residency.
- **m2 — `info` findings inflate `findings.info` and `findings.total` budget metrics.** Verified L54-55: there are `findings.info` and `findings.total` global metrics. Adding per-texture info findings (if not aggregated per M2) silently changes anyone's `findings.total` budget. The aggregate design (M2) limits this to +1.
- **m3 — `loadedVramBytesMipmapped = ceil(loadedVramMax × 4/3)` is only exact if every loaded variant mipmaps.** Under the corrected conditional framing this is fine *because it's labeled conditional*, but the field comment must say "assumes mipmaps enabled" not present it as residency.
- **m4 — App.tsx header has 3 metrics in a fixed `md:flex` strip.** Adding a 4th `HeaderMetric` is cosmetically fine but the draft's alternative (inline `(+mip …)` on the existing VRAM cell) is *more* honest and less cluttered, and avoids a new `metric.vramMip` catalog key in all 9 locales. **Adopted: inline conditional suffix on the existing VRAM metric**, no new metric key — smaller surface, fewer translations, clearer that it's the same number "if mipmapped."
- **m5 — Test "constant single-source" assertion `MIP_OVERHEAD === 4/3`.** Fine, but also assert the *probe* path stays conditional (a test that a non-mipmapped texture is charged base only) so a future edit can't silently make the probe unconditional to "match" static. This guards the B1 invariant in the opposite direction.
- **m6 — Rounding parity (`ceil` per-asset vs `round` aggregate) is documented as "≤1 byte" — acceptable.** No change; valid as written.

### Effort assessment
The draft's 10-task breakdown is structurally sound but under-estimates T2 (cross-package import into an import-less file → build verification), T10 (fixture blast radius), and omits the reframing work in B1 (copy + conditional labeling across core comment, finding text, i18n, header). Net effort: **moderate** (was billed as near-trivial "a multiply on existing geometry"). The multiply is trivial; the *honesty framing* and *noise control* are the real work. Adopting the aggregate-finding design reduces total effort by collapsing per-texture findings, fixture churn, and budget-metric impact.

---

# FINAL REVISED MINI-DESIGN

# Mini-Design: Conditional mipmap-cost VRAM accounting in static diagnosis

## 1. Scope (v1)

Static analysis discloses the GPU cost of **mipmaps as a conditional upper bound** (+33%, factor `4/3`), labeled "if mipmaps are enabled" — *not* asserted as actual residency. This (a) honors Inv 5 (disk≠VRAM, shown honestly) by exposing a real GPU cost class the base `w×h×4` omits, and (b) is genuinely consistent with `gl-instrument.ts`, which already charges the identical `4/3` factor **conditionally per `generateMipmap` call** (L141, L111-113) — the static path mirrors that *conditionality* rather than guessing mipmaps are universal.

**In scope:**
- Shared `MIP_OVERHEAD = 4/3` constant in `core`, imported by both `gl-instrument.ts` (replacing the literal at L141) and analysis — the single factor both paths use, each **conditionally**.
- Pure helper `vramBytesMipmapped(size)` in `rules.ts` (the "if mipmapped" ceiling for one texture).
- Additive fields: `AssetMetrics.vramBytesMipmapped`, `AnalysisReport.totals.vramBytesMipmapped`, `totals.loadedVramBytesMipmapped` — all documented as **conditional ("if mipmaps enabled")**, never replacing base numbers.
- **One aggregate folder finding** `mipmap-cost` (not N per-texture findings) modeled on the existing `format-aggregate` pattern: "If mipmaps are enabled, {n} textures would add {overhead} VRAM (+33%)." Severity `info`.
- New `ThresholdConfig.mipmap.warn` (absolute bytes) gating the aggregate (fires only when total conditional overhead is material).
- New budget metric keys (additive): the two new totals + the `mipmap-cost` rule auto-registered.
- i18n catalog entries (all 9) for the aggregate finding.
- Tests: formula, conditional aggregate firing/silent, totals, shared-constant single-source, **and a probe guard that non-mipmapped textures stay base-only**.

**Out of scope:** no pixel reads/decode (geometry only); no per-texture detection of whether mips are *actually* generated (impossible statically — hence the conditional framing); no fix-engine change; no new per-texture finding (aggregate only); no new header metric key (inline suffix instead).

## 2. Contract / type additions (`packages/core/src/index.ts`, all additive)

```ts
// Rule union (L147) — add (lives in the dimensions/footprint family; message family = 'mipmap'):
  | 'mipmap-cost'

/** Mipmap chain multiplier on base texture VRAM: Σ(1/4^n) → 4/3 (+33%). The ONE place this factor
 *  lives — static analysis and the runtime probe both import it and both apply it CONDITIONALLY
 *  (probe: per actual generateMipmap; static: as an explicit "if enabled" ceiling). Never assume
 *  mipmaps are universal — that would be a guess, not a measurement. */
export const MIP_OVERHEAD = 4 / 3;

// AssetMetrics (L267):
  /** GPU footprint IF mipmaps are enabled: ceil(w×h×4 × 4/3). Upper bound, not asserted residency —
   *  static analysis cannot observe generateMipmap. See vramBytes for the base. */
  vramBytesMipmapped: number;
// also amend the existing vramBytes comment (m1) to note it is the BASE, mipmapped is the ceiling.

// AnalysisReport.totals (L292):
  /** Σ vramBytesMipmapped (the "if all mipmapped" ceiling). Conditional, not asserted residency. */
  vramBytesMipmapped: number;
  /** loadedVramBytes × 4/3, the loaded-set ceiling IF mipmaps enabled. Conditional. */
  loadedVramBytesMipmapped: number;

// ThresholdConfig (L277):
  /** Total conditional mipmap overhead (Σ mip − base) before the aggregate folder finding fires. */
  mipmap: { warn: number };
```

No `FindingEstimate` field: the aggregate states a conditional cost, claims no saving (Inv honesty).

## 3. Pure modules (`packages/analysis/src/rules.ts`)

```ts
import { MIP_OVERHEAD } from '@asset-doctor/core';

/** Per-texture VRAM ceiling IF mipmaps are enabled: ceil(w×h×4 × 4/3). Pure geometry, no pixel read. */
export const vramBytesMipmapped = (size: Size): number =>
  Math.ceil(vramBytes(size) * MIP_OVERHEAD);
```

The finding is **aggregate**, built in `folder.ts` (mirrors `formatAggregateFinding`):

```ts
/** Aggregate, conditional. Sums per-asset (mip − base) overhead; fires `info` only past cfg.mipmap.warn.
 *  States a CEILING ("if mipmaps enabled"), never asserts residency. Returns null below gate. */
export function mipmapCostFinding(metrics: AssetMetrics[], cfg: ThresholdConfig): Finding | null
```
- `overhead = Σ (m.vramBytesMipmapped − m.vramBytes)`; if `overhead <= cfg.mipmap.warn` → `null`.
- `n = count of metrics with positive overhead`.
- `severity: 'info'`, `scope: 'folder'`, `rule: 'mipmap-cost'`, stable `id: 'folder:mipmap-cost'`.
- `messageKey: 'mipmap'`, `params: { n, overhead, base: Σbase, mip: Σmip }`.
- Baked English (conditional voice — the honesty fix):
  - title: `Mipmaps would add {overhead:bytes} VRAM (+33%) if enabled`
  - detail: `If mipmaps are on (Pixi/Phaser autoGenerateMipmaps), {n} textures grow from {base:bytes} to {mip:bytes} — a {overhead:bytes} GPU cost the disk size doesn't show. Disabled mipmaps cost nothing here.`
  - fix: `Leave mipmaps off for UI/atlas textures that are never minified; budget the +33% only where you enable them.`

## 4. Probe refactor (`packages/probe/src/gl-instrument.ts`) — M1

Replace the literal at L141, adding this file's first import:
```ts
import { MIP_OVERHEAD } from '@asset-doctor/core';
// L141 (semantics UNCHANGED — still conditional on t.mip):
if (t.w > 0 && t.h > 0) total += t.w * t.h * 4 * (t.mip ? MIP_OVERHEAD : 1);
```
T2 acceptance must include a **probe build + existing-instrument-test pass**, not just "no literal `4/3`" — confirm `gl-instrument.ts` is bundled (not string-injected) so the import resolves at runtime.

## 5. Orchestrator (`packages/analysis/src/analyze.ts`)

- Import `vramBytesMipmapped`; import `mipmapCostFinding` from `./folder`; import `MIP_OVERHEAD` from core.
- Both metric pushes (atlas L73-78, image L87-91): add `vramBytesMipmapped: vramBytesMipmapped(<size>)`.
- In the folder-findings block (after `formatAggregateFinding`, L112): `const mc = mipmapCostFinding(metrics, cfg); if (mc) folder.push(mc);`
- `totals` (L124): `vramBytesMipmapped: metrics.reduce((s,m)=>s+m.vramBytesMipmapped,0)` and `loadedVramBytesMipmapped: Math.ceil(variants.loadedVramMax * MIP_OVERHEAD)`.
- `variants.ts` untouched (factor applied once at the total; documented as conditional).

## 6. Config (`packages/analysis/src/config.ts`) — M2

```ts
mipmap: { warn: 4_194_304 }, // 4 MB total conditional overhead before the aggregate fires; one
// 2048² atlas alone (5.59 MB overhead) trips it, small UI-only projects stay quiet. Calibratable.
```
Higher than the draft's 1.33 MB and **aggregate**, so it fires once per project on real atlas-heavy sets, not per page.

## 7. Budget registry (`packages/budget/src/metrics.ts`) — additive

```ts
reg({ key: 'totals.vramBytesMipmapped', unit: 'bytes', direction: 'max', available: () => true,
  get: (r) => r.totals.vramBytesMipmapped, label: 'VRAM (summed, if mipmapped)' });
reg({ key: 'totals.loadedVramBytesMipmapped', unit: 'bytes', direction: 'max', available: () => true,
  get: (r) => r.totals.loadedVramBytesMipmapped, label: 'VRAM (loaded, if mipmapped)' });
// per-asset:
['vramBytesMipmapped', { key: 'vramBytesMipmapped', unit: 'bytes', direction: 'max',
  get: (m) => m.vramBytesMipmapped, label: 'VRAM (if mipmapped)' }],
```
Add `'mipmap-cost'` to `ALL_RULES` (L29-32) → `findings.mipmap-cost` auto-registers. CLI-measurable (geometry) → no `BROWSER_RULE_CAP` entry. Note (m2): the aggregate adds at most **+1** to `findings.info`/`findings.total`, bounded and documented. `init.ts` seed unchanged.

## 8. i18n (`packages/i18n/src/catalogs/*.json`, all 9) — M4

Add family `mipmap` (consistent with `find.<family>.*`; family ≠ rule id):
```
find.mipmap.title  = "Mipmaps would add {overhead:bytes} VRAM (+33%) if enabled"
find.mipmap.detail = "If mipmaps are on (Pixi/Phaser autoGenerateMipmaps), {n} textures grow from {base:bytes} to {mip:bytes} — a {overhead:bytes} GPU cost the disk size doesn't show. Disabled mipmaps cost nothing here."
find.mipmap.fix    = "Leave mipmaps off for UI/atlas textures never minified; budget the +33% only where you enable them."
```
`en` strings byte-identical to the baked English in §3 (drift guard). Every locale must reproduce the **exact token set per string** (parity test extracts full `{var:hint}` tokens incl. `:bytes` and the var name): title carries `{overhead:bytes}`; detail carries `{n} {base:bytes} {mip:bytes} {overhead:bytes}`. `renderFinding` (i18n/index.ts L132) handles it with no code change. **No new `metric.*` key** (see §9).

## 9. UI (`apps/web/src/App.tsx`) — m4

Inline conditional suffix on the existing VRAM header metric (no new metric, no 4th cell, no new catalog key):
```tsx
<HeaderMetric label={t('metric.vram')}
  value={`${fmtBytes(totals?.loadedVramBytes ?? 0)} · +mip ${fmtBytes(totals?.loadedVramBytesMipmapped ?? 0)}`} />
```
The `mipmap-cost` folder finding renders automatically via `FolderReport`/`Findings` (info severity already styled, verified `Findings.tsx:4-5`). No overlay (whole-portfolio cost, no rects). No other UI files change.

## 10. Honesty / invariants
- **Inv 3 (objectivity):** we measure geometry and disclose a **conditional** cost ("if mipmaps enabled"); we assert nothing about whether they are. The copy says so explicitly. Lives in analysis, not the fix engine.
- **Inv 5 (honest):** base AND conditional ceiling shown side by side; the finding spells out "from base to mip"; no `estimate.vramBytesSaved`.
- **Inv 1/2/4:** pure multiply on existing geometry; zero network/backend; no effect on ≤10s.
- **Drift:** `MIP_OVERHEAD` in core; both paths import it and both apply it **conditionally** — the constant is now a real shared contract, and a probe-guard test (m5) prevents the probe from silently going unconditional.

## 11. Determinism
Integer `Math.ceil` per asset; totals = Σ ceiled integers (`totals.vramBytesMipmapped` ≠ `ceil(Σbase×4/3)`, documented). `loadedVramBytesMipmapped = ceil(loadedVramMax × MIP_OVERHEAD)` deterministic. Aggregate finding `id = 'folder:mipmap-cost'` (stable); sort (RANK then id) unchanged. Probe `round`-at-aggregate vs static `ceil`-per-asset differ ≤1 B/texture — documented, acceptable.

## 12. Edge cases
- `w` or `h` = 0 → base 0 → mip 0 → contributes 0; no finding noise.
- Project under `mipmap.warn` total → null (quiet small/UI-only sets).
- NPOT: keys off actual `w×h` (no double-count with the POT-padding NPOT finding).
- Budget back-compat: additive keys; existing configs unaffected.
- **Goldens (M3):** aggregate design drops at most **one** signature (`mipmap-cost:info`) per affected fixture, only where total overhead ≥ 4 MB. Enumerate affected fixtures from the failing-golden diff (`pnpm --filter @asset-doctor/analysis test`) before editing; regenerate via the existing fixture expectation-update path. Atlas-heavy fixtures (≥2048²) fire; symbol/single-image fixtures stay quiet.

## 13. Test plan
1. **Formula:** `vramBytesMipmapped({w:2048,h:2048}) === ceil(2048*2048*4*4/3) === 22369622`; `=== base 16777216 + overhead 5592406`; `{w:0,h:10} === 0`.
2. **Aggregate fires:** report over a 2048² fixture → folder finding `rule:'mipmap-cost'`, `severity:'info'`, `scope:'folder'`, `params.overhead === Σ(mip−base)`, `messageKey:'mipmap'`.
3. **Aggregate silent:** a small (256²) project → no `mipmap-cost` finding.
4. **Totals:** `totals.vramBytesMipmapped === Σ m.vramBytesMipmapped`; `loadedVramBytesMipmapped === ceil(loadedVramMax × 4/3)`.
5. **Single-source constant:** `MIP_OVERHEAD === 4/3` and `vramBytesMipmapped(s) === ceil(vramBytes(s) × MIP_OVERHEAD)`.
6. **Probe guard (m5):** in the existing instrument test, a texture with NO `generateMipmap` → VRAM `=== w*h*4` (base only); a texture WITH `generateMipmap` → `=== round(w*h*4*MIP_OVERHEAD)`. Locks the probe's conditional semantics so no future edit makes it unconditional.
7. **Budget:** `GLOBAL_METRICS.get('totals.vramBytesMipmapped')` exists, `available()===true`, returns the total; `findings.mipmap-cost` auto-registered.
8. **i18n:** parity test green once all 9 carry the `mipmap` family; render test asserts `find.mipmap.detail` renders `:bytes` formatting with no leftover braces.
9. **Fixtures:** regenerate only the goldens whose total overhead ≥ `mipmap.warn` (enumerated from the dry-run diff).

## 14. ORDERED TASK BREAKDOWN

| id | title | files | tag | deps | acceptance |
|----|-------|-------|-----|------|------------|
| T1 | `MIP_OVERHEAD` const + types (`mipmap-cost` rule, `vramBytesMipmapped` on AssetMetrics + both totals, `mipmap.warn` threshold); amend base `vramBytes` comment | `packages/core/src/index.ts` | core | — | `MIP_OVERHEAD===4/3`; new fields/rule compile; typecheck red only where consumers must add fields |
| T2 | Probe: import the constant, replace literal `4/3` (semantics stay conditional) | `packages/probe/src/gl-instrument.ts` | probe | T1 | No literal `4/3`; **probe builds and existing instrument tests pass** (import resolves at runtime) |
| T3 | `vramBytesMipmapped()` pure helper; `mipmapCostFinding()` aggregate (conditional, info, scope folder) | `packages/analysis/src/rules.ts`, `packages/analysis/src/folder.ts` | analysis | T1 | helper exported; aggregate returns null below gate, `info` finding `messageKey:'mipmap'` + correct params above |
| T4 | Threshold default `mipmap.warn` (aggregate, 4 MB) with rationale | `packages/analysis/src/config.ts` | analysis | T1 | `DEFAULT_THRESHOLDS.mipmap.warn` set + comment |
| T5 | Wire orchestrator: per-asset field + aggregate finding + both totals | `packages/analysis/src/analyze.ts`, `packages/analysis/src/index.ts` | analysis | T3,T4 | every metric has `vramBytesMipmapped`; totals carry both new fields; aggregate emitted; typechecks |
| T6 | Budget: 2 global + 1 asset metric; add `'mipmap-cost'` to `ALL_RULES` | `packages/budget/src/metrics.ts` | budget | T1,T5 | new keys resolvable, `available()===true`; `findings.mipmap-cost` auto-registered |
| T7 | i18n: `find.mipmap.{title,detail,fix}` in all 9 (en byte-matches baked; exact token sets) | `packages/i18n/src/catalogs/*.json` | i18n | T3 | parity + placeholder tests green; no leftover braces |
| T8 | UI: inline `+mip` suffix on existing VRAM header metric; aggregate renders via list | `apps/web/src/App.tsx` | web | T5,T7 | header shows base + `+mip` conditionally; finding in folder report; build green |
| T9 | Tests: formula/aggregate-fires/silent/totals/constant + **probe conditional guard** + budget keys + i18n render | `packages/analysis/test/*`, `packages/probe/test/*`, `packages/budget/test/*`, `packages/i18n/test/*` | test | T2,T5,T6,T7 | all §13 assertions pass |
| T10 | Update only the goldens whose total overhead ≥ `mipmap.warn` (enumerate from failing-golden diff first) | `fixtures/sample-projects/*/expected.json` | test | T5 | `pnpm test` fully green incl. goldens |

**Suggested commits (one meaning each):** T1 · T2 · T3+T4+T5 · T6 · T7 · T8 · T9+T10.

**Key files (absolute):**
- `/home/nonamezzz/Рабочий стол/projects/packages/core/src/index.ts`
- `/home/nonamezzz/Рабочий стол/projects/packages/analysis/src/rules.ts`
- `/home/nonamezzz/Рабочий стол/projects/packages/analysis/src/folder.ts`
- `/home/nonamezzz/Рабочий стол/projects/packages/analysis/src/analyze.ts`
- `/home/nonamezzz/Рабочий стол/projects/packages/analysis/src/config.ts`
- `/home/nonamezzz/Рабочий стол/projects/packages/analysis/src/index.ts`
- `/home/nonamezzz/Рабочий стол/projects/packages/probe/src/gl-instrument.ts` (conditional `4/3` at L141; `t.mip` set at L111-113)
- `/home/nonamezzz/Рабочий стол/projects/packages/budget/src/metrics.ts`
- `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/*.json` (all 9)
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx` (VRAM header metric ~L110)
- Tests: `/home/nonamezzz/Рабочий стол/projects/packages/analysis/test/`, `/home/nonamezzz/Рабочий стол/projects/packages/probe/test/`, `/home/nonamezzz/Рабочий стол/projects/packages/i18n/test/catalogs.test.ts`, `/home/nonamezzz/Рабочий стол/projects/fixtures/sample-projects/*/expected.json`

**Single-source-of-truth guarantee:** `MIP_OVERHEAD` defined once in `core`, imported by analysis (static) and probe (runtime), **both applying it conditionally** — the literal at `gl-instrument.ts:141` is removed and a probe guard test locks the conditional semantics, so neither path can drift into asserting mipmaps that aren't there.