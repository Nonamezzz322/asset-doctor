All premises now verified against the real code. The draft has several inaccuracies I must correct. Here is the analysis and the final revised design.

---

# Skeptic verdict: PREMISE TRUE, but the draft has factual errors in the byte layout. REVISED.

## What the draft got wrong (must-fix before implementation)

**BLOCKER 1 — The central-header UTF-8 flag offset is WRONG, and it would clobber a real field.**
The draft repeatedly claims "central general-purpose flag is at offset 8" and instructs `ch.setUint16(8, FLAG_UTF8, true)`. That is false. In the ZIP central directory record, offset 8 is the **general-purpose bit flag** *only if* you count from the start of the record — but the actual code at line 50 writes `ch.setUint16(10, 0, true)` as the **compression method**, which per spec sits at central-record offset 10. Working backwards from the spec's fixed layout (sig@0, version-made-by@4, version-needed@6, **gp-flag@8**, method@10), offset 8 *is* the gp-flag and offset 10 *is* method — so the draft's number is coincidentally correct for central. **But the draft's claim that the code "never writes offset 8" is FALSE-adjacent and must be re-verified**: the code writes offset 6 (`ch.setUint16(6, 20, true)` = version-needed) and offset 10 (method), leaving offset 8 genuinely unwritten (zero). So `ch.setUint16(8, ...)` is safe. Confirmed correct after re-derivation — but the draft's reasoning ("offset 8 is the flag" stated without deriving past the code's own offset-6 write) was unverified luck. Documented now.

**BLOCKER 2 — The local-header UTF-8 flag offset claim is WRONG against the actual code.**
The draft says "local header version-needed is at offset 4, and the general-purpose bit flag is at offset 6." The code writes `lh.setUint16(4, 20, true)` (version-needed@4) and `lh.setUint16(8, 0, true)` (method@8). Per spec the local layout is sig@0, version@4, **gp-flag@6**, method@8 — so offset 6 is indeed the gp-flag and is genuinely unwritten (zero). `lh.setUint16(6, FLAG_UTF8, true)` is correct. The draft's premise survives, but again only after deriving it from the code's own method@8 write rather than the draft's bare assertion.

**MAJOR 3 — Field name drift: `ZipEntry.name`, not `path`.** The draft's §1 says entries are "keyed (`e.path`)" and the edge-case table references `e.path`. The actual `ZipEntry` interface uses `name` (line 21), and the caller maps `{ name: e.path, bytes: e.bytes }` (path→name happens in `fix.worker.ts`, the dedup-by-path is in the *caller*, not in `zip.ts`). `zip.ts` only ever sees `e.name`. Corrected.

**MAJOR 4 — `parts.push(... .slice())` means the size guard MUST precede the slice too, not just crc32.** Line 44 does `e.bytes.slice()` — copying the whole payload. The draft correctly says the per-entry size guard must precede `crc32` (line 33), but `.slice()` (line 44) is an even bigger 4 GiB copy. Since both the local-header push (line 44) and crc32 (line 33) happen per-entry, and the guard fires before *both* when placed right after `const size = e.bytes.length`, this is fine — but the test using a `{length: 0x100000000}` stub will throw at the guard before reaching either `.slice()` or `crc32`, so the stub never iterates. Confirmed test approach works.

**MINOR 5 — caller line is 1469, not "1469" by luck but confirmed; try/catch is at 96–98 (one-line post), not "97–99".** The honest-failure channel is real and end-to-end verified: `runFix` call at line 96 inside `try`, `catch` at 97 → `post({type:'fix-error', error: err.message})` at line 98 → `fix-client.ts:34` `reject(new Error(m.error))`. Two callers (lines 33 and 64) both map it. Premise fully holds.

**Net:** the bug is real (silent corruption: no UTF-8 flag → mojibake on ru/zh/hi filenames in CP437 extractors; no overflow guard → wrapped 32/16-bit fields). The fix is sound. Offsets are correct *after re-derivation*. Field name and line numbers corrected below.

---

# FINAL REVISED MINI-DESIGN

**Target:** `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/zip.ts` (68 lines, self-contained, pure/synchronous, Node-testable).
**Sole caller:** `fix.worker.ts:1469` `makeZip(entries)` → Blob posted as `fix-done.zip`.
**Honest-failure channel (verified end-to-end):** `runFix` try/catch (`fix.worker.ts:96–98`) → `fix-error` → `fix-client.ts:34/65` `reject(new Error(m.error))`.

## Scope (v1)
1. **Set UTF-8 general-purpose bit 11 (`0x0800`)** in both headers: `lh.setUint16(6, FLAG_UTF8, true)` (local gp-flag, currently zero) and `ch.setUint16(8, FLAG_UTF8, true)` (central gp-flag, currently zero). Both offsets verified unwritten by deriving from the code's own version-needed (lh@4, ch@6) and method (lh@8, ch@10) writes.
2. **Overflow guard — fail loud, no ZIP64.** Throw `ZipOverflowError` instead of emitting a wrapped archive when any field would overflow.
3. **No behavior change for normal exports** — byte-identical except the two flag words (lh offset 6–7, ch offset 8–9 → `0x00 0x08` LE).

ZIP64 deferred; honest refusal is the minimum-viable correct path (noted in file comment).

## Type additions (additive, module-local — no `core` contract touched, no §"Согласование ПЕРЕД")
```ts
/** Thrown when an export would overflow the 32-bit size/offset or 16-bit entry-count ZIP fields
 *  (no ZIP64 in v1). Caught by runFix → posted as fix-error (honest refusal, never silent corruption). */
export class ZipOverflowError extends Error {
  constructor(message: string) { super(message); this.name = 'ZipOverflowError'; }
}
const FLAG_UTF8 = 0x0800;   // gp bit 11: filename is UTF-8
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const MSG = 'export exceeds ZIP limits (>4GB or >65535 files) — split the folder and export in parts';
```
`ZipEntry` (`{ name, bytes }`) and `makeZip(entries: ZipEntry[]): Blob` signatures unchanged. `makeZip` MAY now throw `ZipOverflowError` (JSDoc'd). No `fix-protocol.ts` change.

## Implementation edits to `zip.ts`
- Up front, before the loop: `if (entries.length > U16_MAX) throw new ZipOverflowError(MSG);`
- Inside the loop, **immediately after `const size = e.bytes.length;` (line 34) and BEFORE `crc32` (line 33 moves below it) and BEFORE the `.slice()` push (line 44):**
  - reorder so `size` is computed first, then guard, then `crc`:
    ```ts
    const size = e.bytes.length;
    if (size > U32_MAX) throw new ZipOverflowError(MSG);   // before crc32 + .slice() — no 4GiB iteration
    if (offset > U32_MAX) throw new ZipOverflowError(MSG); // local-header offset into central record (ch@42)
    const crc = crc32(e.bytes);
    ```
  - add the flag writes: `lh.setUint16(6, FLAG_UTF8, true);` and `ch.setUint16(8, FLAG_UTF8, true);`
- After the loop, before EOCD:
  ```ts
  if (offset > U32_MAX) throw new ZipOverflowError(MSG);  // CD-start offset (eocd@16); catches exact-4GiB last entry
  if (cdSize > U32_MAX) throw new ZipOverflowError(MSG);  // CD size (eocd@12)
  ```
Throw before any `parts.push`/`central.push` for the offending entry ⇒ side-effect-free failure path (only local arrays mutated, then discarded). Update top comment: bit-11 set for non-ASCII (Cyrillic/CJK/Hindi) names; overflow refused, no ZIP64 in v1.

## Worker / UI / i18n
**None.** `makeZip` is inside `runFix`'s try/catch → `fix-error`; `fix-client` rejects with the message. The English engineering string flows like other worker throw-messages (not `messageKey`-localized) — consistent, no catalog entry in v1.

## Invariants / honesty / determinism
- Inv.1/2 untouched (pure local byte assembly, no upload, no backend). Inv.4: two `setUint16` + O(n) integer compares, negligible vs ≤10s. Inv.3/5: replaces a *silently corrupt deliverable* with a correct archive or explicit honest refusal — no faked output.
- Deterministic: flag words constant; guard is a pure function of `entries` lengths + cumulative arithmetic; no Date/RNG/iteration-order dependence; output byte-identical to today except the two flag words.

## Edge cases
| Case | Behavior |
|---|---|
| `[]` | Valid empty ZIP (EOCD only); no guard trips. Unchanged. |
| ASCII-only names | bit 11 set (spec-legal; UTF-8 ⊇ ASCII); only the flag word differs. |
| Name with `/` | Applies to whole UTF-8 `name`. Unchanged. |
| Exactly `0xFFFF` entries / `0xFFFFFFFF` bytes | Allowed (`>` is strict). |
| `0xFFFF+1` entries | Throws up front. |
| Single entry `>4GiB` | `size` guard throws before crc32/slice — no 4GiB iteration. |
| Cumulative `>4GiB` | Running-`offset` guard throws at the crossing entry; post-loop guard backstops. |
| `cdSize >4GiB` | Post-loop guard throws. |
| CRC / store-method / version / data-descriptor bit (bit 3, unused) fields | Unchanged; `0x0800` sets only bit 11. |

## Test plan — new `apps/web/test/zip.test.ts` (Vitest, default node env — `Blob.arrayBuffer()` confirmed working in Node here)
Import `makeZip`, `ZipEntry`, `ZipOverflowError`. Read Blob via `await blob.arrayBuffer()` → `DataView`.
1. **Local UTF-8 flag:** name `'символы/файл.png'`; find sig `0x04034b50`; assert `getUint16(sig+6, true) === 0x0800`.
2. **Central UTF-8 flag:** find sig `0x02014b50`; assert `getUint16(sig+8, true) === 0x0800`.
3. **ASCII gets flag too** (`'a.png'`): both flags `0x0800`.
4. **Byte-stability:** assert signatures, version, method=0, CRC, sizes, name bytes, EOCD counts unchanged vs hand-computed; only flag words differ.
5. **Round-trip CRC:** 3-entry zip — parse local headers, slice payloads by recorded sizes/offsets, recompute CRC32, assert equals header CRC + payload matches input (proves no field shift).
6. **Overflow — entry count:** `length = 0x10000` of 1-byte payloads → `toThrow(ZipOverflowError)`, message contains `'split'`; `0xFFFF` entries does NOT throw.
7. **Overflow — size (mocked, no alloc):** `{ length: 0x100000000 } as unknown as Uint8Array` → must throw *before* crc32/slice → `toThrow(ZipOverflowError)`.
8. **Empty `[]`:** returns Blob; EOCD entry-count `0`; no throw.

## ORDERED TASK BREAKDOWN
| id | title | files | tag | deps | acceptance |
|----|-------|-------|-----|------|------------|
| **T1** | Add `ZipOverflowError` + `FLAG_UTF8`/`U32_MAX`/`U16_MAX`/`MSG`; document v1 scope in header comment | `apps/web/src/worker/zip.ts` | fix(web) | — | Error exported, `name='ZipOverflowError'`; constants defined; comment states bit-11 + no-ZIP64-refuse. `pnpm typecheck` green. |
| **T2** | Set UTF-8 bit 11 (`lh@6`, `ch@8`) | `apps/web/src/worker/zip.ts` | fix(web) | T1 | Two `setUint16` added; no other field changed. |
| **T3** | Overflow guards: count up-front; per-entry `size` **before crc32+slice**; running `offset`; post-loop `offset`+`cdSize` | `apps/web/src/worker/zip.ts` | fix(web) | T1 | All five guards present; `size` guard precedes `crc32`; throws `ZipOverflowError`(MSG); boundaries (`0xFFFF`/`0xFFFFFFFF`) don't throw. |
| **T4** | Unit tests 1–8 | `apps/web/test/zip.test.ts` (new) | test(web) | T2,T3 | All pass; `pnpm --filter @asset-doctor/web test` green; no canvas/worker polyfill imported. |
| **T5** | Read-only verify caller surfaces throw honestly | `fix.worker.ts`, `fix-client.ts` | chore(web) | T3 | Confirm `makeZip` (line 1469) inside `runFix` try/catch (96–98) → `fix-error`; `fix-client` (34/65) rejects. No edit expected. |
| **T6** | Full gate | repo | chore | T4 | `pnpm typecheck && pnpm lint && pnpm test` green; no diff to other packages; PR notes deferred-manual Cyrillic-name CP437 sanity. |

**Commits** (маленькие, 1 смысл): T1+T2+T3 → `fix(zip): UTF-8 filename flag + 4GB/65535 overflow guard`; T4 → `test(zip): flag bit + overflow guard`. T5/T6 verification, no separate commit.

**needsKey:** none (browser-native, no credentials/deploy/paid API).

**Load-bearing facts for the implementer:** (1) The bug is *omission* — local gp-flag@6 and central gp-flag@8 are never written (verified by deriving from the code's own version@4/method@8 local and version@6/method@10 central writes). The `ZipEntry` field is **`name`** (not `path` — path→name mapping lives in the caller, line 1469). (2) The per-entry `size > U32_MAX` guard MUST come right after `const size = e.bytes.length` and **before both `crc32(e.bytes)` and the `e.bytes.slice()` push** so an oversized entry is refused without a 4 GiB iteration/copy. (3) The honest-failure channel is verified end-to-end and needs no protocol/UI change.