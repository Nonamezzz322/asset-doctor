// Round 21 #2 — lazy re-read of a picked file's source bytes from its retained File.
//
// WHY: runAnalysis now TRANSFERS each PickedFile.bytes into the analyze worker (the worker becomes the sole
// resident copy, killing the former ~2× copy where the worker cloned every file AND the main thread kept an
// eager byte map). After a transfer the main-thread ArrayBuffer is DETACHED, so the FilmViewer selection,
// the render-probe, and the fix path can no longer read `bytes` — they RE-READ from disk via the retained
// `PickedFile.file` (every ingest path already holds one; see import.ts). The re-read is byte-identical to
// the original (same file on disk) ⇒ identical decode/overlay/fix ⇒ no number drift (Inv 3).
//
// HONESTY: a re-read can fail (folder moved/deleted, or a legacy PickedFile with no `file`) ⇒ null, NEVER a
// throw and NEVER a fabricated render — callers surface an honest "source unavailable, re-import" state.
// INVARIANTS: Inv 1 — the re-read is local disk only, zero network. Inv 4 — lazy (nothing read until a
// reader is invoked: the SELECTED asset / a PROBED atlas / fix time), so it stays off the ≤10s critical path.

import { keyOf } from './group';
import type { PickedFile } from './import';

/** Re-read one picked file's bytes from its retained File. Returns null (never throws) when there is no
 *  retained File (legacy producer) or the read rejects (folder moved/deleted). Byte-identical to the
 *  original `bytes` that was transferred into the worker. */
export async function readSourceBytes(f: PickedFile): Promise<ArrayBuffer | null> {
  if (!f.file) return null;
  try {
    return await f.file.arrayBuffer();
  } catch {
    return null;
  }
}

/** Build a key→lazy-reader map for the FilmViewer selection + the render-probe. Keys are `keyOf(f)` — the
 *  SAME dir-aware key the worker/probe use (so a basename collision across folders never re-reads the wrong
 *  file). LAZY: a reader reads from disk only when invoked, so building the map costs nothing. Last writer
 *  wins on a duplicate key — byte-identical to the old eager `for (f of picked) map.set(keyOf(f), f.bytes)`
 *  it replaces (which overwrote by iteration order). */
export function sourceReaders(files: PickedFile[]): Map<string, () => Promise<ArrayBuffer | null>> {
  const readers = new Map<string, () => Promise<ArrayBuffer | null>>();
  for (const f of files) readers.set(keyOf(f), () => readSourceBytes(f));
  return readers;
}
