// PURE path math for owner-aware dedup repointing (design §3d / §10.7). The worker's Phase-C repoints a
// consumer atlas manifest's `meta.image` at its OWNER's image — which may live in another folder — by
// writing a POSIX path RELATIVE to the consumer manifest's own directory. That relative ref must resolve
// back to the owner image through @asset-doctor/parsers `parseAtlas` (which reads `meta.image`), so the
// repointed atlas stays a valid drop-in. These helpers are browser-API-free and are the SINGLE source of
// truth for that path math (the fix.worker imports them — no hand-rolled copy can drift). Vitest-covered.

/** Directory of a POSIX path, WITH its trailing slash ('' for a root-level file). */
export const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i + 1);
};

/** Collapse '.'/'..'/empty segments → a normalized POSIX path (no leading/trailing slash). */
export const normalize = (p: string): string => {
  const out: string[] = [];
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
};

/** Resolve a manifest's `meta.image` (relative to the manifest's dir) → the image's folder-relative path.
 *  This is exactly what the parser does, so it is the inverse of `relativeImageRef`. */
export const resolveImageRef = (manifestPath: string, img: string): string => normalize(dirOf(manifestPath) + img);

/** POSIX relative path FROM a manifest's directory TO a folder-relative image path — the inverse of
 *  `resolveImageRef`, so the rewritten meta.image resolves back to `toPath` through the same parser.
 *  Used by Phase-C dedup to repoint a consumer manifest at an owner image that may live in another folder. */
export const relativeImageRef = (fromDir: string, toPath: string): string => {
  const from = normalize(fromDir).split('/').filter(Boolean);
  const to = normalize(toPath).split('/').filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const up = from.slice(i).map(() => '..');
  const down = to.slice(i);
  const rel = [...up, ...down].join('/');
  return rel === '' ? (to[to.length - 1] ?? toPath) : rel;
};
