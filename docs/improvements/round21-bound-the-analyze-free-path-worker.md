All claims verified. Key confirmations:

- `App.tsx:101` builds `map` from `f.bytes` eagerly — this is the survivor copy. `App.tsx:127` probe accessor `(ref) => map.get(ref)` is **sync** (returns `ArrayBuffer | undefined`), and `probe-run.ts:61` `bytesOf: (assetRef) => ArrayBuffer | undefined` is **sync** — so move (a) requires widening this signature to async (a real, not trivial, edit). 
- `fix-client.ts:85,132` both map `f.bytes` directly — confirms the double-post-of-detached-buffer hazard the draft flagged.
- `perceptual.ts:144` `FRAME_HASH_MAX_PX = 4096*4096*1.5` duplicates the worker's `ALPHA_SCAN_MAX_PX` (line 163) exactly — the drift the draft proposes to unify is real.
- `extractFrameRegions` (perceptual.ts:223-224) returns `null` for BOTH the sprite-count cap AND px cap — confirms the draft's "two distinct reasons" requirement.

One important new finding the draft missed: `App.tsx:101` builds the survivor `map` from `f.bytes` **at the start of `run()`, BEFORE `runAnalysis` is awaited (line 108)**. If `runAnalysis` transfers `f.bytes`, the `map.set(keyOf(f), f.bytes)` at line 101 has **already captured the (soon-to-be-detached) ArrayBuffer references** — so `map` would hold detached buffers after transfer, not usable bytes. This is a sequencing hazard the draft's "replace fileMap with sourceReaders" does address in principle, but the draft does not call out that the eager `map` build at line 101 must be removed (not just `selectedBytes`/probe rewired). I'll incorporate this.

Now the revised mini-design.

---

# Mini-Design (REVISED): Bound the analyze (FREE-path) worker's resident source bytes

Branch `feat/asset-pipeline`. Targets: `apps/web/src/worker/analyze.worker.ts`, `apps/web/src/lib/worker-client.ts`, `apps/web/src/App.tsx`, `apps/web/src/lib/probe-run.ts`, `apps/web/src/lib/fix-client.ts` (caller), reusing `apps/web/src/lib/bitmap-budget.ts`'s **policy convention** + `apps/web/src/lib/perceptual.ts` (cap unification).

## Premise verification — VERIFIED TRUE against source

Every load-bearing claim checked against the real files:

- **The 2× source copy is real and lives for the whole run.** `analyze.worker.ts:44` `imageBytes` is populated (67, 87) with the worker's own structured-clone copies (`worker-client.ts:51-54` posts **with no transfer list**) and never cleared. Meanwhile the main thread's survivor `map` is built eagerly at `App.tsx:100-101`. 300 MB folder → ~600 MB resident. **TRUE.**
- **The oversize skips are SILENT today.** `decodeFeatures` line 193 (`bmp.width*bmp.height <= ALPHA_SCAN_MAX_PX`) emits no `opaque` and **no `unparsed` entry**; `hashAtlasFrames` returns `null` (251/262) and the caller `continue`s (worker 131-134) — **no `unparsed` entry**. So move (b) makes existing silent skips visible; it is **not** a new omission. **TRUE.**
- **The two caps are byte-identical duplicates.** `analyze.worker.ts:163 ALPHA_SCAN_MAX_PX = 4096*4096*1.5` === `perceptual.ts:144 FRAME_HASH_MAX_PX = 4096*4096*1.5`. Unifying is real, drift-guard-able. **TRUE.**
- **`extractFrameRegions` returns `null` for TWO reasons** (sprite-count `>FRAME_HASH_MAX_SPRITES` AND px `>FRAME_HASH_MAX_PX`, perceptual.ts:223-224) — so the worker cannot distinguish them from the `null` alone. The draft's "check `pageExceedsScanBudget` BEFORE calling, push px reason; else if `null`, push sprite reason" is the correct disambiguation. **TRUE.**
- **Decoded `ImageBitmap`s are already `close()`d eagerly** (`decodeFeatures:201`, `hashAtlasFrames:243`, encoders `278/308`). The analyze worker has **no many-bitmaps-live problem** — so a `BitmapBudget` LRU **instance** here would be dead code. The honest reuse is the **px-cap policy constant + predicate**, not the LRU class. **TRUE — draft's central correction stands.**
- **The probe accessor is SYNC.** `probe-run.ts:61 bytesOf: (assetRef: string) => ArrayBuffer | undefined`; `App.tsx:127` passes `(ref) => map.get(ref)`. Move (a) forces this to async. **TRUE — and this is a non-trivial signature change, not a one-liner.**
- **`fix-client.ts:85,132` both post `f.bytes`** → double-post-of-detached hazard real. **TRUE.**

