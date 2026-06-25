// Dev-only harness for the runtime profiler (served at /runtime.html). Installs the profiler
// FIRST, then runs a live animated PixiJS scene so a headless driver can read real per-frame
// GPU-workload metrics from an actual renderer. Not part of the production build.

import { installRuntimeProfiler } from '@asset-doctor/probe';
import { Application, Sprite, Texture } from 'pixi.js';

const profiler = installRuntimeProfiler({ warmupFrames: 20 });

function colorTex(color: string): Texture {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 32, 32);
  }
  return Texture.from(c);
}

async function main(): Promise<void> {
  const app = new Application();
  await app.init({ width: 400, height: 300, preference: 'webgl', backgroundAlpha: 0, antialias: false });
  document.body.appendChild(app.canvas);

  const texs = ['#268bd2', '#cb4b16', '#859900'].map(colorTex);
  const sprites: Sprite[] = [];
  for (let i = 0; i < 60; i++) {
    const s = new Sprite(texs[i % texs.length]!);
    s.x = (i * 37) % 380;
    s.y = (i * 53) % 280;
    app.stage.addChild(s);
    sprites.push(s);
  }
  app.ticker.add(() => {
    for (const s of sprites) {
      s.rotation += 0.05;
      s.x = (s.x + 1) % 400;
    }
  });

  setTimeout(() => {
    (window as unknown as { __runtime: unknown }).__runtime = profiler.report();
    const out = document.getElementById('out');
    if (out) out.textContent = JSON.stringify((window as unknown as { __runtime: unknown }).__runtime, null, 2);
    profiler.stop();
  }, 2500);
}

void main().catch((e: unknown) => {
  (window as unknown as { __runtimeError: string }).__runtimeError = e instanceof Error ? e.message : String(e);
});
