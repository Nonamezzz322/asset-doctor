// @asset-doctor/correlate — the linter→doctor layer. Stitches a STATIC folder audit (AnalysisReport)
// and a LIVE runtime capture (RuntimeReport) into single verdicts: each correlated finding cites
// evidence from BOTH sources, names the diagnosis, and gives a fix + estimated effect. This is where
// the two halves of the moat become one diagnosis — neither static nor runtime alone could say it.

import type { AnalysisReport, FindingParams, Severity } from '@asset-doctor/core';
import { blendModeLabel, type RuntimeReport } from '@asset-doctor/probe/runtime';

export interface CorrelatedFinding {
  id: string;
  rule: 'batching' | 'vram' | 'upload-hitch' | 'shader-hitch' | 'redundant-state' | 'premultiplied-blend';
  severity: Severity;
  title: string;
  /** Proof from the folder audit. */
  staticEvidence: string;
  /** Proof from the live capture. */
  runtimeEvidence: string;
  diagnosis: string;
  fix: string;
  estimate?: { drawCallsAfter?: number; vramBytesSaved?: number; hitchMsSaved?: number };
  /** i18n: the `rule` doubles as the message family; `params` + a per-field `variant` drive localized
   *  templates. English is identical to the baked strings above. */
  params?: FindingParams & { variant?: string };
}

export interface CorrelationReport {
  findings: CorrelatedFinding[];
  summary: string;
}

/** Narrow structural slice of a fix-receipt sheet diff — the MEASURED before→after probe fields the
 *  fix engine fills on the main thread (apps/web `attachSheetProbes`). `apps/web`'s `SheetDiff` is
 *  structurally assignable to this, so `correlateFix(receipt)` takes the real receipt with NO cast and
 *  NO dependency edge from `correlate` to `apps/web` (TS structural typing). Every field is OPTIONAL —
 *  absent ⇒ no probe ran (no WebGL / pack page with no source atlas) ⇒ no measured verdict (honesty). */
export interface MeasuredSheetDiff {
  name?: string;
  /** MEASURED issued GL draw calls of the SOURCE sheet on the user's GPU this run. */
  drawCallsBefore?: number;
  /** MEASURED issued GL draw calls of the EMITTED sheet — the honest "after". */
  drawCallsAfter?: number;
  /** MEASURED decoded texture VRAM (Σ w·h·4 over uploaded textures) of the SOURCE sheet — the REAL GPU
   *  footprint, a DIFFERENT quantity from any static w·h·4 estimate (invariant 5). */
  decodedVramBefore?: number;
  /** MEASURED decoded texture VRAM of the EMITTED sheet. */
  decodedVramAfter?: number;
}

/** Narrow structural slice of a fix-receipt — only the measured sheet probes `correlateFix` reads. */
export interface FixProbeReceipt {
  sheetDiffs?: MeasuredSheetDiff[];
}

const DRAW_CALL_BUDGET = 50; // a healthy max draw-calls/frame for a 2D HTML5 game
const REDUNDANT_PER_FRAME = 5; // redundant binds/frame above this = state thrash
// Post-fix MEASURED draw-call reduction → severity. NEW editorial cutoffs (NOT inherited from
// correlate()'s idealDraws*3 *trigger*): a real measured reduction is graded by magnitude.
const FIX_BATCH_CRIT_RATIO = 0.34; // ≈3×+ fewer measured draws
const FIX_BATCH_WARN_RATIO = 0.67; // ≈1.5×+ fewer measured draws
const fmtMB = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;

type PremultBlendVariant = 'halo' | 'safe' | 'inconclusive';

/** Build the R6 premultiplied × measured-blend verdict. Baked English matches the corr.premultiplied-blend.*
 *  EN catalog templates (drift-guarded). `blendMode` is the technical GL mode token (English, like fps/RGBA8888)
 *  — cited only in the inconclusive runtime evidence. severity: `warn` for `halo` (a MEASURED fringe risk, but
 *  the flagged shape could be intentional dark art, so not a crit defect), `info` for `safe`/`inconclusive`.
 *  HONESTY: the static evidence keeps the irreducible "edge shape, not blend mode" hedge; the verdict resolves
 *  only the loader's blend mode (which we measured), never the art's authoring intent. */
