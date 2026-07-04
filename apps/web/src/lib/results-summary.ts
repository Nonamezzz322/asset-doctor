// PURE results-summary model for the app-screen results header + budget strip (app-screen re-skin Phase 2).
// apps/web has no React harness (vitest env=node), so the load-bearing decisions — the honest folder label,
// the asset counts, and the REAL-metric budget model — live here and are Node-unit-tested; the results
// header is a thin renderer over these outputs (precedent: totals-rows.ts, results-heading.ts — pure, t-free,
// no DOM). HONESTY (invariant 3/5): every value is read straight from the measured report/probe — nothing is
// fabricated, disk and VRAM stay distinct quantities, and probe-only metrics degrade to null (rendered as an
// absent-metric placeholder), never invented.

import type { AnalysisReport } from '@asset-doctor/core';
import type { TriageIndex } from './triage';

/** Folder label from the picked files' common leading DIRECTORY segment. Returns the first path segment IFF
 *  every path shares it AND every path has a '/' after it (a real directory, not a bare root-level filename).
 *  null ⇒ FS-Access root-level files (bare names) / mixed roots / empty ⇒ the caller falls back to an honest
 *  generic label, NEVER a fabricated folder name. */
export function folderLabel(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const first = paths[0]!;
  if (first.indexOf('/') < 0) return null;
  const root = first.split('/')[0]!;
  if (root === '') return null; // leading-slash path ⇒ empty first segment
  for (const p of paths) {
    if (p.indexOf('/') < 0 || p.split('/')[0] !== root) return null;
  }
  return root;
}

export interface AssetCounts {
  atlases: number;
  sprites: number;
  looseImages: number;
}

/** Real asset counts: atlas count = number of atlas keys in atlasFrames; sprite count = Σ frames across
 *  atlases; loose images = the remaining assets. atlasFrames absent ⇒ {0,0,assets.length}. loose clamped ≥0. */
export function assetCounts(report: AnalysisReport): AssetCounts {
  const frames = report.atlasFrames ?? {};
  const keys = Object.keys(frames);
  const sprites = keys.reduce((n, k) => n + frames[k]!.length, 0);
  return { atlases: keys.length, sprites, looseImages: Math.max(0, report.assets.length - keys.length) };
}

export interface SevSegment {
  sev: 'crit' | 'warn' | 'info';
  count: number;
}

export interface BudgetModel {
  vram: { loaded: number; measured: { vram: number; declared: number; atlasesProbed: number } | null };
  /** `calls` = the MEASURED render-probe draw calls (null when no probe ran). `estimated` = the STATIC
   *  draw-call FLOOR = totals.loadedTextures (distinct loaded GPU textures; each is at least one draw, sprites
   *  within an atlas batch down) — always present, so the card is never blank. NEVER conflate the two. */
  draw: { calls: number | null; atlasesProbed: number | null; estimated: number };
  disk: { total: number; saved: number; after: number; savedPct: number };
  findings: { problems: number; crit: number; warn: number; info: number; segments: SevSegment[] };
}

/** The 4 budget-strip metrics, read STRAIGHT from the measured totals + tally. probe-only metrics (measured
 *  VRAM, draw calls) are null when the render-probe did not run (WebGL absent / no atlas) — the renderer shows
 *  an absent-metric placeholder, never a fabricated number. NO user budgets here (deferred): these are the
 *  honest current values, not an over/under-budget verdict. */
export function budgetModel(totals: NonNullable<AnalysisReport['totals']>, tally: TriageIndex['tally']): BudgetModel {
  const savedPct = totals.diskBytes > 0 ? Math.round((totals.potentialDiskSaved / totals.diskBytes) * 100) : 0;
  const after = Math.max(0, totals.diskBytes - totals.potentialDiskSaved);
  const p = totals.probe;
  const segments = ([['crit', tally.crit], ['warn', tally.warn], ['info', tally.info]] as const)
    .filter(([, n]) => n > 0)
    .map(([sev, count]) => ({ sev, count }));
  return {
    vram: {
      loaded: totals.loadedVramBytes,
      measured: p ? { vram: p.vramBytes, declared: p.declaredVramBytes, atlasesProbed: p.atlasesProbed } : null,
    },
    draw: { calls: p ? p.drawCalls : null, atlasesProbed: p ? p.atlasesProbed : null, estimated: totals.loadedTextures ?? 0 },
    disk: { total: totals.diskBytes, saved: totals.potentialDiskSaved, after, savedPct },
    findings: {
      problems: tally.crit + tally.warn + tally.info,
      crit: tally.crit,
      warn: tally.warn,
      info: tally.info,
      segments,
    },
  };
}
