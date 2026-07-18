// Runtime profiler SDK — the moat's runtime half. Installed INTO a live game (as a snippet, or
// injected by a browser extension) BEFORE the renderer initialises. It:
//   1. patches HTMLCanvasElement.getContext → instruments the game's real WebGL context (Spector-style),
//   2. wraps requestAnimationFrame → captures per-frame GPU workload right after each render,
// then reports structural (device-independent) metrics + clearly-labelled timing (device-dependent).

import { instrument, type GlStats, type InstrumentHandle } from './gl-instrument';

/** Sum live stats across every instrumented context (some games create a throwaway probe context). */
function aggregate(probes: InstrumentHandle[]): GlStats {
  let drawElementsCalls = 0;
  let drawArraysCalls = 0;
  let textureBinds = 0;
  let redundantTexBinds = 0;
  let textureUploads = 0;
  let shaderCompiles = 0;
  let programLinks = 0;
  let programBinds = 0;
  let redundantProgBinds = 0;
  let liveTextures = 0;
  let vramBytes = 0;
  let compressedBytes = 0;
  let blendPremultiplied = false;
  let blendStraight = false;
  let unpackPremultiply = false;
  for (const p of probes) {
    const s = p.stats();
    drawElementsCalls += s.drawElementsCalls;
    drawArraysCalls += s.drawArraysCalls;
    textureBinds += s.textureBinds;
    redundantTexBinds += s.redundantTexBinds;
    textureUploads += s.textureUploads;
    shaderCompiles += s.shaderCompiles;
    programLinks += s.programLinks;
    programBinds += s.programBinds;
    redundantProgBinds += s.redundantProgBinds;
    liveTextures += s.liveTextures;
    vramBytes += s.vramBytes;
    compressedBytes += s.compressedBytes;
    // Blend config is OR-aggregated across contexts (a mode seen in any probe was seen).
    blendPremultiplied ||= s.blendPremultiplied;
    blendStraight ||= s.blendStraight;
    unpackPremultiply ||= s.unpackPremultiply;
  }
  return {
    drawCalls: drawElementsCalls + drawArraysCalls,
    drawElementsCalls,
    drawArraysCalls,
    textureBinds,
    redundantTexBinds,
    textureUploads,
    shaderCompiles,
    programLinks,
    programBinds,
    redundantProgBinds,
    liveTextures,
    vramBytes,
    compressedBytes,
    blendPremultiplied,
    blendStraight,
    unpackPremultiply,
  };
}

export interface FrameRec {
  dt: number;
  draws: number;
  binds: number;
  redundant: number;
  uploads: number;
  compiles: number;
}

export interface RuntimeReport {
  frames: number;
  durationMs: number;
  // ── structural / GPU-workload (device-independent) ──
  drawCalls: { avg: number; max: number };
  textureBinds: { avg: number; max: number };
  redundantBinds: number;
  uploadsDuringGameplay: number;
  shaderCompilesDuringGameplay: number;
  liveTextures: number;
  vramBytes: number;
  /** Of `vramBytes`, the portion resident in a BLOCK-COMPRESSED format (BC/ETC/ASTC via KTX2), summed
   *  from the real compressedTexImage2D data byteLengths (device-MEASURED, incl. baked mips) — NOT a
   *  w·h·4 model. A subset of vramBytes (a compressed texture contributes THIS, not w·h·4). 0 = the
   *  instrument observed no compressed uploads (a real measured fact — e.g. a KTX2 build that fell back
   *  to raster on this device). OPTIONAL: absent when reading an OLDER exported session that predates
   *  this field (undefined = "not recorded", which the A/B comparer treats differently from a measured 0). */
  compressedBytes?: number;
  /** OBSERVED alpha-blend configuration of the running renderer (P8, gl-instrument GlStats). A MEASURED
   *  device-independent fact of the app's own GL calls — never interpreted here. `premultiplied`/`straight`
   *  are whether a premultiplied-style (srcRGB=ONE) / straight-style (srcRGB=SRC_ALPHA) blend was EVER
   *  seen (both true ⇒ mixed passes); `unpackPremultiply` ⇒ WebGL premultiplied on upload was ever set.
   *  It is the V3-reopen precondition for a premultiplied-alpha × runtime verdict. OPTIONAL: absent from an
   *  OLDER exported session predating this field (undefined = "not recorded"). */
  blend?: { premultiplied: boolean; straight: boolean; unpackPremultiply: boolean };
  hitches: { frame: number; ms: number; cause: string }[];
  // ── timing (only trustworthy on the real target device) ──
  timing: { fps: number; frameTimeMsAvg: number; frameTimeMsP95: number; deviceDependent: true };
}

