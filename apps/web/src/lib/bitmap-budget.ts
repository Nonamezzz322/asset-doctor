// Pure, Node-importable LRU-with-byte-budget for the fix worker's decoded source bitmaps
// (docs/improvements/round19-fix-worker-memory-bounds.md, Round 19 #1). The worker decodes each source
// atlas/loose page to an ImageBitmap (w·h·4 RGBA resident) and — before this — held EVERY decode for the
// whole run with no close()/evict, so a multi-dozen-page fix piled hundreds of MB resident and OOM'd the
// tab on the PAID path. This module bounds the live decoded SOURCE working-set under a documented byte
// budget (Σ w·h·4), closing + evicting the least-recently-used UNPINNED bitmap on an over-budget insert.
//
// Why a separate module: the worker can't run in Node (createImageBitmap / OffscreenCanvas / `self`), so the
// LRU/budget POLICY — the load-bearing correctness — is extracted here over a generic Closeable handle (the
// real ImageBitmap injected by the worker, a fake injected by the test). Same convention as
// ktx2-probe-collect.ts: ONE source of truth the worker imports verbatim so the eviction policy can't drift
// from what the headless Vitest covers.
//
// CORRECTNESS (the worst-failure guard): re-decode on a miss is ALWAYS safe — the worker retains the source
// bytes (bytesByRef) for the whole run, so a wrongly-evicted entry costs ONE re-decode, never a wrong pixel.
// To stop a re-decode STORM inside one multi-source op (a merge composes many pages, each re-reading the same
// N group sources across many awaits; polygon extracts every sprite of every group atlas), the worker pins
// the in-flight op's source refs; a PINNED bitmap is NEVER evicted while it could still be needed this op.
//
// ADDITIVITY (the honesty claim): under the byte budget NOTHING evicts ⇒ the worker decodes the exact same
// set in the exact same order ⇒ emitted bytes are byte-identical to before this change. Eviction only frees
// memory; createImageBitmap of the same bytes is deterministic for our raster inputs, so output never depends
// on WHEN a bitmap was decoded. DETERMINISM: recency = insert/get call order (fixed plan.ops order, fixed
// blit order; no Date.now/Math.random/timers); ties broken by Map insertion order ⇒ identical eviction
// sequence across runs ⇒ identical emitted bytes.
//
// INVARIANTS: Inv 1 — decoded-bitmap LIFETIME only; no network, no new I/O. Inv 5 — the budget is a
// WORKING-SET bound on decoded SOURCE bitmaps held DURING fixing; it is NOT a VRAM saving and is NEVER folded
// into vramBytesAfter/vramSaved. The optional receipt note (decodeWorkingSet) is descriptive only.

// ── Round 21 #2: analyze (FREE-path) worker scan-cap POLICY ──────────────────────────────────────────
// The analyze worker decodes each loose PNG/WebP and each atlas page to an ImageBitmap, then reads it at
// FULL resolution via getImageData (decodeFeatures' alpha scan; hashAtlasFrames' page buffer) — each a
// transient w·h·4 RGBA surface. Unlike the FIX worker, every such bitmap is close()d EAGERLY right after
// the read (verified analyze.worker.ts), so the worker keeps NO many-bitmaps-live working set ⇒ a
// BitmapBudget LRU INSTANCE here would never evict (dead code). The honest, no-fork reuse of this module
// is therefore its POLICY half: ONE source of truth for the per-page px cap that bounds those transient
// full-resolution reads — replacing the two byte-identical 4096·4096·1.5 constants that had drifted apart
// (the worker's inline ALPHA_SCAN_MAX_PX and perceptual's FRAME_HASH_MAX_PX). Same convention as
// ktx2-probe-collect.ts: the load-bearing predicate lives in a Node-pure module the worker imports verbatim
// so a headless Vitest can cover what production runs.
//
// HONESTY (Inv 5): ANALYZE_PAGE_MAX_PX is a WORKING-SET bound on a transient decode buffer — NEVER a VRAM
// or saving number. ADDITIVITY: above the cap the worker SKIPS the optional feature (opaque scan / frame
// hash) honestly and surfaces it in the report's `unparsed[]`; the cap value is unchanged from before, so
// the exact same pages are scanned ⇒ identical findings/report. DETERMINISM: pure integer-ish px math, no
// Date/random/iteration order.

