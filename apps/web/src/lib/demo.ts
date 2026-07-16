// The landing demo project (P4) — the FOURTH ingest entry point beside pickFolder / filesFromInput /
// filesFromDataTransfer (lib/import.ts): one click yields the same PickedFile[] the Dropzone paths
// produce, so the ENTIRE existing flow (worker analysis, film viewer, drill-downs, fix) runs unchanged
// on a bundled synthetic sample. HONESTY: the sample is curated fixture art with real, documented
// defects — the pipeline MEASURES it like any user folder; nothing about the results is staged
// (invariant 3). The bytes ship WITH the app (a lazily-imported code chunk, zero fetch of user data —
// invariant 1 untouched). Each PickedFile carries a constructed `File`, so the app's lazy re-read path
// (readers → film decode / probe / fix) works exactly as with a real folder.

import type { PickedFile } from './import';

/** Decode a base64 payload into a fresh ArrayBuffer (main thread + Node test both have atob). */
export function b64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Build the demo PickedFile[] from the bundled payload. The payload module is imported LAZILY so the
 *  ~20 KB of demo bytes never weigh on the initial bundle — only a click pays for it. */
export async function loadDemoProject(): Promise<PickedFile[]> {
  const { DEMO_FILES } = await import('../demo/demo-data');
  return DEMO_FILES.map(({ path, b64 }) => {
    const bytes = b64ToBytes(b64);
    const name = path.split('/').pop() ?? path;
    // A constructed File supports .arrayBuffer() ⇒ the Round-21 lazy readers re-read it like a disk file.
    return { path, name, bytes, file: new File([bytes], name) };
  });
}
