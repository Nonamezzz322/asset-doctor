I have everything needed. The draft is overwhelmingly correct and code-grounded. The premise is true (real hole), the single guard reuse is right, the resize-path and multi-tier-path scope exclusions are both verified correct (opaque never reaches them; tiered refs are `replaced`-excluded). 

Two refinements I will fold into the final design:
1. **Placement**: insert the gate **before** `emittedThis.add(variantPath)` (i.e., right after the collision check at L1155, before L1156) rather than after L1156. This eliminates the draft's "emittedThis already ran — harmless" hand-wave entirely. The gate uses `enc.mime === srcMime` and `enc.bytes.length` which are available right after L1151. The collision check at L1152 must run first (it's keyed on the same `variantPath` and is unrelated to size). So the correct order is: compute `variantPath` (L1151) → collision check (L1152-1155) → **size-loss gate (new)** → `emittedThis.add` (L1156).

2. The draft's claim that `enc.mime === srcMime` is the right discriminator for "same-format" is correct — `renamedTo(srcPath, enc.mime)` and `mimeOf(srcPath)` both key on the post-encode/source extensions respectively, and the guard's documented scope is precisely "same-format opaque re-encode," with format changes left to downstream accounting.

Here is the final revised design.

---

# Mini-Design (REVISED): Close the opaque profile-fan-out size-loss hole

**Feature ID:** round11/12 leftover MINOR — honesty guard (worker fan-out emit reuses the existing transcode size-loss guard)
**Invariants protected:** #3 (objectivity — never over-claim) + #5 (disk≠VRAM honesty)
**Surface:** `apps/web/src/worker/fix.worker.ts` (one call site inside `emitLooseProfileFanout`) + `apps/web/src/worker/transcode-guard.test.ts` (extend). No contract/type change, no backend, no pure-package source change.

## Verdict on the draft

**Premise CONFIRMED TRUE** against the real code. Verified line-by-line:
- `transcodeIsSizeLoss(opaque, reencoded, source)` is `opaque===true && reencoded >= source` (`transcode-guard.ts` L15-17). Reused verbatim; already imported into the worker (`fix.worker.ts` L121).
- Single-emit transcode path GUARDS (`fix.worker.ts` L1629-1633) with the exact skip note the draft quotes.
- `emitLooseProfileFanout` (L1114-1192) `out.push`es every variant at L1163 with **no** size-loss check, threading `opaque` into `feToEncodeOpts` at L1146. **Real hole.**
- Only opaque-passing caller: transcode op at L1596 (`op.opaque`). Resize caller L1532 passes no opaque arg (defaults false). `plan.ts` sets `opaque:true` ONLY on `transcode` ops (L313 fold-in, L328 standalone), never on the resize op (L280). ⇒ the guard cannot fire on the resize fan-out. **Draft correct.**
- `mimeOf` (L2852) is a pure `MIME_BY_EXT` extension lookup; `bytesByRef.get(ref)` is an `ArrayBuffer` with `.byteLength`. **Draft correct.**

**Two scope exclusions independently RE-VERIFIED (not taken on faith):**
- **Multi-tier loop (L2100+)** — draft declared out of scope. Confirmed safe on TWO independent grounds: (a) tier encode opts come from `feToEncodeOpts(fe)` (L2136) / `encOptsFor(eff, true)` (L2138) — **`opaque` is never spread in**, so `enc` there is never an opaque re-encode; (b) the loop iterates `merged` and `continue`s on `replaced.has(imagePath)` (L2060), and any opaque transcode already `replaced.add(path)`s its source (L1647 / fan-out L1180) ⇒ an opaque-transcoded ref is excluded from tiering anyway. No blocker; correctly out of scope.
- **Resize fan-out** — `opaque=false` by construction (plan.ts never sets opaque on resize). Confirmed.

**One refinement (MINOR, not a blocker):** the draft's insertion point (after `emittedThis.add` at L1156) forces a "harmless" hand-wave about the collision set having the path added before the skip. The cleaner, equally-correct placement is **before** `emittedThis.add` — after the collision check, before adding to `emittedThis`. This removes the hand-wave entirely with no behavioral difference. Adopted below.

## 1. Scope

