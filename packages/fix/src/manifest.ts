// Emit a deterministic TexturePacker (Hash layout) JSON manifest for a repacked atlas. Determinism is
// load-bearing: frames are sorted by name, key order is fixed, no timestamps — so the same repack
// produces byte-identical JSON across runs and re-parses (via @asset-doctor/parsers) to the same Atlas.

import type { Atlas } from '@asset-doctor/core';

export function emitTexturePackerJson(atlas: Atlas): string {
  const frames: Record<string, unknown> = {};
  for (const s of [...atlas.sprites].sort((a, b) => a.name.localeCompare(b.name))) {
    frames[s.name] = {
      // `frame` is stored AS PLACED (w/h swapped when rotated). Real TexturePacker/Pixi write it in the
      // UN-ROTATED (source) orientation and let the loader swap, so swap back here for rotated sprites —
      // keeps parse↔emit an exact identity and re-emits real-TP-shaped JSON that Pixi loads correctly
      // (matches emitSpineAtlasText's un-rotated `size:` line). x/y are never swapped.
      frame: s.rotated
        ? { x: s.frame.x, y: s.frame.y, w: s.frame.h, h: s.frame.w }
        : { x: s.frame.x, y: s.frame.y, w: s.frame.w, h: s.frame.h },
      rotated: s.rotated,
      trimmed: s.trimmed,
      ...(s.spriteSourceSize ? { spriteSourceSize: { x: s.spriteSourceSize.x, y: s.spriteSourceSize.y, w: s.spriteSourceSize.w, h: s.spriteSourceSize.h } } : {}),
      sourceSize: { w: s.sourceSize.w, h: s.sourceSize.h },
      ...(s.pivot ? { pivot: { x: s.pivot.x, y: s.pivot.y } } : {}),
      // Polygon-mode mesh (additive): emitted ONLY when present, after the rectangle keys, in the
      // fixed order vertices → verticesUV → triangles. Vec2 pairs map to [x,y]; all integers ⇒
      // identical stringification. Absent ⇒ byte-identical to the rectangle-only manifest above.
      ...(s.mesh ? {
        vertices: s.mesh.vertices.map((p) => [p.x, p.y]),
        verticesUV: s.mesh.verticesUV.map((p) => [p.x, p.y]),
        triangles: s.mesh.triangles,
      } : {}),
    };
  }
  const meta: Record<string, unknown> = {
    app: 'Asset Doctor (TexturePacker-compatible)',
    version: '1.0',
    image: atlas.imageRef,
    size: { w: atlas.size.w, h: atlas.size.h },
    ...(atlas.format ? { format: atlas.format } : {}),
    ...(atlas.scale !== undefined ? { scale: String(atlas.scale) } : {}),
    // Multipack linkage (round28): re-emit the sibling-JSON list ONLY when present and non-empty, at the END
    // of meta, carried VERBATIM with NO sort (the positional index is load-bearing — Pixi caches sibling i at
    // related_multi_packs[i], spritesheetAsset.mjs:39 — so re-sorting would corrupt the index↔sheet pairing).
    // Absent ⇒ no key ⇒ byte-identical to the single-page manifest (the common case).
    ...(atlas.relatedMultiPacks && atlas.relatedMultiPacks.length
      ? { related_multi_packs: atlas.relatedMultiPacks }
      : {}),
  };
  // Frame-animation map (round29): emit a TOP-LEVEL `animations` key BETWEEN frames and meta (the
  // TexturePacker/Pixi key order is frames, animations, meta), ONLY when present and non-empty, carried
  // VERBATIM with NO sort (array order + key order are play order; re-sorting would corrupt playback). Frame
  // KEYS, so it survives file renames (hash/KTX2). Absent ⇒ no key ⇒ byte-identical to the non-animated case.
  const out: Record<string, unknown> = { frames };
  if (atlas.animations && Object.keys(atlas.animations).length) out.animations = atlas.animations;
  out.meta = meta;
  return JSON.stringify(out, null, 2);
}

/** Emit a Spine / libGDX `.atlas` text page (the inverse of parseSpineAtlasText). Deterministic:
 *  regions sorted by name. The page `size:` line is non-indented so the parser detects the page. */
export function emitSpineAtlasText(atlas: Atlas): string {
  // filter/repeat carried from the source page (Atlas.filter/repeat) so a repack keeps a pixel-art
  // (Nearest) or tiling atlas's sampler settings — dropping them silently forced Linear/none. Absent ⇒
  // today's defaults ⇒ byte-identical for the common Linear/none atlas. Sampler hints only (no pixels).
  const lines: string[] = [atlas.imageRef, `size: ${atlas.size.w},${atlas.size.h}`, `format: ${atlas.format ?? 'RGBA8888'}`, `filter: ${atlas.filter ?? 'Linear,Linear'}`, `repeat: ${atlas.repeat ?? 'none'}`];
  for (const s of [...atlas.sprites].sort((a, b) => a.name.localeCompare(b.name))) {
    // the page-space `size:` is the UN-rotated region extent (parser swaps w/h when rotate=90)
    const w = s.rotated ? s.frame.h : s.frame.w;
    const h = s.rotated ? s.frame.w : s.frame.h;
    lines.push(s.name, `  rotate: ${s.rotated ? 90 : 0}`, `  xy: ${s.frame.x}, ${s.frame.y}`, `  size: ${w}, ${h}`, `  orig: ${s.sourceSize.w}, ${s.sourceSize.h}`, `  offset: ${s.spriteSourceSize?.x ?? 0}, ${s.spriteSourceSize?.y ?? 0}`, `  index: ${s.index ?? -1}`);
  }
  return lines.join('\n') + '\n';
}
