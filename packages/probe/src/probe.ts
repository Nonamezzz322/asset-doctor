// PixiJS v8 render-probe. Loads an atlas image into an offscreen WebGL renderer, draws its
// frames as sprites, and reads the ACTUAL GPU workload via the GL instrument. This is the
// differentiator static analyzers cannot replicate.
//
// NOTE: this path needs a real WebGL context (browser / extension) on the MAIN thread (Pixi's
// WebGL backend does not run in a worker). It typechecks against the Pixi v8 API and builds, but
// the live numbers must be confirmed by a browser run — see docs/render-probe-decision.md. The
// instrument it depends on IS unit-tested headless.

import { Application, Assets, Container, Rectangle, Sprite, Texture } from 'pixi.js';
import type { ProbeKtx2Reading, ProbeReading, Rect, Size } from '@asset-doctor/core';
import { instrument } from './gl-instrument';

// `ProbeReading` now lives in @asset-doctor/core (zero-dep) so AssetMetrics/AnalysisReport can carry
// a probe reading without core depending on probe. Re-export it here for back-compat — existing
// `import type { ProbeReading } from '@asset-doctor/probe'` consumers keep working unchanged. The GL
// instrument's `GlStats` stays an independent superset (untouched).
export type { ProbeReading } from '@asset-doctor/core';
// `ProbeKtx2Reading` likewise lives in core (zero-dep); re-export so probeKtx2 callers can `import type`
// it from @asset-doctor/probe alongside the function (mirrors ProbeReading).
export type { ProbeKtx2Reading } from '@asset-doctor/core';

/** Largest probe canvas edge we will allocate. Real atlases are clamped to this so a 4096²/8192²
 *  source still draws on-canvas (drawCalls correct) without allocating a huge framebuffer. */
const MAX_PROBE_DIM = 2048;

/**
 * Render an atlas's frames once in offscreen WebGL and read the resulting GPU workload.
 *
 * BLOCKER2 fix: the probe Application is sized to the atlas (`size`, clamped to MAX_PROBE_DIM) so
 * real atlas frames at large coordinates land ON-canvas instead of off the fixed-256² viewport —
 * and child culling is disabled — so the draw call is actually issued (drawCalls >= 1) rather than
 * scissored/culled to 0. `size` is additive & defaulted: omitted ⇒ the old 256² behavior. The
 * texture upload (and thus vramBytes/liveTextures) is viewport-independent and was already correct.
 */
export async function probeAtlas(
  source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  frames: Rect[],
  size?: Size,
): Promise<ProbeReading> {
  // Clamp the probe canvas to the atlas size (≤ MAX_PROBE_DIM); default to 256² when no size given.
  const w = size ? Math.max(1, Math.min(Math.round(size.w), MAX_PROBE_DIM)) : 256;
  const h = size ? Math.max(1, Math.min(Math.round(size.h), MAX_PROBE_DIM)) : 256;

  const app = new Application();
  await app.init({ width: w, height: h, preference: 'webgl', backgroundAlpha: 0, autoStart: false });

  const gl = (app.renderer as unknown as { gl?: WebGLRenderingContext | WebGL2RenderingContext }).gl;
  if (!gl) {
    app.destroy();
    throw new Error('render-probe requires the WebGL backend (got WebGPU or none)');
  }
  const probe = instrument(gl);

  const base = Texture.from(source);
  const stage = new Container();
  // Defensively disable culling: in Pixi v8 a plain renderer.render() does not cull, but make sure a
  // future CullerPlugin or off-canvas frame can never drop the draw the probe exists to count.
  stage.cullableChildren = false;
  for (const f of frames) {
    const tex = new Texture({ source: base.source, frame: new Rectangle(f.x, f.y, f.w, f.h) });
    const sprite = new Sprite(tex);
    sprite.cullable = false;
    stage.addChild(sprite);
  }

  probe.reset();
  app.renderer.render(stage);
  const stats = probe.stats();

  probe.restore();
  app.destroy();

  return {
    drawCalls: stats.drawCalls,
    vramBytes: stats.vramBytes,
    liveTextures: stats.liveTextures,
    textureUploads: stats.textureUploads,
    shaderCompiles: stats.shaderCompiles,
  };
}

/** Same-origin URLs of the SELF-HOSTED Pixi KTX2 transcoder (round15 T4a / CORRECTION-1). Pixi v8's KTX2
 *  loader DEFAULTS to a jsdelivr CDN fetch (https://cdn.jsdelivr.net/npm/pixi.js/transcoders/ktx/libktx.*)
 *  — a silent third-party network call that breaks offline + violates the project's zero-network honesty.
 *  The caller (the web app, which owns its served-asset URLs + Vite base) passes these LOCAL URLs so we
 *  call setKTXTranscoderPath to same-origin assets BEFORE the first probe and NEVER hit jsdelivr. */
export interface Ktx2TranscoderPaths {
  jsUrl: string;
  wasmUrl: string;
}

let ktx2TranscoderReady: Promise<void> | undefined;
/** One-time, memoized: point Pixi's KTX2 transcoder at the self-hosted assets (CORRECTION-1) then register
 *  the `loadKTX2` parser via the `pixi.js/ktx2` subpath. Lazy + idempotent — the import + path set happen at
 *  most once per page, before any transcode. */