export interface RuntimeProfiler {
  report(): RuntimeReport;
  frameCount(): number;
  stop(): void;
}

type GetContext = (this: HTMLCanvasElement, type: string, ...args: unknown[]) => unknown;
const now = (): number => performance.now();
const round1 = (n: number): number => Math.round(n * 10) / 10;

export function installRuntimeProfiler(
  opts: { warmupFrames?: number; maxFrames?: number } = {},
): RuntimeProfiler {
  const warmup = opts.warmupFrames ?? 30;
  const maxFrames = opts.maxFrames ?? 1800; // rolling window (~30s @60fps) so a long session stays bounded
  const probes: InstrumentHandle[] = [];
  const seen = new Set<unknown>();
  let stopped = false;
  const recs: FrameRec[] = [];
  // Absolute frames captured this session (NEVER decremented — recs is a rolling window that shifts out old
  // frames). Anchors the warmup skip to session START, so a session longer than maxFrames does not re-apply
  // warmup to steady-state gameplay frames that merely happen to sit at the front of the window.
  let totalFrames = 0;
  let lastT = now();

  // 1) instrument EVERY WebGL context (games often create a throwaway capability-probe context first)
  const origGetContext = HTMLCanvasElement.prototype.getContext as unknown as GetContext;
  function patchedGetContext(this: HTMLCanvasElement, type: string, ...rest: unknown[]): unknown {
    const ctx = origGetContext.call(this, type, ...rest);
    if (ctx && !seen.has(ctx) && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
      seen.add(ctx);
      probes.push(instrument(ctx as WebGLRenderingContext));
    }
    return ctx;
  }
  HTMLCanvasElement.prototype.getContext = patchedGetContext as unknown as typeof HTMLCanvasElement.prototype.getContext;

  // 2) capture per-frame stats right after each rAF render callback
  const origRaf = window.requestAnimationFrame.bind(window);
  const patchedRaf = (cb: FrameRequestCallback): number =>
    origRaf((t) => {
      cb(t); // the game renders → draw calls / binds / uploads issued
      if (probes.length && !stopped) {
        const s = aggregate(probes);
        const t2 = now();
        recs.push({
          dt: t2 - lastT,
          draws: s.drawCalls,
          binds: s.textureBinds,
          redundant: s.redundantTexBinds + s.redundantProgBinds,
          uploads: s.textureUploads,
          compiles: s.shaderCompiles,
        });
        totalFrames++;
        if (recs.length > maxFrames) recs.shift();
        lastT = t2;
        for (const p of probes) p.reset();
      }
    });
  window.requestAnimationFrame = patchedRaf;

  return {
    frameCount: () => recs.length,
    stop() {
      stopped = true;
      HTMLCanvasElement.prototype.getContext = origGetContext as unknown as typeof HTMLCanvasElement.prototype.getContext;
      window.requestAnimationFrame = origRaf;
      for (const p of probes) p.restore();
    },
    report() {
      return buildReport(recs, warmup, probes, totalFrames);
    },
  };
}

/** Pure report builder over the rolling frame window (exported for unit testing — `recs` is the current
 *  window, `totalFrames` the absolute session frame count so warmup anchors to session start). */
