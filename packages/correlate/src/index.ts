// @asset-doctor/correlate — the linter→doctor layer. Stitches a STATIC folder audit (AnalysisReport)
// and a LIVE runtime capture (RuntimeReport) into single verdicts: each correlated finding cites
// evidence from BOTH sources, names the diagnosis, and gives a fix + estimated effect. This is where
// the two halves of the moat become one diagnosis — neither static nor runtime alone could say it.

import type { AnalysisReport, Severity } from '@asset-doctor/core';
import type { RuntimeReport } from '@asset-doctor/probe/runtime';

export interface CorrelatedFinding {
  id: string;
  rule: 'batching' | 'vram' | 'upload-hitch' | 'shader-hitch' | 'redundant-state';
  severity: Severity;
  title: string;
  /** Proof from the folder audit. */
  staticEvidence: string;
  /** Proof from the live capture. */
  runtimeEvidence: string;
  diagnosis: string;
  fix: string;
  estimate?: { drawCallsAfter?: number; vramBytesSaved?: number; hitchMsSaved?: number };
}

export interface CorrelationReport {
  findings: CorrelatedFinding[];
  summary: string;
}

const DRAW_CALL_BUDGET = 50; // a healthy max draw-calls/frame for a 2D HTML5 game
const REDUNDANT_PER_FRAME = 5; // redundant binds/frame above this = state thrash
const fmtMB = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;

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
    const looseN = shouldAtlas?.relatedRefs?.length ?? 0;
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
    });
  }

  // R3 — upload hitches
  const uploadHitchMs = rt.hitches.filter((h) => h.cause === 'texture upload').reduce((s, h) => s + h.ms, 0);
  if (rt.uploadsDuringGameplay > 0 || uploadHitchMs > 0) {
    out.push({
      id: 'corr:upload-hitch',
      rule: 'upload-hitch',
      severity: 'warn',
      title: `${rt.uploadsDuringGameplay} texture uploads during gameplay`,
      staticEvidence: find('dimensions-oversize') ? `the build has oversized textures` : `large textures in the build`,
      runtimeEvidence: `${rt.uploadsDuringGameplay} uploads mid-game${uploadHitchMs ? `, ~${uploadHitchMs}ms of hitches` : ''}`,
      diagnosis: `Uploading textures to the GPU during play stalls the frame.`,
      fix: 'Pre-upload these textures on the loading screen (GPU pre-warm).',
      ...(uploadHitchMs ? { estimate: { hitchMsSaved: uploadHitchMs } } : {}),
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
    });
  }

  return {
    findings: out,
    summary: out.length
      ? `${out.length} correlated issue${out.length === 1 ? '' : 's'}: static structure + live GPU workload point to the same fixes.`
      : `No static↔runtime issues correlated — folder structure and live workload look consistent.`,
  };
}