async function ensureKtx2Loader(paths: Ktx2TranscoderPaths): Promise<void> {
  if (!ktx2TranscoderReady) {
    ktx2TranscoderReady = (async () => {
      const { setKTXTranscoderPath } = await import('pixi.js');
      // SELF-HOST: override the jsdelivr default with same-origin URLs (must precede the first loadKTX2).
      setKTXTranscoderPath({ jsUrl: paths.jsUrl, wasmUrl: paths.wasmUrl });
      // Registers the `loadKTX2` Assets parser + `getSupportedTextureFormats` (lazy subpath, code-split).
      await import('pixi.js/ktx2');
    })();
  }
  return ktx2TranscoderReady;
}

/**
 * Measure the REAL resident GPU VRAM of a produced `.ktx2` page on THE PROBING DEVICE — by transcoding it
 * through Pixi's KTX2 loader in an offscreen WebGL renderer and summing the actual `compressedTexImage2D`
 * byteLengths (incl. baked mip levels) via the GL instrument. Mirrors `probeAtlas` (offscreen + abort +
 * MAX_PROBE_DIM clamp). The number is DEVICE-LOCAL ONLY (the GPU's chosen transcode target AND whether the
 * transcoder loaded both move it) — the caller surfaces it BESIDE the worst-case ceiling, NEVER as a hard
 * or cross-device VRAM claim (invariants 3 & 5).
 *
 * HONESTY: when this GPU has no block-compression support, OR the transcoder failed to load / the asset
 * 404'd, OR the render produced zero compressed bytes, the loader falls back to a raster texture ⇒ we
 * report `fallback:true` with `compressedBytes === rasterBaselineBytes` (no win on this device). The probe
 * NEVER throws to bury a CDN fetch: when no usable WebGL context exists it throws (the caller swallows),
 * and any transcode failure becomes an honest fallback reading.
 *
 * NO NETWORK: `transcoder` MUST point at self-hosted same-origin URLs (T4a). Passing none / a jsdelivr URL
 * would reintroduce the CDN fetch — the web-app caller always passes its local `/transcoders/ktx/*`.
 *
 * @param ktx2Bytes    the produced `.ktx2` page bytes.
 * @param rasterSource the SAME page decoded as raster — its w·h·4 is the honest "before" baseline.
 * @param transcoder   same-origin URLs of the self-hosted libktx.js/.wasm (required; never jsdelivr).
 * @param signal       optional abort: a stale probe can be cancelled by a fresh fix run.
 */
export async function probeKtx2(
  ktx2Bytes: ArrayBuffer,
  rasterSource: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  transcoder: Ktx2TranscoderPaths,
  signal?: AbortSignal,
): Promise<ProbeKtx2Reading> {
  // Self-host the transcoder + register loadKTX2 BEFORE any GL work (memoized; CORRECTION-1).
  await ensureKtx2Loader(transcoder);
  if (signal?.aborted) throw new Error('ktx2 probe aborted');

  // A small fixed canvas is fine: the texture UPLOAD (and thus compressedBytes/vramBytes) is viewport-
  // independent — we measure residency, not coverage — exactly the probeAtlas note. Clamped well under
  // MAX_PROBE_DIM so a huge page never allocates a big framebuffer.
  const app = new Application();
  await app.init({ width: 256, height: 256, preference: 'webgl', backgroundAlpha: 0, autoStart: false });

  const gl = (app.renderer as unknown as { gl?: WebGLRenderingContext | WebGL2RenderingContext }).gl;
  if (!gl) {
    app.destroy();
    throw new Error('ktx2 probe requires the WebGL backend (got WebGPU or none)');
  }
  const probe = instrument(gl);

  // ── (1) Raster baseline: the SAME page as RGBA8888 (w·h·4) — the honest "before". ──
  let rasterBaselineBytes = 0;
  {
    const rasterTex = Texture.from(rasterSource);
    const stage = new Container();
    stage.cullableChildren = false;
    const sprite = new Sprite(rasterTex);
    sprite.cullable = false;
    stage.addChild(sprite);
    probe.reset();
    app.renderer.render(stage);
    rasterBaselineBytes = probe.stats().vramBytes;
    sprite.destroy();
    rasterTex.destroy(true); // free the raster upload so it can't bleed into the compressed measure
  }

  // ── (2) Compressed measure: transcode the .ktx2 via loadKTX2 and read compressedTexImage2D byteLengths. ──
  let compressedBytes = 0;
  let fallback = false;
  const url = URL.createObjectURL(new Blob([ktx2Bytes], { type: 'image/ktx2' }));
  let loaded = false;
  try {
    if (signal?.aborted) throw new Error('ktx2 probe aborted');
    const tex = (await Assets.load({ src: url, loadParser: 'loadKTX2' })) as Texture;
    loaded = true;
    const stage = new Container();
    stage.cullableChildren = false;
    const sprite = new Sprite(tex);
    sprite.cullable = false;
    stage.addChild(sprite);
    probe.reset();
    app.renderer.render(stage);
    compressedBytes = probe.stats().compressedBytes;
    sprite.destroy();
    // HONEST fallback: the loader gave a raster texture (no block-compression support / transcoder failed)
    // ⇒ no compressed upload was seen ⇒ this is NOT a win on this device.
    if (compressedBytes <= 0) {
      fallback = true;
      compressedBytes = rasterBaselineBytes;
    }
  } catch {
    // Transcoder unavailable / asset rejected ⇒ honest fallback, NEVER a throw that hides a CDN regression.
    fallback = true;
    compressedBytes = rasterBaselineBytes;
  } finally {
    if (loaded) {
      try {
        await Assets.unload(url);
      } catch {
        /* unload best-effort */
      }
    }
    URL.revokeObjectURL(url);
    probe.restore();
    app.destroy();
  }

  return { compressedBytes, rasterBaselineBytes, fallback };
}
