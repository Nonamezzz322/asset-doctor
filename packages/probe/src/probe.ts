// PixiJS v8 render-probe. Loads an atlas image into an offscreen WebGL renderer, draws its
// frames as sprites, and reads the ACTUAL GPU workload via the GL instrument. This is the
// differentiator static analyzers cannot replicate.
//
// NOTE: this path needs a real WebGL context (browser / extension). It typechecks against the
// Pixi v8 API and builds, but the live numbers must be confirmed by a browser run — see
// docs/render-probe-decision.md. The instrument it depends on IS unit-tested headless.

import { Application, Container, Rectangle, Sprite, Texture } from 'pixi.js';
import type { Rect } from '@asset-doctor/core';
import { instrument } from './gl-instrument';

export interface ProbeReading {
  drawCalls: number;
  vramBytes: number;
  liveTextures: number;
  textureUploads: number;
  shaderCompiles: number;
}

/** Render an atlas's frames once in offscreen WebGL and read the resulting GPU workload. */
export async function probeAtlas(
  source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  frames: Rect[],
): Promise<ProbeReading> {
  const app = new Application();
  await app.init({ width: 256, height: 256, preference: 'webgl', backgroundAlpha: 0, autoStart: false });

  const gl = (app.renderer as unknown as { gl?: WebGLRenderingContext | WebGL2RenderingContext }).gl;
  if (!gl) {
    app.destroy();
    throw new Error('render-probe requires the WebGL backend (got WebGPU or none)');
  }
  const probe = instrument(gl);

  const base = Texture.from(source);
  const stage = new Container();
  for (const f of frames) {
    const tex = new Texture({ source: base.source, frame: new Rectangle(f.x, f.y, f.w, f.h) });
    stage.addChild(new Sprite(tex));
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
