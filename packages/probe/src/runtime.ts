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
  };
}

interface FrameRec {
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
      return buildReport(recs, warmup, probes);
    },
  };
}

function buildReport(recs: FrameRec[], warmup: number, probes: InstrumentHandle[]): RuntimeReport {
  const play = recs.slice(warmup); // post-warmup "gameplay" frames
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
    hitches: hitches.slice(0, 20),
    timing: {
      fps: round1(dts.length ? 1000 / avg(dts) : 0),
      frameTimeMsAvg: round1(avg(dts)),
      frameTimeMsP95: round1(p95(dts)),
      deviceDependent: true,
    },
  };
}
