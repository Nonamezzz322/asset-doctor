Restored and clean. I now have everything needed to produce the revised design. Key corrections to the draft:

1. **Blind spot is wider** — draft missed `fix.lazy.*` and `fix.op.*` (both already in scanned App.tsx, both silently dropped). Proven by experiment.
2. **Draft's rationale comment is factually wrong** — it says "App.tsx never references severity"; App.tsx:2046 DOES (`t(\`severity.${f.severity}\`)`). The comment must be corrected or it ships a lie.
3. **There ARE runtime sources of truth** the draft said don't exist: `OP_KIND_ORDER` (exported value) and `BundleAvailability` literals (`states` array). For `fix.op` and `fix.lazy` we can import the real `OP_KIND_ORDER`, eliminating the "mirror drift" weakness for those two.
4. Severity remains type-only (confirmed) — mirror + drift-assert is correct there.
5. `license.err` suffixes: `KNOWN_CODES` in LicensePanel is a runtime value but private to the file; mirror + drift-assert is the honest approach.

---

# Mini-Design (REVISED): Close the i18n-app-keys guard's dynamic-key blind spots

**Verdict on the draft: SALVAGEABLE but materially under-scoped and one rationale comment is factually false. Revised below.** The premise is real and proven; the fix is correct in approach but covers only 2 of the **4** live blind spots, and its central justifying comment ("App.tsx never references severity") is wrong against the code.

## 0. What I verified against real code (and what the draft got wrong)

**Confirmed true in the draft:**
- The guard scans only `App.tsx + FilmViewer + VerdictBar + TriageLedger`; `Findings.tsx` and `LicensePanel.tsx` are the only two `t()`-using components NOT scanned (full `t()` surface enumerated: those 6 components + `lib/i18n.tsx`, which has zero literal keys).
- `translate()` returns the raw key on miss; `catalogs.test.ts:20` only checks locale-vs-en parity. The silent-raw-key failure mode is real.
- `Severity` (`core/src/index.ts:250`) is a **type-only** union — cannot be runtime-enumerated. The draft's correction here is right; the "import as value" idea is infeasible.
- All referenced keys exist in en today (`severity.*` en:53-56, `license.err.*` en:424-430, `fix.op.*` ×9, `fix.lazy.*` ×3). So this is pure regression-hardening: green now, red on future rename.

**BLOCKER — draft is under-scoped (proven by experiment):** The current guard silently drops **four** dynamic templates, not two. Running the guard's own dynamic-template regex over the already-scanned `App.tsx` yields:
```
fix.lazy.${s}             ← DROPPED (no branch)   App.tsx:505
fix.pack.mode.${...}      ← expanded
fix.pack.grouping.${...}  ← expanded
severity.${f.severity}    ← DROPPED (no branch)   App.tsx:2046  ← App.tsx DOES reference severity
fix.op.${kind}            ← DROPPED (no branch)   App.tsx:2201
fix.op.${g.kind??'other'} ← DROPPED (no branch)   App.tsx:2278
```
I then **renamed `severity.crit`, `fix.op.repack`, and `license.err.network` in en.json and the guard stayed GREEN** — direct proof all three classes are blind spots. The draft closes only `severity.*` (via Findings) and `license.err.*` (via LicensePanel) and **leaves `fix.lazy.*` and `fix.op.*` silently unexpanded inside the file it already scans.** Any fix that ships without these is incomplete by its own stated charter.

**BLOCKER — draft ships a false comment.** The draft's 3a comment says *"Findings.tsx owns `t(\`severity.${f.severity}\`)` … App.tsx never references these."* App.tsx:2046 references `severity.${f.severity}`. The comment must be corrected (severity is referenced in BOTH App.tsx and Findings.tsx; Findings still must be scanned for `findings.none`, and the expansion benefits both).

**MAJOR — there ARE single sources of truth for two of the four** (draft claimed mirroring was the only option):
- `fix.op.*` → `OP_KIND_ORDER` is an **exported runtime value** (`apps/web/src/lib/op-manifest.ts:25`, 8 verbs) plus the UI's `'other'` fallback. **Import it** instead of hand-mirroring → zero drift risk.
- `fix.lazy.*` → `BundleAvailability = 'eager'|'lazy'|'isolated'` (`core:411`); the `states` array in App.tsx mirrors it. This one is type-only at the core level but the suffix set is tiny and stable; mirror + drift-assert (or reuse a small const) is acceptable.
- `severity.*` → genuinely type-only (mirror + drift-assert — draft is right).
- `license.err.*` → `KNOWN_CODES` is a runtime `Set` but **private** to `LicensePanel.tsx` (not exported). Mirror + drift-assert.