function premultBlendFinding(variant: PremultBlendVariant, n: number, blendMode: string): CorrelatedFinding {
  const staticEvidence = `${n} sprites have premultiplied-shaped soft edges (measured edge shape, not blend mode)`;
  const copy: Record<PremultBlendVariant, { severity: Severity; title: string; runtimeEvidence: string; diagnosis: string; fix: string }> = {
    halo: {
      severity: 'warn',
      title: `${n} premultiplied-shaped sprites will fringe — renderer blends straight alpha`,
      runtimeEvidence: `renderer observed blending straight (un-premultiplied) alpha`,
      diagnosis: `At their soft edges these sprites store RGB that collapses toward black; under the straight-alpha blending we measured, that dark RGB shows through as a dark fringe.`,
      fix: `Match the texture premultiply/alphaMode to how the art was exported, or re-export with matching alpha association, so the edges blend cleanly.`,
    },
    safe: {
      severity: 'info',
      title: `${n} premultiplied-shaped sprites — consistent with the renderer's premultiplied blending`,
      runtimeEvidence: `renderer observed blending premultiplied alpha`,
      diagnosis: `Premultiplied-shaped edges blended as premultiplied alpha composite correctly — no fringe from this pairing.`,
      fix: `No action needed for this blend mode; if a fringe still appears, confirm the art was exported premultiplied.`,
    },
    inconclusive: {
      severity: 'info',
      title: `${n} premultiplied-shaped sprites — blend mode inconclusive`,
      runtimeEvidence: `renderer alpha blending is inconclusive (${blendMode})`,
      diagnosis: `We could not tie a single blend mode to these sprites, so whether they fringe depends on the draw — inspect the passes that render them.`,
      fix: `Inspect the draws that render these sprites and make their blend mode match how the art was exported.`,
    },
  };
  const c = copy[variant];
  return {
    id: 'corr:premultiplied-blend',
    rule: 'premultiplied-blend',
    severity: c.severity,
    title: c.title,
    staticEvidence,
    runtimeEvidence: c.runtimeEvidence,
    diagnosis: c.diagnosis,
    fix: c.fix,
    params: { n, variant, blendMode },
  };
}