**NEW finding the draft missed (BLOCKER-class sequencing):** `App.tsx:100-101` builds the survivor `map` from `f.bytes` **before** `await runAnalysis` (line 108). If `runAnalysis` transfers, the references captured at line 101 are the **same ArrayBuffers** that get detached by the transfer — so `map` would hold detached buffers, and even a synchronous re-read attempt would fail. Therefore move (a) **must delete the eager `map` build at lines 100-101 entirely** and replace it with the lazy `sourceReaders(picked)` map; it is not enough to only rewire `selectedBytes` (204) and the probe (127). The revised task 5 makes this explicit.

**Conclusion: premise TRUE.** Both moves are additive; the draft is sound. I fix the one sequencing gap and tighten two task boundaries.

---

## V1 scope

**In:**

1. **(a) Kill the 2× copy via transfer + lazy re-read.** `runAnalysis` transfers the file `ArrayBuffer`s into the worker (transfer list), **only when every `PickedFile` carries a re-readable `file`** (else fall back to today's clone). Worker's `imageBytes` becomes the sole source copy. Main thread **re-reads on demand** from `PickedFile.file` (FilmViewer selection, probe, fix). New `source-bytes.ts` accessor; `PickedFile` gains `file?: File`.
2. **(b) Make existing silent oversize-skips honest, unify the cap.** Add `ANALYZE_PAGE_MAX_PX` + `pageExceedsScanBudget(w,h)` + `scanSkipReason(w,h)` to `bitmap-budget.ts` (pure, Node-testable). `decodeFeatures` and `hashAtlasFrames` use it; on skip the **caller** pushes a `{ref, reason}` into `unparsed[]`. `perceptual.ts:FRAME_HASH_MAX_PX` re-exports the new constant; the worker's `ALPHA_SCAN_MAX_PX` is deleted.

**Out (with justification):**

- **No `BitmapBudget` LRU instance in the analyze worker** — decoded bitmaps are already `close()`d eagerly (verified 201/243/278/308); an LRU would never fire. The honest reuse is the **policy convention** (constant + predicate), matching `ktx2-probe-collect.ts`'s "policy lives in a Node-pure module" pattern.
- No analysis number/threshold/finding change (Inv 3/5). `unparsed[]` already exists (`core/index.ts:623`) and is passed through verbatim.
- No FS Access `FileSystemFileHandle` persistence/re-permission UX — `File.arrayBuffer()` re-read covers all 3 ingest paths (verified: `readFsDir:43-44` holds `file`, `filesFromInput:55` holds `file`, `readEntry:79` holds `file`).
- No new i18n catalog key — `unparsed` reasons are already free-form English diagnostics (e.g. ingest skip reasons, worker parse errors). CLI stays EN.
- No streaming/chunked ingest.

---

## Additive contract / type changes

### `import.ts` — `PickedFile` (line 7)
```ts
export interface PickedFile {
  path: string;
  name: string;
  bytes: ArrayBuffer;
  /** ADDITIVE. Re-readable source (FS Access getFile() / <input> File / drag fileEntry.file() — all 3 paths
   *  already hold a File). Lets the main thread re-read bytes AFTER runAnalysis TRANSFERS (detaches) `bytes`,
   *  instead of holding a 2nd resident copy. Absent ⇒ runAnalysis CLONES (today's behavior); no re-read path. */
  file?: File;
}
```
All 3 constructors (`readFsDir:44`, `filesFromInput:58`, `readEntry:81`) add `file` to the pushed object. Zero behavior change until a consumer transfers.

### `protocol.ts` — no type change (`InputFile.bytes: ArrayBuffer` is transfer-eligible). Add a one-line comment that bytes MAY arrive transferred.

### `core/index.ts` — `unparsed` UNCHANGED (`{ref, reason}[]`, line 623). Honesty surface reused verbatim.

---

## Pure modules + signatures

### `bitmap-budget.ts` (ADD — policy convention, not an LRU instance)
```ts
/** Per-page px cap for the analyze worker's FULL-RESOLUTION getImageData passes (decodeFeatures' alpha scan +
 *  hashAtlasFrames' page buffer, each w·h·4 RGBA resident transiently). ONE source of truth replacing the two
 *  duplicated 4096·4096·1.5 constants (worker ALPHA_SCAN_MAX_PX + perceptual FRAME_HASH_MAX_PX). ≈25.2 MP.
 *  Above it the worker SKIPS honestly (surfaced in unparsed[]). Inv 5: a WORKING-SET bound on a transient
 *  decode buffer, NEVER a VRAM/saving number. */
export const ANALYZE_PAGE_MAX_PX = 4096 * 4096 * 1.5;

/** TRUE when w·h·4 would exceed the budget (skip honestly). Pure; w<=0||h<=0 ⇒ true (degenerate, nothing to
 *  scan). Uses `>` so EXACTLY-at-cap is scanned — matches the old `<= ALPHA_SCAN_MAX_PX` semantics. */
export const pageExceedsScanBudget = (w: number, h: number): boolean =>
  w <= 0 || h <= 0 || w * h > ANALYZE_PAGE_MAX_PX;

/** Deterministic English skip reason for unparsed[] (matches existing free-form reasons). MP toFixed(1). */
export const scanSkipReason = (w: number, h: number): string =>
  `skipped for size: ${w}×${h} (${(w * h / 1e6).toFixed(1)} MP) exceeds ${(ANALYZE_PAGE_MAX_PX / 1e6).toFixed(1)} MP scan budget`;
```
`perceptual.ts:144` becomes `export { ANALYZE_PAGE_MAX_PX as FRAME_HASH_MAX_PX } from './bitmap-budget';` (or imports + re-exports) so the cap is single-sourced. `FRAME_HASH_MAX_SPRITES` stays (different axis).

### `source-bytes.ts` (NEW)
```ts
import type { PickedFile } from './import';

/** Re-read a picked file's bytes from its retained File (the eager `bytes` was TRANSFERRED into the analyze
 *  worker). null when unreadable (folder moved/deleted, or legacy PickedFile with no `file`) — callers surface
 *  "re-import to inspect" honestly, never a fabricated render. Byte-identical to the original (same file). */
export async function readSourceBytes(f: PickedFile): Promise<ArrayBuffer | null>;

/** key→lazy-reader map for FilmViewer selection + probe. Keys === keyOf(f) (the worker/probe's dir-aware key).
 *  Lazy: nothing read until a reader is invoked. */
export function sourceReaders(files: PickedFile[]): Map<string, () => Promise<ArrayBuffer | null>>;
```
Mockable in Node via a `Blob`-shim `file` with `.arrayBuffer()`.

---

## Worker / UI changes

### `worker-client.ts` (move a)
```ts
const payload = files.map((f) => ({ path: f.path, name: f.name, bytes: f.bytes }));
const canTransfer = files.every((f) => f.file !== undefined); // only transfer if main thread can re-read
worker.postMessage(
  { type: 'analyze', files: payload },
  canTransfer ? payload.map((f) => f.bytes) : [],
);
```
Update the banner (line 12-13): "Bytes are TRANSFERRED when every PickedFile has a re-readable `file` (caller re-reads via source-bytes.ts for FilmViewer/probe/fix — one resident copy, in the worker); otherwise CLONED (legacy). No network."

### `App.tsx` (move a) — **DELETE the eager map build, go lazy**
- `run()` lines **100-101**: **remove** `const map = new Map(); for (const f of picked) map.set(keyOf(f), f.bytes);` (these capture soon-to-be-detached buffers — the sequencing BLOCKER). Replace with `const readers = sourceReaders(picked);` stored in state (`setReaders`, replacing `setFileMap`).
- Line **127** probe call: `attachProbeReadings(rep, async (ref) => (await readers.get(ref)?.()) ?? undefined, ctrl.signal)` — requires the probe accessor widened to async (below).
- Line **204** `selectedBytes`: becomes async — a small effect resolves `readers.get(debouncedSelected)?.()` into a `selectedBytes: ArrayBuffer | null` state. `null` → FilmViewer "source unavailable, re-import to inspect" honest branch (line 304-305 guard).
- Line **311** `<FixCard files={files} />`: `files` still passed; FixCard re-sources at fix time (below).

### `probe-run.ts` (move a) — widen accessor to async
Line 61: `bytesOf: (assetRef: string) => ArrayBuffer | undefined` → `bytesOf: (assetRef: string) => Promise<ArrayBuffer | undefined> | ArrayBuffer | undefined`, and `await` it at the call site (line ~75 `bytesOf(ref)` → `await bytesOf(ref)`). Probe is already async + sequential + non-blocking (verified comment lines 70-71), so this is natural and off the ≤10s path.

### `fix-client.ts` + `FixCard` (move a) — re-source before posting
`fix-client.ts:85,132` post `f.bytes` — after transfer those are detached. **`FixCard` re-reads fresh `PickedFile[]` via `readSourceBytes` before calling `runFix`/`planFix`** (user-initiated, off the ≤10s path). If any re-read returns `null` (folder gone), surface an honest "re-import to fix" error, don't post detached buffers.

### Analyze worker (move b)
- Import `pageExceedsScanBudget`, `scanSkipReason`.
- `decodeFeatures`: line 193 `bmp.width*bmp.height <= ALPHA_SCAN_MAX_PX` → `!pageExceedsScanBudget(bmp.width, bmp.height)`. Return an extra `scanSkipped: boolean` (true iff `scanAlpha && pageExceedsScanBudget(w,h)`) **plus `w,h`** (bmp is closed before return). The feature loop (98-112) does `if (scanSkipped) unparsed.push({ref: assetRef, reason: scanSkipReason(w,h)})`.
- `hashAtlasFrames` caller (worker 125-135): **before** calling `hashAtlasFrames`, the worker doesn't know w/h (they come from the decode). Cleanest: have `hashAtlasFrames` itself return a discriminated skip — `{kind:'sizeskip', w, h}` vs `{kind:'spriteskip', n}` vs the normal `{hashes, bboxes}` vs `null` (decode/ctx failure). The caller pushes `scanSkipReason(w,h)` for sizeskip and `"skipped for size: ${n} sprites exceeds ${FRAME_HASH_MAX_SPRITES} cap"` for spriteskip. (Internally `hashAtlasFrames` checks `pageExceedsScanBudget(width,height)` right after decode at line 231, and checks `sprites.length > FRAME_HASH_MAX_SPRITES` before the `extractFrameRegions` call, so the two `null`-return causes from `extractFrameRegions` are disambiguated at the worker level.)
- Delete `ALPHA_SCAN_MAX_PX` (line 163).

**`unparsed` ordering note:** the worker sorts `unparsed` at line 93 — **BEFORE** the feature loop (98) and frame-hash loop (125) where the new size-skip entries are pushed. So **the new entries are pushed AFTER the sort and would be unsorted.** Fix: move the `unparsed.sort(...)` to **after** the frame-hash loop (just before `analyze()` at line 137), OR re-sort there. The revised task 2 includes this — without it, determinism of `unparsed` order regresses. (This is a real correctness detail the draft's determinism section claimed "already sorted at line 93" — but line 93 runs before the new pushes, so a re-sort is mandatory.)

### Backend — none. Inv 1/2 untouched.

---

## Honesty + invariants
- **Inv 1:** transfer is intra-process; re-read is local disk. Zero network.
- **Inv 2:** untouched.
- **Inv 3:** re-read bytes identical to original → no number drift; oversize skip emits honest `unparsed`, never a fabricated finding.
- **Inv 4:** transfer is faster than clone (helps ≤10s); re-reads are lazy (selected asset / probed atlas / fix time), off the critical path; big-folder OOM headroom improves.
- **Inv 5:** `ANALYZE_PAGE_MAX_PX` is a documented working-set bound, never folded into VRAM/saving.

## Determinism
- Transfer vs clone is observationally identical to the worker.
- `pageExceedsScanBudget`/`scanSkipReason` are pure (no Date/random/iteration-order).
- `unparsed` **re-sorted after all pushes** (corrected — see note above) → stable order.
- Re-read of an unchanged file → identical bytes → identical decode/overlay/fix.

## Edge cases
1. Folder moved/deleted before a later FilmViewer click → `readSourceBytes` null → honest "source unavailable" state (test).
2. Legacy `PickedFile` (no `file`) → `runAnalysis` falls back to clone (no transfer); old callers unaffected (test the fallback).
3. Double-post of a transferred buffer (fix path) → FixCard re-reads fresh buffers first; null → honest "re-import to fix" (test the fix path receives non-detached buffers).
4. Page exactly at cap → `>` ⇒ scanned (matches old `<=`) (boundary test).
5. Degenerate `w<=0||h<=0` → predicate true (skip); matches existing guards (193, 232).
6. No `OffscreenCanvas` → no decode, predicate unreached, no size-skip entry (unchanged).
7. Tiny folder → transfer instant, all under cap → byte-identical report + identical lazy FilmViewer.
8. Sprite-count cap vs px cap → two distinct `unparsed` reasons (don't conflate).

## Test plan (real path, defect-reproducing)
**Pure/Node — extend `bitmap-budget.test.ts`:** `pageExceedsScanBudget` false at 4096², true at 8192², boundary false at exactly cap / true at +1px / true for 0×N; `scanSkipReason` deterministic + stable `toFixed(1)`; drift-guard `perceptual.FRAME_HASH_MAX_PX === ANALYZE_PAGE_MAX_PX`.
**Pure/Node — new `source-bytes.test.ts`:** `readSourceBytes` returns exact bytes with a Blob-shim `file`; `null` when `file` undefined; `null` (no throw) when `arrayBuffer()` rejects; `sourceReaders` keys === `keyOf(f)` and readers are lazy (assert shim `arrayBuffer` call count 0 until invoked).
**Through the REAL analyze decision — oversize fixture (`make-fixture`):** an atlas declaring an `8192×8192` page over a real >25.2 MP image with a known sprite. Exercise the **caller-side push decision** the worker makes (the `if (scanSkipped)` / discriminated-skip branch). Assert: the oversize page yields exactly one `unparsed` entry starting `"skipped for size:"`; a sibling page UNDER the cap yields NO `unparsed` entry and its frame-hash/opaque features ARE present (proves the skip is selective, not blanket — the anti-"never fires" check); and the under-cap report's other findings are byte-identical to a control without the oversize page (no number drift).
**Integration (`apps/web/test`):** `runAnalysis` posts a non-empty transfer list when all files have `file`, empty (clone) when one lacks it (postMessage spy capturing the transfer arg); after a transfer-mode run, the fix path receives non-detached buffers (edge 3); FilmViewer "source unavailable" branch renders (edge 1) without crashing.
**All existing `analyze`/`perceptual`/film-viewer/fix suites stay green** (report byte-identical under cap; FRAME_HASH cap value unchanged).

---

## Ordered task breakdown (small commits)

1. **`feat(fix): unify analyze scan-cap policy in bitmap-budget.ts`** — add `ANALYZE_PAGE_MAX_PX`, `pageExceedsScanBudget`, `scanSkipReason` (pure); re-export `perceptual.FRAME_HASH_MAX_PX` from the new constant. Extend `bitmap-budget.test.ts` (boundary, degenerate, drift-guard, determinism). *No behavior change.*
2. **`feat(fix): analyze worker surfaces oversize page skips in unparsed[]`** — `decodeFeatures` returns `{scanSkipped, w, h}`; `hashAtlasFrames` returns a discriminated px-cap vs sprite-cap skip; callers push distinct `unparsed` reasons; **move the `unparsed.sort()` to after the frame-hash loop** (determinism fix); delete `ALPHA_SCAN_MAX_PX`. Add the oversize fixture + "fires selectively, no number drift, sorted order" test. Move (b) complete.
3. **`feat(web): PickedFile carries re-readable File; add source-bytes accessor`** — `file?: File` in `import.ts` (all 3 constructors) + `source-bytes.ts` + `source-bytes.test.ts`. *Additive, no consumer wired.*
4. **`feat(web): transfer analyze source bytes into the worker (kill the 2× copy)`** — `worker-client.ts` transfers when all files have `file`, else clones; update banner. Add transfer-list spy + fallback tests. *No main-thread re-read wired yet (worker just gets transferred bytes; main thread still has its eager `map` — still correct because clone-fallback isn't hit and the eager map is removed in step 5; to keep step 4 independently green, KEEP `canTransfer` gated AND keep the eager map until step 5 — so step 4 alone does not transfer in the app yet OR step 4 ships transfer + step 5 immediately removes the eager map. Recommend: ship 4+5 together if CI runs the app, else gate transfer behind the all-have-`file` condition which the eager map tolerates only if the map is built from a re-read; simplest correct sequencing: **merge tasks 4 and 5**).*
5. **`feat(web): App lazy-reads source bytes for FilmViewer + probe (remove eager byte map)`** — **delete `App.tsx:100-101` eager `map` build**; replace with `sourceReaders`; async-resolve `selectedBytes`; widen `probe-run.ts` accessor to async + await; FilmViewer "source unavailable" honest state. Move (a) main-thread half complete. **(Merge with task 4 to keep each commit independently green — see note.)**
6. **`feat(web): FixCard re-reads fresh bytes before the fix worker`** — re-source `PickedFile[]` via `readSourceBytes` at fix time; honest "re-import to fix" on null. Add "fix path receives non-detached buffers" guard test.
7. **`docs: round — analyze worker memory bounds (transfer + honest scan-cap skips)`** — `docs/improvements/analyze-worker-memory-bounds.md` + `docs/CHANGELOG.md` / `docs/FEATURES.md` entries.

**Sequencing correction:** tasks 1-3 are strictly additive (no observable change). **Tasks 4 and 5 must land together** (or 4 must NOT actually transfer in-app until 5 removes the eager `App.tsx:100-101` map) — because transferring while the eager map still captures `f.bytes` at line 101 would leave the main thread holding detached buffers (the sequencing BLOCKER). This is the one change from the draft's task ordering.

---

## Summary of changes from the DRAFT

The draft is **sound and its central correction is correct** (the analyze worker needs the px-cap **policy**, not a `BitmapBudget` LRU instance — verified: all decoded bitmaps are `close()`d eagerly). I confirmed every premise against source. Two additions:

1. **NEW BLOCKER (sequencing):** `App.tsx:100-101` builds the survivor byte `map` from `f.bytes` **before** `await runAnalysis`. Transferring detaches exactly those captured references → the eager map holds detached buffers. The draft's task 5 must **delete** the eager map build (not just rewire `selectedBytes`/probe), and **tasks 4+5 must land together** (or transfer stays off in-app until 5 removes the eager map). The draft's task ordering claimed 4 is independently green while 5 wires re-read — but 4 transferring with the eager map still present is broken.

2. **DETERMINISM fix:** the draft claimed `unparsed` is "already sorted at line 93." It is — but line 93 runs **before** the feature loop (98) and frame-hash loop (125) where the new size-skip entries are pushed, so those entries would be **unsorted**. The `unparsed.sort()` must move to **after** the frame-hash loop (added to task 2).

Everything else in the draft (transfer + lazy re-read via `PickedFile.file`, the clone fallback for legacy callers, `extractFrameRegions`'s dual-cause `null` disambiguation, the oversize fixture firing selectively, all 5 invariants honored) is **verified accurate and retained**.