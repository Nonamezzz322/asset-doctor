All verified. `<details>` already used 4x in App.tsx (the `Receipt`'s own fix-settings disclosure is one). `text-ink-soft`, `text-warn`, `text-ink` tokens exist. `break-all`/`min-w-0` has precedent. The improvement is genuinely low-risk and additive.

I now have everything needed to deliver the adversarial review and revised design.

---

# Adversarial Review + Revised Mini-Design: Render the per-file change manifest in the Receipt

## Adversarial findings (verified against source)

**BLOCKER — none.** No invariant violation, no contract drift, no determinism hole. The premise is real: `FixReceipt.operations: string[]` (fix-protocol.ts:89) and `skipped: {assetRef; reason}[]` (line 90) are populated by the worker and rendered 0 / count-only in App.tsx (operations: 0 sites confirmed; skipped: line 943 confirmed `{receipt.skipped.length} {t('fix.skipped')}`). Pure presentation, no worker/network/contract change.

**MAJOR-1 — Wrong push-site count (honesty/credibility of own evidence).** Draft asserts "**12** distinct `operations.push` sites" then lists **11** line numbers (494, 590, 607, 661, 682, 709, 723, 916, 982, 1009, 1155). Actual `grep -c` = **11**. The "12" is wrong; there are 11 sites emitting **8 verbs** (the verb count is what matters and is right). Fixed in revision. (A self-review that miscounts its own evidence is exactly the kind of thing this item is meant to surface honestly in the receipt — so the spec must get its own numbers right.)

**MAJOR-2 — `t()` plural-key shape unverified in draft, now confirmed safe.** Draft proposes plural objects `{ "$count": "n", "one": "{n} change", "other": "{n} changes" }`. Verified this is the exact shape of existing `fix.meshedCount` (en.json) and that `translate` (index.ts:117-119) selects via `Intl.PluralRules` keyed on `$count`. `t('fix.changes.title', { n })` will work. The catalogs test (catalogs.test.ts:24-25) enforces every locale ships a plural **object with `.other`** for these two keys — so a locale that copies a bare string for a plural key **fails the test**. Revision flags this explicitly: the 2 plural keys MUST be objects in all 9 locales; the 8 `fix.op.*` keys are plain strings.

**MAJOR-3 — Collision worry was a phantom; real key-namespace fact corrected.** Draft frets about deleting `fix.skipped` and about `fix.skipped.title` colliding. Verified: catalogs are a **flat string-keyed map**, not nested — `"fix.skipped"`, `"fix.skipped.whyNoKernel"`, and a new `"fix.skipped.title"` are three independent flat keys that coexist with zero collision (confirmed `fix.skipped` + `fix.skipped.whyNoKernel` already coexist today). So: keep `fix.skipped` (still used? — see MINOR-1), add `fix.skipped.title` freely. The draft's hedging is correct in outcome but for the wrong reason; revision states the real reason.

**MINOR-1 — `fix.skipped` becomes dead after T6.** Confirmed the ONLY use of flat `fix.skipped` is line 943, which T6 replaces. The `fix.skipped.why*` keys are different keys (still used at lines 468-471, 650-651). So `fix.skipped` genuinely goes unused. Draft says "leave it." Acceptable (additive-only, parity-safe), but revision notes it as a follow-up cleanup candidate rather than pretending it might still be referenced.

**MINOR-2 — Two-format-per-verb is real but handled.** Verified `resize atlas X → …` (661) and `resize X → …` (682) both lead with `resize`; `repack X (spine)` (494) and `repack X[ (polygon)]` (590) both lead with `repack`. First-token classification is correct for all 8 verbs. The only multi-word special case is `drop duplicate` (723) → leading token `drop`, which the draft's first-token rule already maps to `drop` **without** needing the special-case it describes. Revision simplifies: `classifyOp` is pure first-token lookup against the 8-verb set; no `drop duplicate` special case needed (the first token `drop` already classifies correctly). This removes dead complexity from T1.

**MINOR-3 — `OP_KIND_ORDER` lists `tier` last but `REFERENCE_CHANGING` includes it — consistent, but ordering rationale unstated.** No bug. Revision documents order = rough "least surprising / drop-in first → reference-changing → tier last" so the visual grouping is intentional, not arbitrary.

**MINOR-4 — Effort estimate honest.** S is right: ~60 LOC pure helper + test, one Receipt edit, 10 keys × 9 locales (90 string entries, 2 of them plural objects). No worker, no contract, no probe. The 9-locale hand-edit is the only tedium; gated by catalogs.test.ts. Confirmed `<details>` has 4 existing usages in App.tsx (precedent), tokens `ink-soft`/`warn`/`ink` exist in index.css, `break-all`/`min-w-0` has precedent — zero new patterns. Estimate stands.

**Rebutted draft self-criticisms:** "render op payload untranslated" — correct and consistent with shipped `skipped.reason` (already English in the data); not a violation. "no per-file byte deltas" — correct, op strings carry dims/mime not bytes (verified: e.g. line 590 emits `…×… mime`, no bytes); synthesizing would break no-faked-numbers. Both stand as honest v1 limitations.

---

# REVISED MINI-DESIGN

**Improvement:** Surface the already-computed `receipt.operations[]` and `receipt.skipped[]` as a grouped, collapsible audit trail inside `Receipt`. Pure presentation — zero worker/contract/network change, no generated or faked numbers.

## 1. Scope (v1)

IN:
1. Collapsible "Changes" `<details>` in `Receipt` listing every `operations[]` entry, grouped by op verb, each group an i18n header + count.
2. Op string rendered verbatim in IBM Plex Mono (carries filenames/dims/mime).
3. Reference-changing verbs (`merge`, `dedup`, `pack`, `tier`) rendered `text-warn`; non-reference-changing (`repack`, `resize`, `transcode`, `drop`) `text-ink`.
4. Promote `skipped` from bare count to first-class collapsible list: `assetRef` (mono) + honest `reason`.
5. Both lists collapsed by default; count in the toggle label; headline disk/VRAM rows + film-viewer hero unchanged (instant-wow preserved).

OUT (v1):
- No worker change, no new op data, no structured op type. Verbs parsed from the existing free-text strings.
- No translation of op payload (filenames/dims/mime) — only group headers + chrome get keys. Same honesty posture as today's already-English `skipped.reason`. Documented limitation.
- No per-row byte delta — op strings carry dims/format (e.g. `…×… webp`) but **not** per-file bytes; synthesizing them would violate no-faked-numbers. "before/after where available" resolves to the dimension/format transition already in the string.

## 2. Contract / type additions

**None.** `FixReceipt` (fix-protocol.ts:89-90) already carries both arrays. No change to `core`, `fix-protocol.ts`, or `fix.worker.ts`. A future structured `operations?: FixOp[]` with real byte deltas is the only path to per-row bytes — explicitly out of scope (would require worker changes; this item is scoped to presenting the existing trail).

## 3. Pure module + signatures

New pure, framework-agnostic, unit-testable helper, web-app-local (it parses a web-worker string format → does not belong in a shared package).

**File:** `apps/web/src/lib/op-manifest.ts`

```ts
/** Op verbs — the closed set emitted by the 11 operations.push sites (8 distinct verbs) in fix.worker.ts. */
export type OpKind = 'repack' | 'merge' | 'resize' | 'transcode' | 'drop' | 'pack' | 'dedup' | 'tier';

/** Verbs whose op rewrites/changes asset references (NOT a drop-in) → rendered warn. */
export const REFERENCE_CHANGING: ReadonlySet<OpKind> = new Set(['merge', 'dedup', 'pack', 'tier']);

/** Deterministic group display order: drop-in ops first, reference-changing next, tier last. */
export const OP_KIND_ORDER: readonly OpKind[] = ['repack','resize','transcode','drop','merge','pack','dedup','tier'];

export interface OpRow { kind: OpKind | null; text: string }
export interface OpGroup { kind: OpKind | null; refChanging: boolean; rows: OpRow[] }

/** Classify one operations[] string by its leading whitespace-delimited token.
 *  Unknown/empty leading token → null (caller buckets under a neutral "other" group — never
 *  mislabeled, never silently dropped). Pure. No multi-word special case needed: 'drop duplicate …'
 *  leads with 'drop' and classifies correctly. */
export function classifyOp(op: string): OpKind | null;

/** Group operations[] into ordered, verb-bucketed groups. Groups emitted in OP_KIND_ORDER;
 *  null-verb rows collected into a single trailing group (kind:null). Within-group order = input
 *  order. Pure: same input ⇒ deep-equal output. */
export function groupOps(operations: readonly string[]): OpGroup[];
```

Verb→site map (verified, 11 sites / 8 verbs):
- `repack` ← 494 (spine), 590 (`[ (polygon)]`)
- `merge` ← 607
- `resize` ← 661 (`resize atlas …`), 682 (`resize …`)
- `transcode` ← 709
- `drop` ← 723 (`drop duplicate …`)
- `pack` ← 916
- `dedup` ← 982, 1009 (identical format)
- `tier` ← 1155

`classifyOp` = first token, looked up against the 8-verb set; miss → `null`. No `drop duplicate` special case (first token already `drop`). Determinism: `groupOps` pure over its input; worker builds `operations[]` deterministically (single-threaded ordered pushes); group order fixed by `OP_KIND_ORDER`, within-group = input order; `null` group trailing. Same input ⇒ same output every render.

## 4. UI changes

**File:** `apps/web/src/App.tsx` — `Receipt` only (853-949). No state machine, no worker wiring. Native `<details>/<summary>` (precedent: 4 existing usages in App.tsx; zero new deps, no React state).

1. **Changes manifest** — inserted after the headline disk/VRAM `ReceiptRow` block (line 864), before the per-feature notes, so the at-a-glance summary stays first:
   - Render only when `receipt.operations.length > 0`.
   - `<details>` collapsed; `<summary>` = `t('fix.changes.title', { n: receipt.operations.length })`.
   - Body: for each `OpGroup` from `groupOps(receipt.operations)`: header `t('fix.op.<kind>')` (or `fix.op.other` when `kind === null`) + group count, then each `OpRow.text` on its own line, `font-mono text-[10px]`, `break-all min-w-0` (long dir-aware paths wrap, don't overflow).
   - Row color: `group.refChanging ? 'text-warn' : 'text-ink'` — reinforces the existing `⚠ fix.mergeWarn` (872) / `fix.packWarn` (877) / `fix.tierWarn` (908) warn banners at the per-row level.

2. **Skipped list** — replace bare count at line 943:
   - From `{receipt.skipped.length} {t('fix.skipped')}` → `<details>` collapsed, `<summary>` = `t('fix.skipped.title', { n: receipt.skipped.length })`, body lists each `{assetRef, reason}` as `<assetRef mono> — <reason>` in `text-ink-soft` (skips are informational, not warnings). Guarded by `skipped.length > 0` (existing guard).

Small local presentational subcomponent mirroring `ReceiptRow`:

```ts
function OpManifest({ operations }: { operations: string[] }) // renders the grouped <details>
```

Only new import: the `op-manifest` helper; `useI18n` already in scope (854).

## 5. i18n keys

Add to **all 9** catalogs (`en/ru/de/es/pt/fr/it/zh/hi`). `catalogs.test.ts` enforces (a) identical key set vs en (line 20), (b) plural keys are objects with `.other` (lines 24-25), (c) identical placeholder tokens (line 27). en is source of truth; fallback chain is locale→en→key (index.ts:109/115).

```jsonc
// 2 PLURAL keys — MUST be objects with one/other in ALL 9 locales (else catalogs.test fails):
"fix.changes.title": { "$count": "n", "one": "{n} change", "other": "{n} changes" },
"fix.skipped.title": { "$count": "n", "one": "{n} skipped", "other": "{n} skipped" },
// 8 plain-string verb headers + 1 "other" (token-free → trivially pass placeholder parity):
"fix.op.repack":    "Repacked atlases",
"fix.op.merge":     "Merged atlases (references changed)",
"fix.op.pack":      "Packed loose images (references changed)",
"fix.op.dedup":     "De-duplicated (references repointed)",
"fix.op.resize":    "Resized",
"fix.op.transcode": "Transcoded",
"fix.op.drop":      "Dropped duplicates",
"fix.op.tier":      "Resolution tiers (references changed)",
"fix.op.other":     "Other changes"
```

Notes: plural shape matches existing `fix.meshedCount`. Only the 2 `*.title` keys carry `{n}`; the 9 `fix.op.*` keys are token-free. ru is fully translated; en/pt/it partially — follow the existing per-file pattern (catalogs test does NOT require human translation, only key+placeholder+plural-object parity). **Flat namespace** confirmed: `fix.skipped` (existing), `fix.skipped.whyNoKernel` (existing), and new `fix.skipped.title` are independent flat keys — no collision.

## 6. Honesty & invariant compliance

- **Inv 1 (browser-only/no network):** zero new I/O; pure render of in-memory data. ✓
- **Inv 2 (thin backend):** untouched. ✓
- **Inv 3 (objectivity):** this is the Phase-2 **fix** receipt, not diagnosis; and it **generates nothing** — displays the existing audit trail. ✓
- **Inv 5 (disk ≠ VRAM):** manifest shows **transitions only** (dims/format/counts) — introduces **no** byte/VRAM number; cannot misattribute disk as VRAM. The honest separate-field VRAM notes (packVramDelta/tierVram/dedupVramBytesSavedUpperBound, 897-941) unchanged. ✓
- **No faked numbers:** op strings rendered verbatim; the only derived value is a **count** of strings already present (`operations.length`, group sizes) — not a savings claim. ✓
- **Trust win:** skip reasons (`mesh skipped: source sprite is rotated`, `dedup skipped: loose duplicate reference may live in game code — kept duplicate`, `transcode … unavailable`) promoted from a buried count to a first-class list — answers "what did it do to my art / what did it refuse to touch?".
- **Reference-changing distinction:** `merge/dedup/pack/tier` rows `warn`, consistent with the existing aggregate `⚠` banners — "not a drop-in" reinforced per-row.

## 7. Edge cases

1. `operations` empty → manifest not rendered (guard `length > 0`); headline rows still show (maybe −0%).
2. `skipped` empty → skipped `<details>` not rendered (existing guard).
3. Unknown future verb → `classifyOp` → `null` → trailing "other" group, neutral color. Never dropped, never crashes.
4. Long op string / dir-aware path → `break-all min-w-0` wraps, no panel overflow.
5. Hundreds of ops → collapsed-by-default keeps receipt compact; no virtualization in v1 (op count bounded by file count); summary count sets expectation.
6. Many near-identical rows (e.g. lots of `transcode … → webp`) → listed individually; **that is** the per-file trail; verb grouping keeps it scannable.
7. `drop duplicate` → first token `drop` → `drop` (no special case).
8. Missing locale key → `translate` falls back to en, then key (index.ts:115) — graceful; but catalogs.test fails first, forcing all 9 populated (intended gate).

## 8. Test plan

**Unit — new `apps/web/src/lib/op-manifest.test.ts`** (high-value pure logic):
- `classifyOp`: one assertion per real worker string sampled from each of the 8 verbs (incl. both formats of `repack` and `resize`, both `dedup` sites, `drop duplicate`); `frobnicate x` → `null`; `''` → `null`.
- `groupOps`: groups emitted in `OP_KIND_ORDER`; `null`-verb bucketed in trailing group; within-group order = input order; `refChanging` true exactly for `merge/dedup/pack/tier`; pure (same input twice ⇒ deep-equal); empty input ⇒ `[]`.

**i18n — existing `packages/i18n/test/catalogs.test.ts`** runs automatically: fails until all 9 catalogs carry the new keys with matching placeholders AND the 2 plural keys are objects with `.other`. Add a brace-free smoke assertion mirroring line 32: for every locale, `translate(loc,'fix.changes.title',{n:2})` and `translate(loc,'fix.op.merge')` contain no `{`.

**Manual smoke** (no Playwright in v1, e2e later per CLAUDE.md): real fix on a mixed fixture (merge + drop + transcode + ≥1 skip), expand both `<details>`, confirm counts, warn color on merge/dedup/pack/tier, neutral on drop/resize/transcode, skip reasons shown, mono filenames. `pnpm dev`.

**Regression:** `pnpm typecheck` + `pnpm test` (existing suite green; adds files + one Receipt-internal render path; touches no tested module).

## 9. Ordered task breakdown

| id | title | files | tag | deps | acceptance |
|----|-------|-------|-----|------|------------|
| T1 | Pure op-manifest parser/grouper | `apps/web/src/lib/op-manifest.ts` (new) | web/pure | — | Exports `OpKind`, `REFERENCE_CHANGING`, `OP_KIND_ORDER`, `classifyOp`, `groupOps`, `OpRow`, `OpGroup`; first-token classify (no `drop duplicate` special case); no imports beyond TS types; pure. |
| T2 | Unit tests for the parser | `apps/web/src/lib/op-manifest.test.ts` (new) | web/test | T1 | All 8 verbs from real worker strings (both repack/resize formats, both dedup sites, `drop duplicate`), unknown→`null`→trailing "other", `OP_KIND_ORDER`, within-group order, `refChanging` set, purity, empty input. `pnpm test` green. |
| T3 | Add 11 receipt keys to all 9 locales | `packages/i18n/src/catalogs/{en,ru,de,es,pt,fr,it,zh,hi}.json` | i18n | — | `fix.changes.title`+`fix.skipped.title` as **plural objects** `{$count,one,other}`; `fix.op.{repack,merge,pack,dedup,resize,transcode,drop,tier,other}` as strings; all 9 locales; `catalogs.test.ts` green (key+placeholder+plural-object parity); en source, ru translated. |
| T4 | Brace-free assertion for new keys | `packages/i18n/test/catalogs.test.ts` | i18n/test | T3 | Loop asserts `translate(loc,'fix.changes.title',{n:2})` and a `fix.op.*` key render brace-free for every locale. |
| T5 | `OpManifest` subcomponent + render in Receipt | `apps/web/src/App.tsx` (Receipt) | web/ui | T1, T3 | Collapsed `<details>` "Changes ({n})" after headline rows (after line 864); groups via `groupOps`, header `t('fix.op.<kind>')`+count (`fix.op.other` for null), rows mono `break-all min-w-0`, refChanging→`text-warn` else `text-ink`; renders only when `operations.length>0`. |
| T6 | Promote skipped count → first-class list | `apps/web/src/App.tsx` (line 943) | web/ui | T3 | Replace bare count with collapsed `<details>` "Skipped ({n})"; each row `assetRef` (mono) + reason in `text-ink-soft`; guarded by `skipped.length>0`. (`fix.skipped` flat key now unused — leave for parity; cleanup is a separate follow-up.) |
| T7 | Typecheck + full test + manual smoke | repo | verify | T1–T6 | `pnpm typecheck` + `pnpm test` green (no regressions); manual fix run shows correct grouping, colors, mono, skip reasons, both sections collapsed by default. |

**Key file paths:**
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix-protocol.ts` — `FixReceipt` (89-90; unchanged; source of `operations`/`skipped`).
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix.worker.ts` — 11 `operations.push` (494,590,607,661,682,709,723,916,982,1009,1155) + 39 `skipped.push` (read-only; defines the string formats T1 parses).
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx` — `Receipt` (853-949), `ReceiptRow` (951); only UI edit target; line 943 = skipped count; line 864 = headline-row insertion point.
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/i18n.tsx` — `useI18n`/`t = makeT(locale)`.
- `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/index.ts` — `translate` (113), plural via `$count` (117), fallback locale→en→key (109/115).
- `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/*.json` (flat key map) + `/home/nonamezzz/Рабочий стол/projects/packages/i18n/test/catalogs.test.ts` — 9-locale parity gate.
- New: `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/op-manifest.ts` (+ `.test.ts`).

**Effort:** S — one ~60-LOC pure helper + test, one Receipt edit, 11 keys × 9 locales (2 plural objects + 9 strings each). **Risk:** near-zero — additive, no contract/worker/network change, data already ships, `<details>`/tokens/wrapping all have precedent. Only failure modes: a missed locale key or a plural key shipped as a bare string (both caught by `catalogs.test.ts`), or a misclassified verb (caught by T2).

**Corrections from review folded in:** push-site count 12→11 (8 verbs); `drop duplicate` special case removed (first-token suffices); plural keys flagged as mandatory objects in all 9 locales; flat-namespace collision concern resolved (no collision, real reason stated); `OP_KIND_ORDER` rationale documented; `OpRow.kind`/`OpGroup.kind` typed `OpKind | null` to match the honest "other" bucket; insertion point pinned to line 864; `fix.skipped` dead-key noted as follow-up.