All claims empirically verified. The draft is sound, accurate, and implementation-ready. My verification reproduced the exact deliverable end-to-end (ran the patched generator, confirmed the only byte-diff is the target file and that it equals the canonical reformat). The only corrections needed are framing-level (overstated "CI landmine") and two additive notes (a precedent CI idempotence guard exists worth mirroring; pre-existing orphan fixtures to expect). Here is the final revised mini-design.

---

# Mini-Design: Re-sync the untrimmed-padding generator (Case 20 repack block)

## Verdict: PREMISE TRUE — proceed. Draft is accurate; verified end-to-end.

I empirically reproduced the whole change in a sandbox: patched `generate.mjs`, ran it, and diffed the full generated tree against the committed fixture. Results below confirm every load-bearing claim. Two framing corrections and two additive notes; **no blockers**.

## Problem (verified)

`fixtures/_generator/generate.mjs` Case 20 (`untrimmed-padding`, L1868–1983) builds `regions`/`recoverableArea`/`vramBytesSaved` but **does not emit the `repack` block** the committed `fixtures/sample-projects/untrimmed-padding/expected.json` carries (L83–92). `writeCase()` serializes the `expected.json` object **wholesale** (L172–176: `JSON.stringify(content, null, 2) + '\n'`), so `node generate.mjs` **drops** the block. `grep -c 'repack:' generate.mjs` == 0 confirmed.

I ran the **unmodified** generator's logic path and the patched one: the unmodified generator would emit an `expected.json` with no `repack` key, breaking both `repack` readers. The patched version (below) re-emits it. **Verified: after the patch, the ONLY byte-difference across the entire generated tree vs. the committed tree is `untrimmed-padding/expected.json` — zero collateral drift on the other ~19 cases.**

## Severity correction (MAJOR framing fix — not a blocker)

The draft calls this a "CI/regression landmine." **CI does NOT run the JS fixture generator** — `.github/workflows/ci.yml` runs `typecheck`/`lint`/`test` only; the sole `git diff` idempotence guard is in the **`api` (Go)** job for `fixtures/license/entitlement-fixture.json`. So today CI would **not** catch this drift; it is **latent generator non-idempotence**, surfacing only when a human runs `generate.mjs` (e.g. to regen a *different* case) and silently nukes the `repack` block, after which the two `repack` tests throw `Cannot read properties of undefined`. Real, but human-triggered, not CI-triggered. Fix the framing to "latent non-idempotence" and (recommended, see Out-of-scope-optional) consider mirroring the existing Go-fixture CI guard.

## Who reads `expected.repack` (2 readers — verified, line numbers corrected)

1. `packages/fix/test/fix.test.ts:257` — golden `trim arithmetic + per-sprite packedSize/spriteSourceSize`. Reads `.repack.{trimmedSprites, trimmedAreaReclaimed, perSprite[].{name, packedSize{w,h}, sourceSize{w,h}, spriteSourceSize{x,y,w,h}}}`.
2. `apps/web/src/lib/perceptual.test.ts:663` — `trim-on-repack REALIZES the defect` e2e. Decodes the real PNG → `alphaBBox` → `repackAtlases({trim})`; reads `.repack.{trimmedSprites, trimmedAreaReclaimed, perSprite[].{name, packedSize, spriteSourceSize}}` (also reads top-level `recoverableArea`).

Both `JSON.parse` ⇒ whitespace-agnostic. The op/finding **fires** through the real decode→pack path today.

**Non-`repack` readers (must stay green — verified unaffected, all `JSON.parse`):**
- `packages/analysis/test/analysis.test.ts:923` (reads `regions`/`recoverableArea`/`vramBytesSaved`/`findings`)
- `apps/web/src/lib/perceptual.test.ts:617` (reads `regions`/`recoverableArea`/`vramBytesSaved`/`qualifying`)
- `packages/fix/test/fix.test.ts:1563` (NO-double-emit; reads `regions` only)
- `apps/web/test/trim-on-repack-worker.test.ts:23` (path only)

## Key obstacle (verified) + decision