## 1. Scope (REVISED)

**In scope (test-file only — `apps/web/test/i18n-app-keys.test.ts`):**
1. Add `Findings.tsx` + `LicensePanel.tsx` to the scan blob (`appSrc`).
2. Extend `expandedDynamicKeys()` with **four** new prefix branches: `severity.`, `license.err.`, `fix.lazy.`, `fix.op.` — closing all four proven blind spots, including the two already inside App.tsx.
3. For `fix.op.*`, **import `OP_KIND_ORDER`** from `../src/lib/op-manifest` and expand to `[...OP_KIND_ORDER, 'other']` (verified single source of truth) — no mirror.
4. Mirror lists only where no runtime SoT exists: `SEVERITY_SUFFIXES` (type-only union), `LICENSE_ERR_SUFFIXES` (private Set), `LAZY_SUFFIXES` (type-only union). Each backed by a drift-assert that every suffix resolves in `CATALOGS.en`.
5. Drift-guard `it()` blocks for the mirrored lists (severity, license.err, fix.lazy) with precise per-key failure messages.
6. Correct/extend the header comment to document the maintenance contract AND fix the false "App.tsx never references severity" claim.

**Out of scope (unchanged from draft, all correct):** any app/catalog/core change; runtime-importing `Severity` as a value (infeasible); broad auto-discovery of `.tsx`; auto-deriving prefixes from the catalog.

## 2. Exact changes (test-file only)

### 2a. Scan blob — add the two components (corrected rationale)
Append to the `appSrc` concatenation (after line 29):
```ts
  + '\n'
  // Findings.tsx owns findings.none + t(`severity.${f.severity}`). (App.tsx:2046 also references
  // severity.* — both are now covered by the severity. branch below; Findings must still be scanned
  // for findings.none, which nothing else references.)
  + comp('Findings.tsx')
  + '\n'
  // LicensePanel.tsx owns the license.* static keys + t(`license.err.${…}`) (Pro activation UI),
  // referenced nowhere else.
  + comp('LicensePanel.tsx');
```

### 2b. Suffix sources (import where possible; mirror + drift-assert where not)
```ts
import { OP_KIND_ORDER } from '../src/lib/op-manifest'; // single source of truth for fix.op.* suffixes

// fix.op.${kind} (App.tsx:2201,2278) — OP_KIND_ORDER is the live verb set; the UI adds an 'other'
// bucket for the null/unknown group (App.tsx:2278 `g.kind ?? 'other'`). Imported ⇒ cannot drift.
const FIX_OP_SUFFIXES = [...OP_KIND_ORDER, 'other'];
// severity.${f.severity} (Findings.tsx:40, App.tsx:2046) — mirrors core's TYPE-ONLY Severity union
// ('crit'|'warn'|'ok'|'info'); no runtime values array exists, so mirror + assert-all-exist (below).
const SEVERITY_SUFFIXES = ['crit', 'warn', 'ok', 'info'];
// license.err.${…} (LicensePanel.tsx:29) — mirrors LicensePanel KNOWN_CODES (private Set) + 'generic'.
const LICENSE_ERR_SUFFIXES = ['unknown_key', 'inactive', 'seats_exceeded', 'reactivate', 'network', 'rate_limited', 'generic'];
// fix.lazy.${s} (App.tsx:505) — mirrors core's BundleAvailability ('eager'|'lazy'|'isolated').
const LAZY_SUFFIXES = ['eager', 'lazy', 'isolated'];
```

