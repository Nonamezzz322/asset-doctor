// Dev-only harness for the render-probe (served at /probe.html). Builds an atlas matching the
// tp-hash-symbols fixture in-browser, runs probeAtlas in real WebGL, and exposes the reading on
// window.__probe so a headless driver can read the actual draw calls + VRAM. Not part of the
// production build (only index.html is built).

import type { Rect } from '@asset-doctor/core';
import { probeAtlas } from '@asset-doctor/probe';

const FRAMES: Rect[] = [
  { x: 0, y: 0, w: 100, h: 100 },
  { x: 110, y: 0, w: 100, h: 100 },
  { x: 0, y: 110, w: 80, h: 120 },
  { x: 220, y: 0, w: 60, h: 90 },
  { x: 0, y: 240, w: 120, h: 120 },
];
const COLORS = ['#268bd2', '#cb4b16', '#859900', '#d33682', '#b58900'];

async function main(): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  FRAMES.forEach((f, i) => {
    ctx.fillStyle = COLORS[i % COLORS.length] ?? '#fff';
    ctx.fillRect(f.x, f.y, f.w, f.h);
  });

  const bmp = await createImageBitmap(canvas);
  const reading = await probeAtlas(bmp, FRAMES);
  (window as unknown as { __probe: unknown }).__probe = reading;
  const out = document.getElementById('out');
  if (out) out.textContent = JSON.stringify(reading, null, 2);
}

void main().catch((e: unknown) => {
  const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  (window as unknown as { __probeError: string }).__probeError = msg;
  const out = document.getElementById('out');
  if (out) out.textContent = 'ERROR: ' + msg;
});
