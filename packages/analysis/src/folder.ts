// Whole-folder (cross-asset) rules. These look at the folder as a unit — duplicates, loose
// sprites that should be atlased, under-filled atlases that could merge, integrity, and the
// aggregate transcode win. All folder findings carry scope: 'folder' and relatedRefs.

import type { Asset, Atlas, Finding, ImageAsset, ImageFeatures, ThresholdConfig } from '@asset-doctor/core';
import { fmtBytes, occupancyValue, vramBytes } from './rules';

function imageByRef(assets: Asset[]): Map<string, ImageAsset> {
  const m = new Map<string, ImageAsset>();
  for (const a of assets) m.set(a.kind === 'atlas' ? a.atlas.name : a.image.name, a.image);
  return m;
}

/** Hamming distance between two 64-bit hashes given as 16-hex-char strings. */
function hamming(a: string, b: string): number {
  let dist = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = (parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16)) & 0xf;
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

export function duplicateExactFindings(assets: Asset[], features: ImageFeatures[]): Finding[] {
  const imgs = imageByRef(assets);
  const groups = new Map<string, string[]>();
  for (const f of features) {
    const g = groups.get(f.contentHash) ?? [];
    g.push(f.assetRef);
    groups.set(f.contentHash, g);
  }
  const out: Finding[] = [];
  for (const [hash, refs] of groups) {
    if (refs.length < 2) continue;
    refs.sort();
    const img = imgs.get(refs[0]!);
    const perDisk = img?.byteSize ?? 0;
    const perVram = img ? vramBytes(img.size) : 0;
    out.push({
      id: `dup-exact:${hash.slice(0, 10)}`,
      rule: 'duplicate-exact',
      severity: 'warn',
      scope: 'folder',
      assetRef: refs[0]!,
      relatedRefs: refs,
      title: `${refs.length}× identical file`,
      detail:
        `Byte-identical copies: ${refs.join(', ')}. Keep one and reference it — each copy is ` +
        `also a separate texture upload (${fmtBytes(perVram)} VRAM each).`,
      fix: 'De-duplicate: keep a single copy and update references.',
      estimate: {
        diskBytesSaved: perDisk * (refs.length - 1),
        vramBytesSaved: perVram * (refs.length - 1),
      },
    });
  }
  return out;
}

export function duplicateSimilarFindings(features: ImageFeatures[], cfg: ThresholdConfig): Finding[] {
  const feats = features.filter((f) => f.dHash);
  const used = new Set<number>();
  const out: Finding[] = [];
  for (let i = 0; i < feats.length; i++) {
    if (used.has(i)) continue;
    const group = [i];
    for (let j = i + 1; j < feats.length; j++) {
      if (used.has(j)) continue;
      if (hamming(feats[i]!.dHash!, feats[j]!.dHash!) <= cfg.duplicates.similarHammingMax) group.push(j);
    }
    if (group.length < 2) continue;
    group.forEach((k) => used.add(k));
    // all byte-identical → that's duplicate-exact's job; only report genuinely *similar* sets here
    if (new Set(group.map((k) => feats[k]!.contentHash)).size <= 1) continue;
    const refs = group.map((k) => feats[k]!.assetRef).sort();
    out.push({
      id: `dup-similar:${refs[0]}`,
      rule: 'duplicate-similar',
      severity: 'info',
      scope: 'folder',
      assetRef: refs[0]!,
      relatedRefs: refs,
      title: `${refs.length} near-identical images`,
      detail:
        `Perceptually near-identical (dHash ≤ ${cfg.duplicates.similarHammingMax} bits): ` +
        `${refs.join(', ')}. Likely re-exports or near-dupes — consider reusing one.`,
      fix: 'Review for reuse / de-duplication.',
    });
  }
  return out;
}