export function correlate(stat: AnalysisReport, rt: RuntimeReport): CorrelationReport {
  const out: CorrelatedFinding[] = [];
  const find = (rule: string) => stat.findings.find((f) => f.rule === rule);
  const atlasCount = stat.assets.filter((a) => a.occupancy !== undefined).length;
  const shouldAtlas = find('should-atlas');
  const atlasMerge = find('atlas-merge');

  // R1 — batching: static fragmentation × live draw calls (the headline correlation). Fires when the
  // build is fragmented (loose sprites / mergeable or many atlases) AND live draw calls are well above
  // what batching would give (an absolute budget, or 3× the post-packing ideal).
  const idealDraws = shouldAtlas ? Math.max(1, atlasCount + 1) : Math.max(2, Math.ceil(atlasCount / 2));
  const fragmented = shouldAtlas !== undefined || atlasMerge !== undefined || atlasCount >= 4;
  const tooManyDraws =
    rt.drawCalls.max > DRAW_CALL_BUDGET || (rt.drawCalls.max >= 4 && rt.drawCalls.max > idealDraws * 3);
  if (fragmented && tooManyDraws) {
    // The runtime draw-call correlation must cite the LOGICAL loose-sprite count (one variant loads per
    // asset), which the finding now carries in params.n. Fall back to relatedRefs.length for synthetic
    // findings without params.n (keeps the correlate unit test green).
    const nParam = shouldAtlas?.params?.n;
    const looseN = typeof nParam === 'number' ? nParam : (shouldAtlas?.relatedRefs?.length ?? 0);
    out.push({
      id: 'corr:batching',
      rule: 'batching',
      severity: 'crit',
      title: `${rt.drawCalls.max} draw calls/frame — sprites aren't batching`,
      staticEvidence: shouldAtlas
        ? `${looseN} loose sprites not packed into an atlas`
        : atlasMerge
          ? `under-filled atlases that could merge`
          : `${atlasCount} separate atlases`,
      runtimeEvidence: `${rt.drawCalls.max} draw calls + ~${rt.textureBinds.avg} texture binds/frame`,
      diagnosis: `Each texture forces its own draw call — the renderer can't batch across ${shouldAtlas ? 'the loose sprites' : 'the separate atlases'}.`,
      fix: shouldAtlas
        ? 'Pack the loose sprites into one atlas so they batch into a single draw.'
        : 'Re-pack the atlases together so sprites share a texture and batch.',
      estimate: { drawCallsAfter: idealDraws },
      params: {
        drawCalls: rt.drawCalls.max,
        binds: rt.textureBinds.avg,
        looseN,
        atlasCount,
        staticVariant: shouldAtlas ? 'loose' : atlasMerge ? 'merge' : 'atlases',
        subjectVariant: shouldAtlas ? 'loose' : 'atlases',
      },
    });
  }

  // R2 — VRAM: static estimate vs live residency
  if (rt.vramBytes > 0 && stat.totals.loadedVramBytes > 0 && rt.vramBytes > stat.totals.loadedVramBytes * 1.5) {
    out.push({
      id: 'corr:vram',
      rule: 'vram',
      severity: 'warn',
      title: `Live VRAM ${fmtMB(rt.vramBytes)} exceeds the loaded estimate`,
      staticEvidence: `loaded-VRAM estimate ~${fmtMB(stat.totals.loadedVramBytes)} (one variant/asset)`,
      runtimeEvidence: `${fmtMB(rt.vramBytes)} resident during play`,
      diagnosis: `More textures are on the GPU than the loaded set implies — textures not freed, or extra variants/atlases resident at once.`,
      fix: 'Free off-screen textures; keep one resolution/format tier per device.',
      estimate: { vramBytesSaved: rt.vramBytes - stat.totals.loadedVramBytes },
      params: { live: rt.vramBytes, loaded: stat.totals.loadedVramBytes },
    });
  }

  // R3 — upload hitches. HONESTY: cite the STATIC side only when a finding backs it (dimensions-oversize).
  // Uploads-during-gameplay is a runtime signal on its own — mid-game uploads can be SMALL textures loaded
  // late, so "large textures in the build" would assert a size fact nothing measured. With no oversize
  // finding the static evidence is "—" (a runtime-only observation, exactly as R4/R5 do), never fabricated.
  const uploadHitchMs = rt.hitches.filter((h) => h.cause === 'texture upload').reduce((s, h) => s + h.ms, 0);
  const oversize = find('dimensions-oversize');
  if (rt.uploadsDuringGameplay > 0 || uploadHitchMs > 0) {
    out.push({
      id: 'corr:upload-hitch',
      rule: 'upload-hitch',
      severity: 'warn',
      title: `${rt.uploadsDuringGameplay} texture uploads during gameplay`,
      staticEvidence: oversize ? `the build has oversized textures` : `—`,
      runtimeEvidence: `${rt.uploadsDuringGameplay} uploads mid-game${uploadHitchMs ? `, ~${uploadHitchMs}ms of hitches` : ''}`,
      diagnosis: `Uploading textures to the GPU during play stalls the frame.`,
      fix: 'Pre-upload these textures on the loading screen (GPU pre-warm).',
      ...(uploadHitchMs ? { estimate: { hitchMsSaved: uploadHitchMs } } : {}),
      // staticVariant omitted when there is no oversize finding ⇒ renderCorrelated falls back to the baked
      // "—" (no `static_none` template needed); only the evidence-backed 'oversize' branch is localized.
      params: { uploads: rt.uploadsDuringGameplay, hitchMs: uploadHitchMs, ...(oversize ? { staticVariant: 'oversize' } : {}) },
    });
  }

  // R4 — shader-compile hitches
  const shaderHitchMs = rt.hitches.filter((h) => h.cause === 'shader compile').reduce((s, h) => s + h.ms, 0);
  if (rt.shaderCompilesDuringGameplay > 0 || shaderHitchMs > 0) {
    out.push({
      id: 'corr:shader-hitch',
      rule: 'shader-hitch',
      severity: 'warn',
      title: `${rt.shaderCompilesDuringGameplay} shaders compiled during gameplay`,
      staticEvidence: `—`,
      runtimeEvidence: `${rt.shaderCompilesDuringGameplay} compiles mid-game${shaderHitchMs ? `, ~${shaderHitchMs}ms` : ''}`,
      diagnosis: `Shader compilation mid-game causes a one-time hitch.`,
      fix: 'Pre-compile / warm shaders at boot.',
      ...(shaderHitchMs ? { estimate: { hitchMsSaved: shaderHitchMs } } : {}),
      params: { compiles: rt.shaderCompilesDuringGameplay, hitchMs: shaderHitchMs },
    });
  }

  // R5 — redundant state changes
  const redundantPerFrame = rt.frames > 0 ? rt.redundantBinds / rt.frames : 0;
  if (redundantPerFrame > REDUNDANT_PER_FRAME) {
    out.push({
      id: 'corr:redundant',
      rule: 'redundant-state',
      severity: 'info',
      title: `~${Math.round(redundantPerFrame)} redundant binds/frame`,
      staticEvidence: `—`,
      runtimeEvidence: `${rt.redundantBinds} redundant texture/program binds over ${rt.frames} frames`,
      diagnosis: `Re-binding the already-bound texture/program wastes GPU state changes.`,
      fix: 'Sort draws by texture/material so the batcher can dedupe binds.',
      params: { perFrame: Math.round(redundantPerFrame), redundant: rt.redundantBinds, frames: rt.frames },
    });
  }

  // R6 — premultiplied × measured blend (P8). The static premultiplied-alpha disclosure hedges on the
  // loader's blend mode; the live capture RESOLVES that hedge. A premultiplied-shaped edge stores RGB that
  // collapses toward black, so under MEASURED straight-alpha blending it fringes regardless of which
  // authoring produced the bytes (the residual "edge shape, not blend mode" hedge governs only the FIX). Fires
  // ONLY when the static finding exists AND a blend signal was observed — an old exported session carries no
  // `blend`, and a run where no blend/pixelStorei was seen leaves all three false ⇒ no verdict (honesty).
  const premult = find('premultiplied-alpha');
  if (premult && rt.blend) {
    const { premultiplied, straight, unpackPremultiply } = rt.blend;
    const variant: PremultBlendVariant | null =
      straight && premultiplied ? 'inconclusive' : straight ? 'halo' : premultiplied ? 'safe' : unpackPremultiply ? 'inconclusive' : null;
    if (variant) {
      const nParam = premult.params?.n;
      const n = typeof nParam === 'number' ? nParam : (premult.relatedRefs?.length ?? 0);
      out.push(premultBlendFinding(variant, n, blendModeLabel(rt.blend) ?? 'unknown'));
    }
  }

  return {
    findings: out,
    summary: out.length
      ? `${out.length} correlated issue${out.length === 1 ? '' : 's'}: static structure + live GPU workload point to the same fixes.`
      : `No static↔runtime issues correlated — folder structure and live workload look consistent.`,
  };
}

