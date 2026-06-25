// Merge atlas assets that point at the SAME page image. Spine multi-page atlases routinely share
// a page across skeletons (e.g. fs-intro's page 2 is ../BG_intro/BG_intro_1080p.png), and one image
// can be referenced by several manifests. Without merging, that image is analyzed multiple times —
// producing misleading near-empty "subset" views and double-counting its VRAM. We union the region
// lists (by sprite name) so occupancy reflects the real packing and the texture is counted once.

import type { Asset, Atlas, ImageAsset } from '@asset-doctor/core';

export function mergeSharedAtlases(assets: Asset[]): Asset[] {
  const byImage = new Map<string, { atlas: Atlas; image: ImageAsset; names: Set<string> }>();
  const passthrough: Asset[] = [];

  for (const a of assets) {
    if (a.kind !== 'atlas') {
      passthrough.push(a);
      continue;
    }
    const key = a.atlas.name; // resolved image identity (the grouping sets this to the image path)
    const cur = byImage.get(key);
    if (!cur) {
      byImage.set(key, {
        atlas: { ...a.atlas, sprites: a.atlas.sprites.slice() },
        image: a.image,
        names: new Set(a.atlas.sprites.map((s) => s.name)),
      });
    } else {
      for (const s of a.atlas.sprites) {
        if (!cur.names.has(s.name)) {
          cur.names.add(s.name);
          cur.atlas.sprites.push(s);
        }
      }
    }
  }

  const merged: Asset[] = [];
  for (const m of byImage.values()) merged.push({ kind: 'atlas', atlas: m.atlas, image: m.image });
  return [...merged, ...passthrough];
}
