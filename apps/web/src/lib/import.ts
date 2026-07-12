// Folder ingest — three entry points, all yielding the same PickedFile[]:
//   1. File System Access API (showDirectoryPicker)
//   2. <input webkitdirectory> fallback
//   3. drag-and-drop (webkitGetAsEntry recursion)
// Only manifest (.json / Spine .atlas) + image files are read. Zero network: bytes never leave the device.

export interface PickedFile {
  path: string;
  name: string;
  bytes: ArrayBuffer;
  /** ADDITIVE (Round 21 #2). The re-readable source File for this entry — all three ingest paths already
   *  hold one (FS Access getFile(), the <input> File, the drag fileEntry.file()). Lets the main thread
   *  RE-READ the bytes from disk AFTER runAnalysis TRANSFERS (detaches) `bytes` into the analyze worker,
   *  instead of keeping a second resident copy of the whole folder. Read via lib/source-bytes.ts. Absent
   *  ⇒ runAnalysis CLONES (today's behavior, no re-read path) so any legacy producer stays correct. */
  file?: File;
}

const RELEVANT_RE = /\.(json|atlas|skel|png|webp|jpe?g|avif)$/i;

/* ── File System Access API ─────────────────────────────────────────────── */

interface FsFileHandle {
  kind: 'file';
  getFile(): Promise<File>;
}
interface FsDirHandle {
  kind: 'directory';
  entries(): AsyncIterableIterator<[string, FsFileHandle | FsDirHandle]>;
}

export function supportsDirectoryPicker(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export async function pickFolder(): Promise<PickedFile[]> {
  const picker = (window as unknown as { showDirectoryPicker: () => Promise<FsDirHandle> }).showDirectoryPicker;
  const dir = await picker();
  const out: PickedFile[] = [];
  await readFsDir(dir, '', out);
  return out;
}

async function readFsDir(handle: FsDirHandle, prefix: string, out: PickedFile[]): Promise<void> {
  for await (const [name, h] of handle.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (h.kind === 'file') {
      if (!RELEVANT_RE.test(name)) continue;
      const file = await h.getFile();
      out.push({ path, name, bytes: await file.arrayBuffer(), file });
    } else {
      await readFsDir(h, path, out);
    }
  }
}

/* ── <input webkitdirectory> fallback ───────────────────────────────────── */

export async function filesFromInput(list: FileList): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  for (const file of Array.from(list)) {
    if (!RELEVANT_RE.test(file.name)) continue;
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    out.push({ path: rel || file.name, name: file.name, bytes: await file.arrayBuffer(), file });
  }
  return out;
}

/* ── drag-and-drop (recurse directory entries) ──────────────────────────── */

export async function filesFromDataTransfer(items: DataTransferItemList): Promise<PickedFile[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(items)) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  const out: PickedFile[] = [];
  for (const e of entries) await readEntry(e, out);
  return out;
}

async function readEntry(entry: FileSystemEntry, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((res, rej) => fileEntry.file(res, rej));
    if (RELEVANT_RE.test(file.name)) {
      out.push({ path: entry.fullPath.replace(/^\//, ''), name: file.name, bytes: await file.arrayBuffer(), file });
    }
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (const child of await readAllEntries(reader)) await readEntry(child, out);
  }
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const pump = (): void =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          pump();
        }
      }, reject);
    pump();
  });
}