/** Sum a measured before/after pair over the sheets where BOTH fields are finite — the honest
 *  comparison window. Pack pages (no source atlas) carry only an `*After`, so they are excluded:
 *  no honest before ⇒ no measured win (invariant 3). Returns null when no sheet qualifies. */
function sumMeasuredPair(
  sheets: MeasuredSheetDiff[],
  before: keyof MeasuredSheetDiff,
  after: keyof MeasuredSheetDiff,
): { before: number; after: number } | null {
  let b = 0;
  let a = 0;
  let n = 0;
  for (const s of sheets) {
    const bv = s[before];
    const av = s[after];
    if (typeof bv === 'number' && typeof av === 'number' && Number.isFinite(bv) && Number.isFinite(av)) {
      b += bv;
      a += av;
      n++;
    }
  }
  return n > 0 ? { before: b, after: a } : null;
}

/** correlateFix — turn the MEASURED before→after fix probe (apps/web `attachSheetProbes`:
 *  `SheetDiff.drawCalls*` / `decodedVram*`) into the SAME `CorrelatedFinding` shape + `batching`/`vram`
 *  rule families + `messageKey`/`params` discipline as `correlate()`, so `renderCorrelated` localizes
 *  these post-fix verdicts with no new finding type. The `variant:'measured'` tag routes the renderer
 *  to the `*_measured` templates ("measured N→M draw calls on your GPU this run").
 *
 *  HONESTY (the whole point): verdicts use ONLY measured numbers from the receipt. A field absent
 *  (no WebGL / no probe ran / pack page with no source atlas) ⇒ NO verdict — never a fabricated win.
 *  ADDITIVITY: empty/absent sheetDiffs ⇒ `[]` ⇒ the receipt UI is byte-identical to today.
 *  INVARIANT 5: the decoded-VRAM verdict uses distinct `decodedBefore`/`decodedAfter` params + the
 *  `variant:'measured'` tag and "distinct from the w·h·4 disk-side estimate" copy — NEVER folded into
 *  the static `vramBytes`/`w·h·4` saving. DETERMINISM: fixed iteration, fixed finding order
 *  (batching then vram), no `Date.now`/`Math.random`/locale formatting (that lives in `renderCorrelated`). */
