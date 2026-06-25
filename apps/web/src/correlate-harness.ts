// Dev-only end-to-end demo of the moat: a deliberately FRAGMENTED PixiJS scene (many distinct
// textures → poor batching) is profiled live, a STATIC audit of the same N loose sprites is run, and
// the two are correlated into one doctor's verdict. Served at /correlate.html.

import { installRuntimeProfiler } from '@asset-doctor/probe/runtime';
import { analyze } from '@asset-doctor/analysis';
import { correlate } from '@asset-doctor/correlate';
import type { Asset } from '@asset-doctor/core';
import { Application, Sprite, Texture } from 'pixi.js';

const profiler = installRuntimeProfiler({ warmupFrames: 30 });
const N = 128;

function colorTex(i: number): Texture {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = `hsl(${(i * 53) % 360}, 60%, 50%)`;
    ctx.fillRect(0, 0, 16, 16);
  }
  return Texture.from(c);
}

async function main(): Promise<void> {
  const app = new Application();
  await app.init({ width: 400, height: 300, preference: 'webgl', backgroundAlpha: 0, antialias: false });
  document.body.appendChild(app.canvas);

  // BAD on purpose: N DISTINCT textures → the renderer can't batch them into one draw.
  const sprites: Sprite[] = [];
  for (let i = 0; i < N; i++) {
    const s = new Sprite(colorTex(i));
    s.x = (i * 37) % 380;
    s.y = (i * 53) % 280;
    app.stage.addChild(s);
    sprites.push(s);
  }
  app.ticker.add(() => {
    for (const s of sprites) s.rotation += 0.03;
  });

  // STATIC audit of the same N loose sprites (→ a should-atlas finding).
  const assets: Asset[] = Array.from({ length: N }, (_, i) => ({
    kind: 'image',
    image: { name: `s${i}.png`, imageRef: `s${i}.png`, size: { w: 16, h: 16 }, mime: 'image/png', byteSize: 300 },
  }));
  const staticReport = await analyze(assets);

  setTimeout(() => {
    const runtime = profiler.report();
    const correlation = correlate(staticReport, runtime);
    const result = {
      runtime: { drawCalls: runtime.drawCalls, liveTextures: runtime.liveTextures },
      correlation,
    };
    (window as unknown as { __correlation: unknown }).__correlation = result;
    const out = document.getElementById('out');
    if (out) out.textContent = JSON.stringify(result, null, 2);
    profiler.stop();
  }, 2500);
}

void main().catch((e: unknown) => {
  (window as unknown as { __correlationError: string }).__correlationError = e instanceof Error ? e.message : String(e);
});