export function shouldAtlasFinding(assets: Asset[], cfg: ThresholdConfig): Finding | null {
  const small = assets.filter(
    (a) => a.kind === 'image' && Math.max(a.image.size.w, a.image.size.h) <= cfg.shouldAtlas.maxSpriteEdgePx,
  );
  if (small.length < cfg.shouldAtlas.minLooseImages) return null;
  const refs = small.map((a) => a.image.name).sort();
  return {
    id: 'folder:should-atlas',
    rule: 'should-atlas',
    severity: 'warn',
    scope: 'folder',
    assetRef: refs[0]!,
    relatedRefs: refs,
    title: `${small.length} loose sprites — pack into an atlas`,
    detail:
      `${small.length} standalone images (≤${cfg.shouldAtlas.maxSpriteEdgePx}px). Each is its own ` +
      `texture bind + draw call at runtime; packing them into one atlas batches the draws.`,
    fix: 'Pack loose sprites into a TexturePacker / Pixi atlas.',
  };
}

export function atlasMergeFinding(atlases: Atlas[], cfg: ThresholdConfig): Finding | null {
  const under = atlases.filter((a) => occupancyValue(a) < cfg.atlasMerge.occupancyBelow);
  if (under.length < cfg.atlasMerge.minAtlases) return null;
  const usedArea = under.reduce(
    (s, a) => s + a.sprites.reduce((t, sp) => t + sp.frame.w * sp.frame.h, 0),
    0,
  );
  const maxDim = Math.max(...under.map((a) => Math.max(a.size.w, a.size.h)));
  const capacity = maxDim * maxDim;
  const minAtlases = Math.max(1, Math.ceil(usedArea / capacity));
  if (minAtlases >= under.length) return null; // no clear win
  const refs = under.map((a) => a.name).sort();
  const currentVram = under.reduce((s, a) => s + vramBytes(a.size), 0);
  const mergedVram = minAtlases * capacity * 4;
  return {
    id: 'folder:atlas-merge',
    rule: 'atlas-merge',
    severity: 'warn',
    scope: 'folder',
    assetRef: refs[0]!,
    relatedRefs: refs,
    title: `${under.length} under-filled atlases → merge into ~${minAtlases}`,
    detail:
      `${refs.join(', ')} are each under ${Math.round(cfg.atlasMerge.occupancyBelow * 100)}% full. ` +
      `Their content fits in ~${minAtlases} sheet${minAtlases === 1 ? '' : 's'} — merging cuts ` +
      `texture binds, draw calls and VRAM.`,
    fix: 'Re-pack these atlases together.',
    estimate: { vramBytesSaved: Math.max(0, currentVram - mergedVram) },
  };
}

export function integrityFindings(missing: { manifest: string; image: string }[]): Finding[] {
  return missing.map((m) => ({
    id: `integrity:${m.manifest}`,
    rule: 'integrity-missing-image',
    severity: 'crit',
    scope: 'folder',
    assetRef: m.manifest,
    relatedRefs: [m.manifest, m.image],
    title: `Missing atlas image: ${m.image}`,
    detail: `Manifest ${m.manifest} references "${m.image}", which is not in the folder — the atlas can't load.`,
    fix: 'Add the missing image or fix the manifest path.',
  }));
}

export function formatAggregateFinding(formatFindings: Finding[]): Finding | null {
  if (formatFindings.length < 2) return null;
  const totalSaved = formatFindings.reduce((s, f) => s + (f.estimate?.diskBytesSaved ?? 0), 0);
  if (totalSaved <= 0) return null;
  const refs = formatFindings.map((f) => f.assetRef).sort();
  return {
    id: 'folder:format-aggregate',
    rule: 'format',
    severity: 'warn',
    scope: 'folder',
    assetRef: refs[0]!,
    relatedRefs: refs,
    title: `${formatFindings.length} images could shrink — ${fmtBytes(totalSaved)} total`,
    detail: `Transcoding ${formatFindings.length} images to AVIF/WebP saves ~${fmtBytes(totalSaved)} of download across the folder.`,
    fix: 'Batch-transcode to AVIF/WebP for delivery.',
    estimate: { diskBytesSaved: totalSaved },
  };
}