The committed `expected.json` hand-formats `perSprite` as **single-line objects** (L88–90). Re-serializing the committed file canonically (`JSON.stringify(_, null, 2)`) differs **only** in the `perSprite` block (single-line → multi-line); whitespace-stripped content is **identical** (verified `strip(raw)===strip(canonical): true`). So re-adding `repack` as a plain JS object yields a file that parses identically but is **not byte-identical** ⇒ `git diff` non-empty.

**Decision (kept from draft): REFORMAT the committed `expected.json` to canonical (multi-line `perSprite`) in the same commit.** The generator is the source of truth. **Verified: my patched generator's output is byte-identical to the canonical reformat of the committed file** (`generated === canonical(committed): true`). Reformatting `perSprite` to multi-line is safe — all 6 readers `JSON.parse`. (Rejected: special-casing `writeCase`/hand-rolling single-line JSON — pollutes a shared helper used by ~19 cases.) Trade-off: one-time cosmetic whitespace expansion (101→149 lines, zero semantic change; whitespace-stripped identical).

## Derived `repack` block (the exact addition — empirically validated)

Inserted **after `recoverableArea` (L1926)**; the literal key goes **between `vramBytesSaved` (L1943) and `findings` (L1944)** to match committed key order. **Verified all derived values equal committed** (`trimmedSprites=3`, `trimmedAreaReclaimed=7200`, `note` byte-identical, `perSprite` deep-equal, top-level key order preserved):

```js
const untrimmedSpecs = specs.filter((s) => !s.trimmed);
const repack = {
  note:
    'Trim-on-repack (round20) golden: feeding the per-frame opaque bboxes into repackAtlases({trim}) '
    + 'tightens every UNtrimmed sprite to its bbox extent and emits trimmed:true + sourceSize(full) + '
    + 'spriteSourceSize(=bbox, TP top-left). The already-trimmed trimmed_0 is copied verbatim. '
    + 'trimmedAreaReclaimed === Σ(frame−bbox) === the detector\'s recoverableArea (every shrinkable sprite '
    + 'here also clears minMarginPx), but the FIX measures it directly (B1: reclaimed N px, never the '
    + 'detector\'s N).',
  trimmedSprites: untrimmedSpecs.length,
  trimmedAreaReclaimed: recoverableArea, // identical Σ to the detector's recoverableArea for THIS fixture
  perSprite: untrimmedSpecs.map((s) => ({
    name: s.name,
    packedSize: { w: s.bw, h: s.bh },
    sourceSize: { w: CELL, h: CELL },
    spriteSourceSize: { x: s.mx, y: s.my, w: s.bw, h: s.bh },
  })),
};
```
Then add `repack,` between `vramBytesSaved: recoverableArea * 4,` and `findings: [...]`.

Derived perSprite (verified vs committed): `padded_0{32,32 / 64,64 / 16,16,32,32}`, `padded_1{40,44 / 64,64 / 12,8,40,44}`, `padded_2{48,48 / 64,64 / 8,8,48,48}`. `trimmed_0` excluded by `!s.trimmed`. Reuse `recoverableArea` directly (it is already `Σ(CELL²−bw·bh)` over untrimmed specs, L1924–1926).

## Determinism / honesty (verified)

`specs[]` static; `.filter/.reduce/.map` preserve order; integer arithmetic; no randomness/time/FS-order. `JSON.stringify(_,null,2)` deterministic. **Re-running yields byte-identical output (re-ran twice in sandbox).** Non-ASCII (`−`, `×`, `→`) round-trips as raw UTF-8 — verified `grep -c '\u'` == 0 in both generated and committed; no BOM. Pure fixture plumbing: no analysis-path / network / VRAM-claim change. `trimmedAreaReclaimed === recoverableArea` (7200) is a property of THIS fixture; the `note` states the FIX measures it directly (B1) — preserved verbatim.

## Edge cases