export function buildReport(recs: FrameRec[], warmup: number, probes: InstrumentHandle[], totalFrames: number): RuntimeReport {
  // Warmup is anchored to session START, not the window: frames already shifted out of the rolling window
  // (totalFrames − recs.length) count toward the warmup skip, so once the whole warmup phase has scrolled
  // off, the entire window is gameplay (effWarmup 0) instead of perpetually re-skipping real gameplay frames.
  const shiftedOut = totalFrames - recs.length;
  const effWarmup = Math.max(0, warmup - shiftedOut);
  const play = recs.slice(effWarmup); // post-warmup "gameplay" frames
  const dts = play.map((r) => r.dt).filter((d) => d > 0);
  const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
  const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);
  const p95 = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]!;
  };
  const sortedDt = [...dts].sort((a, b) => a - b);
  const medianDt = sortedDt.length ? sortedDt[Math.floor(sortedDt.length / 2)]! : 0;
  const stats = aggregate(probes);
  // Per-frame call averages are taken over RENDERED frames only (a render loop can schedule extra
  // rAF callbacks that issue no draws — averaging over those would understate the real workload).
  const rendered = play.filter((r) => r.draws > 0);

  const hitches = play
    .filter((r) => medianDt > 0 && r.dt > medianDt * 2 && r.dt > 16)
    .map((r) => ({
      frame: recs.indexOf(r),
      ms: Math.round(r.dt),
      cause: r.uploads > 0 ? 'texture upload' : r.compiles > 0 ? 'shader compile' : 'cpu/gpu spike',
    }));

  return {
    frames: recs.length,
    durationMs: Math.round(sum(recs.map((r) => r.dt))),
    drawCalls: { avg: round1(avg(rendered.map((r) => r.draws))), max: max(play.map((r) => r.draws)) },
    textureBinds: { avg: round1(avg(rendered.map((r) => r.binds))), max: max(play.map((r) => r.binds)) },
    redundantBinds: sum(play.map((r) => r.redundant)),
    uploadsDuringGameplay: sum(play.map((r) => r.uploads)),
    shaderCompilesDuringGameplay: sum(play.map((r) => r.compiles)),
    liveTextures: stats?.liveTextures ?? 0,
    vramBytes: stats?.vramBytes ?? 0,
    compressedBytes: stats?.compressedBytes ?? 0, // device-measured; the live path always records it (0 = no compressed uploads seen)
    // Observed blend config (P8) — the live path always records it (all-false = no blend/pixelStorei seen).
    blend: {
      premultiplied: stats?.blendPremultiplied ?? false,
      straight: stats?.blendStraight ?? false,
      unpackPremultiply: stats?.unpackPremultiply ?? false,
    },
    hitches: hitches.slice(0, 20),
    timing: {
      fps: round1(dts.length ? 1000 / avg(dts) : 0),
      frameTimeMsAvg: round1(avg(dts)),
      frameTimeMsP95: round1(p95(dts)),
      deviceDependent: true,
    },
  };
}

/** Pure, presentation-neutral label for an OBSERVED blend config (RuntimeReport.blend) — a stable
 *  technical token the extension HUD / any surface renders beside a translated "blend" label. null when
 *  nothing blend-related was observed (no line to show). Never a verdict, just the measured mode:
 *   • 'mixed'          — both straight AND premultiplied blends were seen (per-pass variation);
 *   • 'straight-alpha' — only straight (srcRGB=SRC_ALPHA) was seen;
 *   • 'premultiplied'  — only premultiplied (srcRGB=ONE) was seen;
 *   • 'upload-premultiplied' — no blendFunc classified, but UNPACK_PREMULTIPLY_ALPHA was set.
 *  The '+upload-premultiply' suffix is appended whenever unpackPremultiply is set alongside a blend mode. */
export function blendModeLabel(blend: RuntimeReport['blend']): string | null {
  if (!blend) return null;
  const { premultiplied, straight, unpackPremultiply } = blend;
  let mode: string | null = null;
  if (premultiplied && straight) mode = 'mixed';
  else if (straight) mode = 'straight-alpha';
  else if (premultiplied) mode = 'premultiplied';
  else if (unpackPremultiply) mode = 'upload-premultiplied';
  if (mode === null) return null;
  return unpackPremultiply && mode !== 'upload-premultiplied' ? `${mode} +upload-premultiply` : mode;
}