export function correlateFix(receipt: FixProbeReceipt): CorrelatedFinding[] {
  const out: CorrelatedFinding[] = [];
  const sheets = receipt.sheetDiffs ?? [];

  // Batching — MEASURED issued draw calls before→after over sheets with BOTH probes.
  const draws = sumMeasuredPair(sheets, 'drawCallsBefore', 'drawCallsAfter');
  if (draws && draws.before > 0 && draws.after < draws.before) {
    const ratio = draws.after / draws.before;
    const severity: Severity = ratio <= FIX_BATCH_CRIT_RATIO ? 'crit' : ratio <= FIX_BATCH_WARN_RATIO ? 'warn' : 'info';
    out.push({
      id: 'corrfix:batching',
      rule: 'batching',
      severity,
      title: `${draws.before} → ${draws.after} draw calls — measured on this device`,
      staticEvidence: `the applied fix repacked the probed sheets`,
      runtimeEvidence: `measured ${draws.before} → ${draws.after} draw calls after the fix`,
      diagnosis: `Re-probing the repacked sheets on your GPU issued fewer draw calls — sprites now batch.`,
      fix: `Ship the repacked sheets; this batching win is measured, not estimated.`,
      estimate: { drawCallsAfter: draws.after },
      params: { drawCalls: draws.before, drawCallsAfter: draws.after, variant: 'measured' },
    });
  }

  // VRAM — MEASURED decoded texture VRAM before→after. Device-local ⇒ never crit; never folded into the
  // static w·h·4 saving (invariant 5): distinct params keys + the "distinct from w·h·4" copy.
  const vram = sumMeasuredPair(sheets, 'decodedVramBefore', 'decodedVramAfter');
  if (vram && vram.before > 0 && vram.after < vram.before) {
    out.push({
      id: 'corrfix:vram',
      rule: 'vram',
      severity: 'warn',
      title: `Decoded-texture VRAM ${fmtMB(vram.before)} → ${fmtMB(vram.after)} (measured, this device)`,
      staticEvidence: `the applied fix re-probed the sheets on your GPU`,
      runtimeEvidence: `measured decoded VRAM ${fmtMB(vram.before)} → ${fmtMB(vram.after)} after the fix`,
      diagnosis: `The repacked sheets decode to less GPU texture memory on this device — distinct from the w·h·4 disk-side estimate.`,
      fix: `Ship the repacked sheets; this decoded-VRAM reading is device-local, not a cross-device guarantee.`,
      estimate: { vramBytesSaved: vram.before - vram.after },
      params: { decodedBefore: vram.before, decodedAfter: vram.after, variant: 'measured' },
    });
  }

  return out;
}

export { compareRuntimeReports, parseRuntimeReport, parseSessionRuntime, COMPARE_DEFAULTS } from './compare';
export type { CompareOptions, CompareRow, CompareVerdict, CompareMetricClass, RuntimeComparison } from './compare';