- **`trimmed_0` excluded** — verified perSprite has exactly 3 entries.
- **Top-level key order** — `repack` MUST sit after `vramBytesSaved`, before `findings`; verified key order matches committed.
- **`note` apostrophes** (`detector's`) — escape `\'` in the JS string; emitted as plain `'` in JSON.
- **NEW NOTE for implementer:** running `generate.mjs` will (correctly) leave 6 pre-existing hand-authored files untouched (`sample-projects/README.md`, `atlas-frame-recovery/*`) — the generator never emits these (`grep -c atlas-frame-recovery generate.mjs` == 0). This is pre-existing and **out of scope**; do not be alarmed when `git status` shows them unmodified.

## Out of scope

- No `core`/`fix`/`analysis`/worker/backend/UI changes. No new fixtures, no schema/contract changes, no test changes.
- Not the other CLEANUP-BATCH items; not `includeFileSizes` (N/A — this candidate emits no Pixi manifest field; the only load-bearing field to confirm was `expected.repack` shape, done).
- **Optional follow-up (recommended, NOT required for v1):** mirror the Go-fixture CI guard for the JS generator (`node fixtures/_generator/generate.mjs && git diff --exit-code fixtures/sample-projects/` in the `check` job) so future generator drift is caught automatically. Defer unless the reviewer wants the landmine permanently disarmed; if added, it is a separate commit and must run AFTER this fix (else CI goes red on the pre-existing drift).

## Test plan (real harness; reproduce through the REAL path)

1. **Idempotence (core deliverable)** — `node fixtures/_generator/generate.mjs` from repo root, then `git diff --exit-code fixtures/sample-projects/untrimmed-padding/` ⇒ empty (exit 0). **Already verified in sandbox: byte-identical to canonical reformat.**
2. **`repack` readers fire through the real path:** `pnpm --filter @asset-doctor/fix test` (fix.test.ts:257 green) · `pnpm --filter web test` (perceptual.test.ts:663 — decodes real PNG, asserts `repack` — green).
3. **Non-`repack` goldens unaffected:** `pnpm --filter @asset-doctor/analysis test` (analysis.test.ts:923 green) · perceptual.test.ts:617 green.
4. **Negative pin (optional manual):** delete the `repack` block from the generator, regen, run fix+web tests ⇒ MUST fail with `Cannot read properties of undefined (reading 'trimmedSprites')`. Restore. Proves the block is load-bearing. (Do not commit.)
5. `pnpm typecheck` / `pnpm lint` (generate.mjs is JS; ensure no ESLint regression).

## Ordered task breakdown (small commits)

**Commit 1** — `fix(fixtures): re-emit Case 20 repack block in generate.mjs (idempotent generator)`
- In `generate.mjs` Case 20, after `recoverableArea` (L1926), add the derived `repack` object (above).
- Add `repack,` to the `expected.json` literal between `vramBytesSaved: recoverableArea * 4,` (L1943) and `findings:` (L1944).
- Run `node fixtures/_generator/generate.mjs`; it regenerates `untrimmed-padding/expected.json` (multi-line `perSprite` reformat — verified the only file that changes).
- Stage **both** the generator and the reformatted fixture in this commit.
- Acceptance: `node fixtures/_generator/generate.mjs && git diff --exit-code fixtures/sample-projects/untrimmed-padding/` → empty.
- After: run test-plan steps 2–3 to confirm green.

**Commit 2** (optional, only if reviewer wants the guard) — `ci: assert the JS fixture generator is idempotent` — add the `generate.mjs` + `git diff --exit-code` step to the `check` job (mirrors the existing Go entitlement-fixture guard). Must land after Commit 1.

### Files
- `/home/nonamezzz/Рабочий стол/projects/fixtures/_generator/generate.mjs` (Case 20, L1926 + L1943) — add derived `repack`.
- `/home/nonamezzz/Рабочий стол/projects/fixtures/sample-projects/untrimmed-padding/expected.json` — regenerated (perSprite multi-line; content identical).
- Readers (unchanged, used to verify): `/home/nonamezzz/Рабочий стол/projects/packages/fix/test/fix.test.ts:257`, `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/perceptual.test.ts:663`.
- CI precedent for optional guard: `/home/nonamezzz/Рабочий стол/projects/.github/workflows/ci.yml` (the `api` job's "entitlement fixture is in sync" step).