import { describe, expect, it, vi } from 'vitest';
import { readSourceBytes, sourceReaders } from './source-bytes';
import type { PickedFile } from './import';

/** A minimal File-shim with a spy-able arrayBuffer() so we can (a) assert byte-identity and (b) assert the
 *  reader is LAZY (arrayBuffer is never called until the reader is invoked). Structurally a File for the
 *  PickedFile.file slot (only arrayBuffer() is exercised here). */
function shimFile(bytes: number[]): { file: File; calls: () => number } {
  let n = 0;
  const buf = new Uint8Array(bytes).buffer;
  const file = {
    arrayBuffer: vi.fn(async () => {
      n++;
      return buf;
    }),
  } as unknown as File;
  return { file, calls: () => n };
}

const picked = (path: string, file?: File): PickedFile => ({
  path,
  name: path.split('/').pop()!,
  bytes: new ArrayBuffer(0), // detached-stand-in: callers re-read via `file`, never this
  ...(file ? { file } : {}),
});

describe('readSourceBytes', () => {
  it('returns the exact bytes from the retained File', async () => {
    const { file } = shimFile([1, 2, 3, 4]);
    const got = await readSourceBytes(picked('a.png', file));
    expect(got).not.toBeNull();
    expect([...new Uint8Array(got!)]).toEqual([1, 2, 3, 4]);
  });

  it('returns null (no throw) when the PickedFile has no retained File (legacy producer)', async () => {
    expect(await readSourceBytes(picked('a.png'))).toBeNull();
  });

  it('returns null (no throw) when arrayBuffer() rejects (folder moved/deleted)', async () => {
    const file = { arrayBuffer: vi.fn(async () => Promise.reject(new Error('gone'))) } as unknown as File;
    expect(await readSourceBytes(picked('a.png', file))).toBeNull();
  });
});

describe('sourceReaders', () => {
  it('keys readers by keyOf(f) (dir-aware) and is LAZY (no read until a reader is invoked)', async () => {
    const a = shimFile([10]);
    const b = shimFile([20]);
    const readers = sourceReaders([picked('dir/a.png', a.file), picked('dir/b.png', b.file)]);
    // dir-aware keys present
    expect(readers.has('dir/a.png')).toBe(true);
    expect(readers.has('dir/b.png')).toBe(true);
    // LAZY: building the map read nothing
    expect(a.calls()).toBe(0);
    expect(b.calls()).toBe(0);
    // invoking one reader reads ONLY that file
    const got = await readers.get('dir/a.png')!();
    expect([...new Uint8Array(got!)]).toEqual([10]);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(0);
  });

  it('distinguishes same-basename files in different folders (no collision)', () => {
    const x = shimFile([1]);
    const y = shimFile([2]);
    const readers = sourceReaders([picked('foo/icon.png', x.file), picked('bar/icon.png', y.file)]);
    expect(readers.size).toBe(2);
    expect(readers.has('foo/icon.png')).toBe(true);
    expect(readers.has('bar/icon.png')).toBe(true);
  });

  it('a reader for a key with no retained File resolves null (honest, no throw)', async () => {
    const readers = sourceReaders([picked('a.png')]);
    expect(await readers.get('a.png')!()).toBeNull();
  });
});