/** Per-page px cap on the analyze worker's FULL-RESOLUTION reads (decodeFeatures' alpha scan + the
 *  hashAtlasFrames page buffer, each a w·h·4 RGBA surface resident transiently). ONE source of truth
 *  replacing the worker's old inline ALPHA_SCAN_MAX_PX and perceptual's FRAME_HASH_MAX_PX (both
 *  4096·4096·1.5 ≈ 25.2 MP — a generous loose-art/page ceiling). Above it the worker skips honestly. */
export const ANALYZE_PAGE_MAX_PX = 4096 * 4096 * 1.5; // ≈ 25.2 MP

/** TRUE when a w×h page exceeds the scan budget (skip the full-resolution read honestly). Pure. A
 *  degenerate w≤0 || h≤0 page ⇒ true (nothing to scan — matches the worker's existing >0 guards). Uses
 *  `>` so a page EXACTLY at the cap is still scanned, byte-identical to the old `<= ALPHA_SCAN_MAX_PX`. */
export const pageExceedsScanBudget = (w: number, h: number): boolean =>
  w <= 0 || h <= 0 || w * h > ANALYZE_PAGE_MAX_PX;

/** Deterministic English reason for an oversize-skip `unparsed[]` entry (free-form, matching the existing
 *  ingest/parse skip reasons; CLI stays EN). `toFixed(1)` ⇒ stable across runs. */
export const scanSkipReason = (w: number, h: number): string =>
  `skipped for size: ${w}×${h} (${((w * h) / 1e6).toFixed(1)} MP) exceeds ${(ANALYZE_PAGE_MAX_PX / 1e6).toFixed(1)} MP scan budget`;

/** Anything with byte-cost dimensions + a close() that frees native memory. ImageBitmap satisfies this
 *  structurally, so the worker passes real bitmaps while the test passes a fake that records close() calls —
 *  keeping the policy Node-pure. */
export interface Closeable {
  readonly width: number;
  readonly height: number;
  close(): void;
}

/** Decoded-source working-set bound (a DOCUMENTED constant, mirrors the SHEET_DIFF_MAX style — NOT a UI/
 *  FixOptions knob). 256 MB ≈ 16 full 2048² RGBA pages resident: generous for a normal fix, far under a tab
 *  OOM. A single page larger than the whole budget is still admitted (one in-flight page is non-negotiable —
 *  correctness over the bound). Bytes per bitmap = width·height·4 (RGBA8888 resident surface). */
export const BITMAP_BUDGET_BYTES = 256 * 1024 * 1024;

/** Resident RGBA bytes of one decoded bitmap (w·h·4). The SAME w·h·4 model the worker uses for VRAM. */
export const bitmapBytes = (b: Closeable): number => b.width * b.height * 4;

/** LRU cache of decoded source bitmaps keyed by ref, bounded by Σ width·height·4.
 *
 *  - `get(ref)`  : hit ⇒ moved to MRU (most-recently-used) and returned; miss ⇒ undefined (caller decodes
 *                  + insert()s). Recency is what the LRU evicts by.
 *  - `insert`    : adds the entry at MRU, then while liveBytes > budget closes() + evicts the LRU UNPINNED
 *                  entry that is NOT the just-inserted ref, repeating until under budget OR only pinned/the
 *                  new entry remain (then over-budget is TOLERATED — correctness over the bound; surfaced via
 *                  peakCount). ADDITIVE: under budget nothing evicts.
 *  - `pin`       : marks refs the IN-FLIGHT op still needs live — NEVER evicted while pinned (prevents a
 *                  re-decode storm within one merge/polygon op). Advisory for eviction only; drain ignores it.
 *  - `unpinAll`  : clears the pin set (called when an op finishes, so its sources become evictable again).
 *  - `drain`     : close() every live handle + clear (incl. pinned — pins are eviction-advisory only). Called
 *                  in the runFix finally AND on cancel/abort so a finished/superseded run frees native memory
 *                  immediately. Idempotent (double-drain / double-close is a benign no-op).
 *
 *  CORRECTNESS: re-decode on a miss is always safe (the caller retains the source bytes) ⇒ a wrongly-evicted
 *  entry costs CPU, never a wrong pixel. The LRU NEVER evicts a pinned ref, so the current op never loses a
 *  source bitmap it still references. */