### 2c. Four new branches in `expandedDynamicKeys` (after line 57)
```ts
    else if (tmpl.startsWith('severity.')) SEVERITY_SUFFIXES.forEach((s) => keys.add(`severity.${s}`));
    else if (tmpl.startsWith('license.err.')) LICENSE_ERR_SUFFIXES.forEach((s) => keys.add(`license.err.${s}`));
    else if (tmpl.startsWith('fix.lazy.')) LAZY_SUFFIXES.forEach((s) => keys.add(`fix.lazy.${s}`));
    else if (tmpl.startsWith('fix.op.')) FIX_OP_SUFFIXES.forEach((s) => keys.add(`fix.op.${s}`));
```
Order note: branch the more-specific `fix.pack.mode.`/`fix.pack.grouping.` BEFORE `fix.op.`/`fix.lazy.` (already true — `fix.pack.*` are earlier in the chain and don't prefix-collide with `fix.op.`/`fix.lazy.`). `fix.lazy.note` is a STATIC key (`t('fix.lazy.note')`, no `${}`) caught by the static regex, so the `fix.lazy.` dynamic branch never needs to emit `note` — verified it's referenced directly, not via template.

### 2d. Drift-guard `it()` blocks (mirrored lists only; fix.op is import-backed so it self-checks)
```ts
it('severity.* dynamic keys all exist in en — drift guard for the mirrored type-only union', () => {
  for (const s of SEVERITY_SUFFIXES)
    expect(CATALOGS.en[`severity.${s}`], `severity.${s} must exist in en.json`).toBeDefined();
});
it('license.err.* dynamic keys (LicensePanel KNOWN_CODES + generic) all exist in en', () => {
  for (const s of LICENSE_ERR_SUFFIXES)
    expect(CATALOGS.en[`license.err.${s}`], `license.err.${s} must exist in en.json`).toBeDefined();
});
it('fix.lazy.* + fix.op.* dynamic keys all exist in en (fix.op.* mirrors imported OP_KIND_ORDER)', () => {
  for (const s of LAZY_SUFFIXES)
    expect(CATALOGS.en[`fix.lazy.${s}`], `fix.lazy.${s} must exist in en.json`).toBeDefined();
  for (const s of FIX_OP_SUFFIXES)
    expect(CATALOGS.en[`fix.op.${s}`], `fix.op.${s} must exist in en.json`).toBeDefined();
});
```
The `fix.op` block is the strongest: it asserts the **imported** `OP_KIND_ORDER` (+`other`) all resolve in en, so if core/op-manifest adds a verb, this fails until the catalog catches up — a *verified* mirror, not a hand mirror.

### 2e. Header comment — extend rationale + maintenance contract
Append to lines 1–7: a renamed `severity.*` / `fix.op.*` / `fix.lazy.*` / `license.err.*` key would render raw dotted keys in all 9 langs (the Feature-4 class), undetected by the catalog drift test. **Maintenance contract:** any new `t(\`prefix.${…}\`)` site must (a) have its component in `appSrc` and (b) register its prefix branch here; mirrored suffix lists (severity/license.err/fix.lazy) must be updated when the underlying union/Set changes, and the drift-guard blocks will fail loudly if they rot. `fix.op.*` is import-backed (`OP_KIND_ORDER`) and self-maintains.

## 3. Honesty / invariants
- Invariants 1–2: test-only, pure Node, no network, no asset egress — untouched.
- Objectivity (3): measures "does referenced key exist", emits pass/fail; generates nothing.
- No false confidence: rejects the infeasible value-import of a type; uses the real runtime SoT (`OP_KIND_ORDER`) where it exists and honestly flags the three mirrored lists as drift-prone, each backed by an assertion. The corrected comment no longer states the false "App.tsx never references severity" claim.
- No app behavior change (premise preserved exactly).

## 4. Determinism
All inputs are `readFileSync` of fixed source files + the static `CATALOGS.en` object + the imported `OP_KIND_ORDER` const. No clock/RNG/network/order-dependence; `missing` is already `.sort()`ed; new blocks iterate fixed arrays. Regex over fixed text is deterministic.

## 5. Edge cases
- **Ternary in template** (`license.err.${KNOWN_CODES.has(code) ? code : 'generic'}`): expansion is by prefix, the expression body is never parsed — captured intact (verified by running the regex).
- **`fix.op.${g.kind ?? 'other'}`**: the `'other'` literal is explicitly in `FIX_OP_SUFFIXES`; the `?? 'other'` body is ignored by prefix-expansion. Verified `fix.op.other` exists in en.
- **`fix.lazy.note` static vs dynamic**: `note` is referenced as `t('fix.lazy.note')` (no `${}`) → static regex; not emitted by the dynamic branch. No double-handling, no missing.
- **Prefix collision**: `fix.pack.mode.`/`fix.pack.grouping.` are checked first and don't collide with `fix.op.`/`fix.lazy.`; `severity.`/`license.err.` collide with nothing. `license.*` static keys (no `${}`) go through the static regex only.
- **Stale mirror**: severity/license.err/fix.lazy caught by §2d asserts; fix.op caught by the import-backed assert.
- **Component file rename**: `comp()` throws ENOENT → loud failure (desired).
- **A future referenced key that doesn't exist anywhere**: main scan (§2a+2c) makes `missing` non-empty → named failure.

## 6. Test plan (real harness, real defect path — EXECUTED, not hypothetical)
**Baseline:** `vitest run test/i18n-app-keys.test.ts` → 3 tests pass (green now). ✔ run.

**Negative (defect reproduced through the real path) — EXECUTED during this review, reverted:** renamed `severity.crit`, `fix.op.repack`, and `license.err.network` in `en.json` (left components untouched) and ran the **current** guard → **stayed GREEN** (proves all three blind-spot classes are real). After the change in §2, the same rename must turn the guard **RED**: main scan reports `missing: severity.crit, fix.op.repack, license.err.network`, and the three drift blocks fail with precise messages. (To keep the i18n catalogs drift test honest during the manual experiment, rename across all 9 locales; do not commit.)

**Full-suite sanity:** `pnpm --filter @asset-doctor/web test` and `pnpm --filter @asset-doctor/i18n test` stay green (no app/catalog change shipped). Note: pnpm is not on PATH here (corepack symlink hits EACCES); use the local binary `node_modules/.bin/vitest` from `apps/web/` as I did, or fix corepack first.

## 7. ORDERED TASK BREAKDOWN (small commits)

1. **`test(i18n-guard): scan Findings + LicensePanel; expand severity/license.err/fix.lazy/fix.op`**
   - Add `comp('Findings.tsx')` + `comp('LicensePanel.tsx')` to `appSrc` with **corrected** rationale comments (§2a).
   - Add `import { OP_KIND_ORDER }`; define `FIX_OP_SUFFIXES = [...OP_KIND_ORDER,'other']`, `SEVERITY_SUFFIXES`, `LICENSE_ERR_SUFFIXES`, `LAZY_SUFFIXES` (§2b).
   - Add the four `expandedDynamicKeys` branches (§2c).
   - Fix + extend the header comment: maintenance contract, and **remove the false "App.tsx never references severity" framing** (§2e).
   - Run `node_modules/.bin/vitest run test/i18n-app-keys.test.ts` from `apps/web/` → green.

2. **(scratch, not committed) Negative verification**
   - Rename `severity.crit` + `fix.op.repack` + `fix.lazy.eager` + `license.err.network` across 9 locales; confirm guard **red** (main scan + drift blocks name each); confirm pre-§2 guard **green** (already done for 3 of them). Revert. Record red-before/green-after in Task 3's commit/PR body.

3. **`test(i18n-guard): explicit drift-guard blocks for severity/license.err/fix.lazy/fix.op`**
   - Add the three drift `it()` blocks (§2d), with the `fix.op` block asserting the imported `OP_KIND_ORDER` (+`other`).
   - Optionally fold a source-text parse of the `Severity` union (`core/src/index.ts`) `expect(parsed).toEqual(SEVERITY_SUFFIXES)` to turn the one remaining hand-mirror that has no runtime SoT into a verified mirror (~5 lines; recommended since severity is the only fully-mirrored union).
   - Run `i18n-app-keys` → green; run full web + i18n suites → green.

(Two commits if the optional source-parse folds into Task 1; otherwise three. One semantic change per commit per repo convention.)

---

**Relevant absolute paths**
- Only file to edit: `/home/nonamezzz/Рабочий стол/projects/apps/web/test/i18n-app-keys.test.ts`
- Runtime SoT to import for fix.op: `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/op-manifest.ts:25` (`OP_KIND_ORDER`)
- Uncovered components: `/home/nonamezzz/Рабочий стол/projects/apps/web/src/components/Findings.tsx:40` (`findings.none`, `severity.${…}`), `/home/nonamezzz/Рабочий стол/projects/apps/web/src/components/LicensePanel.tsx:11,29` (`KNOWN_CODES`, `license.err.${…}`)
- In-file (already-scanned) blind spots: `/home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx:505` (`fix.lazy.${s}`), `:2046` (`severity.${f.severity}`), `:2201` & `:2278` (`fix.op.${…}`)
- Type-only unions: `/home/nonamezzz/Рабочий стол/projects/packages/core/src/index.ts:250` (`Severity`), `:411` (`BundleAvailability`)
- en catalog: `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/en.json` (severity 53-56, fix.lazy 308-311, fix.op 219-227, license.* 416-423, license.err.* 424-430)
- Adjacent nets that miss this: `/home/nonamezzz/Рабочий стол/projects/packages/i18n/test/catalogs.test.ts:20`, `/home/nonamezzz/Рабочий стол/projects/packages/i18n/test/render.test.ts:203`

**Three load-bearing corrections to the draft:** (1) **Under-scoped** — proven by experiment that `fix.lazy.*` and `fix.op.*` are ALSO silently dropped (inside the already-scanned App.tsx), not just severity/license.err; renaming `severity.crit`+`fix.op.repack`+`license.err.network` left the current guard GREEN. (2) **False comment** — the draft's "App.tsx never references severity" is wrong (App.tsx:2046). (3) **Better SoT available** — `fix.op.*` should import the exported `OP_KIND_ORDER` (verified runtime SoT), not hand-mirror; only `severity`/`license.err`/`fix.lazy` need mirror+drift-assert. The draft's other corrections (Severity type-only; pure regression-hardening) are confirmed correct.