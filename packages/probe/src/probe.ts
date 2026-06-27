// PixiJS v8 render-probe. Loads an atlas image into an offscreen WebGL renderer, draws its
// frames as sprites, and reads the ACTUAL GPU workload via the GL instrument. This is the
// differentiator static analyzers cannot replicate.
//
// NOTE: this path needs a real WebGL context (browser / extension) on the MAIN thread (Pixi's
// WebGL backend does not run in a worker). It typechecks against the Pixi v8 API and builds, but
// the live numbers must be confirmed by a browser run — see docs/render-probe-decision.md. The
// instrument it depends on IS unit-tested headless.

import { Application, Container, Rectangle, Sprite, Texture } from 'pixi.js';
import type { ProbeReading, Rect, Size } from '@asset-doctor/core';
import { instrument } from './gl-instrument';

// `ProbeReading` now lives in @asset-doctor/core (zero-dep) so AssetMetrics/AnalysisReport can carry
// a probe reading without core depending on probe. Re-export it here for back-compat — existing
// `import type { ProbeReading } from '@asset-doctor/probe'` consumers keep working unchanged. The GL
// instrument's `GlStats` stays an independent superset (untouched).
export type { ProbeReading } from '@asset-doctor/core';

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