export class BitmapBudget<T extends Closeable> {
  // Map insertion order IS the LRU order: first key = least-recently-used, last key = most-recently-used.
  // get()/insert() re-insert to move an entry to the MRU end; eviction scans from the LRU (front) end.
  private readonly map = new Map<string, T>();
  private readonly pinned = new Set<string>();
  private readonly budgetBytes: number;
  private bytes = 0;
  private peak = 0;

  constructor(budgetBytes: number = BITMAP_BUDGET_BYTES) {
    this.budgetBytes = budgetBytes;
  }

  /** Hit ⇒ move to MRU + return; miss ⇒ undefined (caller decodes then insert()s). */
  get(ref: string): T | undefined {
    const hit = this.map.get(ref);
    if (hit === undefined) return undefined;
    // Refresh recency: delete + re-set moves the key to the Map's MRU (last-inserted) position.
    this.map.delete(ref);
    this.map.set(ref, hit);
    return hit;
  }

  /** Insert `value` at MRU, then evict the LRU UNPINNED entry until under budget (or only pinned/this remain).
   *  Returns `value` so callers can `return budget.insert(ref, await decode())` in one expression. */
  insert(ref: string, value: T): T {
    // Replace any stale entry for this ref first (close the old surface — never leak it).
    const prev = this.map.get(ref);
    if (prev !== undefined) {
      this.bytes -= bitmapBytes(prev);
      this.map.delete(ref);
      if (prev !== value) prev.close();
    }
    this.map.set(ref, value);
    this.bytes += bitmapBytes(value);
    if (this.map.size > this.peak) this.peak = this.map.size;
    this.evictToBudget(ref);
    return value;
  }

  /** Mark `refs` as needed by the in-flight op — never evicted while pinned (additive to any existing pins). */
  pin(refs: Iterable<string>): void {
    for (const r of refs) this.pinned.add(r);
  }

  /** Release every pin (the op finished — its sources are evictable again). */
  unpinAll(): void {
    this.pinned.clear();
  }

  /** close() every live handle + clear. Idempotent; ignores pins (pins are eviction-advisory only). */
  drain(): void {
    for (const b of this.map.values()) b.close();
    this.map.clear();
    this.pinned.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  /** Σ width·height·4 of the live bitmaps (the working-set the budget bounds). */
  get liveBytes(): number {
    return this.bytes;
  }

  /** High-water mark of `size` over the cache's lifetime (how many decodes were live at once). Feeds the
   *  optional descriptive receipt note; NEVER a VRAM/saving number (invariant 5). */
  get peakCount(): number {
    return this.peak;
  }

  /** Evict from the LRU (front) end while over budget: skip pinned refs AND `keepRef` (the just-inserted
   *  entry — never evict the thing we were asked to admit). Stop when under budget or nothing is evictable. */
  private evictToBudget(keepRef: string): void {
    while (this.bytes > this.budgetBytes) {
      let victim: string | undefined;
      for (const ref of this.map.keys()) {
        // Map iteration is insertion (LRU→MRU) order ⇒ the FIRST eligible key is the least-recently-used.
        if (ref === keepRef) continue;
        if (this.pinned.has(ref)) continue;
        victim = ref;
        break;
      }
      if (victim === undefined) return; // only pinned/keepRef remain — tolerate over-budget (correctness)
      const v = this.map.get(victim)!;
      this.bytes -= bitmapBytes(v);
      this.map.delete(victim);
      v.close();
    }
  }
}