**In:** Inside `emitLooseProfileFanout`, per fanned-out variant, when `opaque === true` **AND** `enc.mime === mimeOf(srcPath)` (same-format opaque re-encode — exactly the guard's documented scope), call `transcodeIsSizeLoss(true, enc.bytes.length, srcBytes)` before recording the variant. On size-loss: skip with the **same honest `skipped[]` note shape** as the single-emit path and record NOTHING (no `emittedThis.add` / `hashEmit` / `out.push` / `recordVariant` / `recordPngquantCandidate` / rename row / owner mutation / `firstEmitted` flip).

**Out:** format-changing variants (`enc.mime !== srcMime` — PNG→WebP/AVIF; legitimate downstream-accounted per the guard's scope comment L8-10) · the resize fan-out (opaque=false by construction) · the multi-tier loop (opaque never reaches it; tiered refs `replaced`-excluded) · any contract/type/backend/pure-package change · modifying `transcodeIsSizeLoss` itself.

## 2. Contract / type changes

**None.** `transcodeIsSizeLoss(opaque, reencodedBytes, sourceBytes) => boolean` already has the exact signature. No `core`/`parsers`/`fix` contract touched.

## 3. Pure modules

**No new pure module** (and explicitly do not add one for a trivial `===` equality). Reuse `transcode-guard.ts` verbatim.

## 4. Worker change (the only source edit)

### 4a. Source basis once, after `const rp = resolveProfile(ref);` (L1132)

```ts
// Honesty guard (round11/12 MINOR): SOURCE byte length + mime for the same-format opaque size-loss check
// below. `opaque` is only ever true on a transcode op (plan.ts L313/L328), and the guard fires ONLY when a
// variant re-encodes to the SAME mime as the source — a real format change (PNG→WebP/AVIF) is a legitimate
// downstream-accounted choice (transcode-guard.ts scope comment), never gated. bytesByRef always holds the
// parsed source on this loose path (the transcode caller L1571 already `continue`d on !bytes).
const srcBytes = bytesByRef.get(ref)?.byteLength ?? 0;
const srcMime = mimeOf(srcPath);
```

### 4b. Gate AFTER the collision check (L1155), BEFORE `emittedThis.add(variantPath)` (L1156)

```ts
// Honesty guard: a SAME-FORMAT opaque re-encode that is not strictly smaller is no optimization — never ship
// a larger/equal page under a "fix" banner (invariant 3/5). Mirror the single-emit transcode path's note
// byte-for-byte and record NOTHING (don't even add to emittedThis — this variant never existed). A real
// PNG→WebP/AVIF change is NOT gated (enc.mime !== srcMime) per the guard's documented scope.
if (opaque && enc.mime === srcMime && transcodeIsSizeLoss(true, enc.bytes.length, srcBytes)) {
  skipped.push({ assetRef: ref, reason: `transcode kept original: opaque re-encode was not smaller (${enc.bytes.length} ≥ ${srcBytes} B)` });
  continue;
}
emittedThis.add(variantPath);
```

Placing it before `emittedThis.add` means a skipped variant leaves `emittedThis` untouched — strictly cleaner than the draft, and the collision guard (L1152, keyed on `variantPath`) still runs first so a true fallback-collision is caught before the size check (size-loss of a colliding variant is moot — it was never going to emit).

### 4c. Owner-fallback (no extra code)

`ownerImage`/`ownerImageUnhashed` default to `srcPath` (L1134/L1139); `firstEmitted` stays `false` until a real emit. If every format is skipped (all size-loss / unavailable / collide), the fn returns `{ ownerImage: srcPath, ownerImageUnhashed: srcPath, referencesChanged: false }`; the caller (L1597-1603) sets `ownerActualName.image = srcPath` and does not flip `referencesChanged` — identical to the single-emit "keep original" bookkeeping (L1631). No caller change.

### 4d. Determinism

`mimeOf` pure ext lookup · `srcBytes` stable map read · `transcodeIsSizeLoss` pure integer compare · iteration order over `rp.formats` unchanged. Fully deterministic.

## 5. UI / backend

**None.** The skip flows through the existing `skipped[]` channel the receipt renders. No new i18n key — parity with the single-emit raw worker note (also un-keyed). Backend untouched.

## 6. Honesty + invariant compliance

- **Inv 3:** no longer ships a same-or-larger page from an opaque re-encode under a fix banner.
- **Inv 5:** purely a DISK-byte decision (opaque drop is DISK-only; GPU stays RGBA8888). Consistent.
- **Off ⇒ byte-identical:** the branch is reachable only when `opaque===true`, which only an `opaqueAlpha`-opted (default OFF) transcode op produces. Feature OFF ⇒ branch dead ⇒ output byte-identical. Even ON, a format-CHANGE variant (`enc.mime !== srcMime`) is byte-identical to today.
- **Browser-only:** entirely in the in-browser worker; the load-bearing predicate stays in Node-testable `transcode-guard.ts`. Diagnosis path untouched.

## 7. Edge cases

1. Format change (PNG→WebP/AVIF) larger ⇒ `enc.mime !== srcMime` ⇒ ships (unchanged, correct).
2. Same-format opaque strictly smaller ⇒ `transcodeIsSizeLoss` false ⇒ ships (the win).
3. Same-format opaque equal bytes ⇒ `>=` true ⇒ skipped (matches single-emit semantics; no zero-win name churn).
4. All variants size-loss ⇒ owner stays `srcPath`, `referencesChanged=false` ⇒ Phase-C keeps consumers on original (§4c).
5. First variant size-loss, later format-change ships ⇒ `firstEmitted` flips on the surviving variant ⇒ it becomes canonical rename target + `replaced.add(srcPath)`. The skipped same-format variant simply never existed (now genuinely never added to `emittedThis` either).
6. `srcBytes === 0` (ref missing) ⇒ unreachable on this path (caller L1571 `continue`s on `!bytes`); defensive `?? 0` would only skip a same-mime hit (a 0-byte source has no honest re-encode to ship). Not a reachable regression.
7. `mimeOf` of `.jpeg` ⇒ `image/jpeg`; an opaque JPEG→JPEG re-encode gated correctly. Profiles realistically emit png/webp/avif; logic is mime-correct regardless.
8. Multi-tier opaque (re-checked): impossible — tier encode opts never carry `opaque`, and opaque-transcoded refs are `replaced`-excluded from the tier loop (L2060). No leak.

## 8. Test plan (real Vitest harness, no browser e2e)

Extend `apps/web/src/worker/transcode-guard.test.ts`. The worker decision is `opaque && enc.mime === srcMime && transcodeIsSizeLoss(...)`; test the composed decision (pure predicate + same/format-change discriminator), mirroring the worker condition exactly:

```ts
describe('fan-out same-format-vs-format-change gating (profile fan-out hole)', () => {
  // Mirror the worker guard verbatim: opaque && variantMime === srcMime && transcodeIsSizeLoss(true, v, s)
  const fanoutSkips = (opaque: boolean, srcMime: string, variantMime: string, v: number, s: number) =>
    opaque && variantMime === srcMime && transcodeIsSizeLoss(true, v, s);

  it('opaque same-format (png→png) LARGER ⇒ skip', () =>
    expect(fanoutSkips(true, 'image/png', 'image/png', 12000, 10000)).toBe(true));
  it('opaque same-format (png→png) EQUAL ⇒ skip', () =>
    expect(fanoutSkips(true, 'image/png', 'image/png', 10000, 10000)).toBe(true));
  it('opaque same-format (png→png) SMALLER ⇒ ship', () =>
    expect(fanoutSkips(true, 'image/png', 'image/png', 7000, 10000)).toBe(false));
  it('opaque FORMAT CHANGE (png→webp) larger ⇒ ship (downstream-accounted, never gated)', () =>
    expect(fanoutSkips(true, 'image/png', 'image/webp', 12000, 10000)).toBe(false));
  it('opaque FORMAT CHANGE (png→avif) larger ⇒ ship', () =>
    expect(fanoutSkips(true, 'image/png', 'image/avif', 99999, 10000)).toBe(false));
  it('NON-opaque same-format larger ⇒ ship (branch dead when opaque off ⇒ byte-identical to today)', () =>
    expect(fanoutSkips(false, 'image/png', 'image/png', 12000, 10000)).toBe(false));
});
```

Do **not** extract a pure module solely for the `enc.mime === srcMime` equality — the load-bearing decision (`transcodeIsSizeLoss`) is already shared, and the equality is trivial. The test mirror's drift risk is bounded to a one-line `===`.

Full-suite regression: `pnpm test` (fix-worker/plan/transcode-guard suites stay green; feature OFF ⇒ new branch dead ⇒ no snapshot/byte-output shift). No Go change ⇒ no `apps/api` impact.

## 9. Ordered task breakdown (small commits)

1. **commit 1 — test first:** Extend `apps/web/src/worker/transcode-guard.test.ts` with the `fanoutSkips` describe block (§8). `pnpm test` green (cases exercise the composed decision the predicate half-implements). Pins the same-format-vs-format-change contract before wiring.
   - `test(fix): pin fan-out same-format opaque size-loss gating contract`

2. **commit 2 — worker guard (the fix):** In `emitLooseProfileFanout`, add `srcBytes`/`srcMime` after L1132 (§4a) and the gate after the collision check, before `emittedThis.add` (§4b). The `transcodeIsSizeLoss` import already exists (L121). Run `pnpm typecheck` + `pnpm test` + `pnpm lint`.
   - `fix(fix): guard opaque same-format profile fan-out against size-loss (never ship a larger page)`

3. **commit 3 (optional, fold into 2 if trivial) — comment parity:** Update `transcode-guard.ts` L8-10 scope comment to note the predicate now backs BOTH the single-emit AND the profile-fan-out opaque paths. Pure-comment, no behavior.
   - `docs(fix): note fan-out path now shares the opaque size-loss guard`

## Key file references

- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix.worker.ts` — `emitLooseProfileFanout` L1114-1192 (`srcBytes`/`srcMime` after L1132; gate after collision check L1155, before `emittedThis.add` L1156); single-emit reference guard L1622-1633; `mimeOf` L2852; `MIME_BY_EXT` L2851; transcode fan-out caller L1596; resize caller (no opaque) L1532; tier loop L2031-2100 (opaque never reaches; `replaced`-exclusion L2060); guard import L121.
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/transcode-guard.ts` — pure predicate L15-17; scope comment L5-10.
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/transcode-guard.test.ts` — extend.
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/plan.ts` — `opaque` only on transcode ops (L313, L328); resize op (L280) carries none.