// Emit a deterministic TexturePacker (Hash layout) JSON manifest for a repacked atlas. Determinism is
// load-bearing: frames are sorted by name, key order is fixed, no timestamps — so the same repack
// produces byte-identical JSON across runs and re-parses (via @asset-doctor/parsers) to the same Atlas.

import type { Atlas } from '@asset-doctor/core';

export function emitTexturePackerJson(atlas: Atlas): string {
  const frames: Record<string, unknown> = {};
  for (const s of [...atlas.sprites].sort((a, b) => a.name.localeCompare(b.name))) {
    frames[s.name] = {
      frame: { x: s.frame.x, y: s.frame.y, w: s.frame.w, h: s.frame.h },
      rotated: s.rotated,
      trimmed: s.trimmed,
      ...(s.spriteSourceSize ? { spriteSourceSize: { x: s.spriteSourceSize.x, y: s.spriteSourceSize.y, w: s.spriteSourceSize.w, h: s.spriteSourceSize.h } } : {}),
      sourceSize: { w: s.sourceSize.w, h: s.sourceSize.h },
      ...(s.pivot ? { pivot: { x: s.pivot.x, y: s.pivot.y } } : {}),
    };
  }
  const meta: Record<string, unknown> = {
    app: 'Asset Doctor (TexturePacker-compatible)',
    version: '1.0',
    image: atlas.imageRef,
    size: { w: atlas.size.w, h: atlas.size.h },
    ...(atlas.format ? { format: atlas.format } : {}),
    ...(atlas.scale !== undefined ? { scale: String(atlas.scale) } : {}),
  };
  return JSON.stringify({ frames, meta }, null, 2);
}
