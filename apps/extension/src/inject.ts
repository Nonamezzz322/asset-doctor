// MAIN-world content script (run_at document_start). Installs the runtime profiler BEFORE the game's
// renderer initialises, then draws a live on-page HUD — visible only once a WebGL context is detected.
// Bundled into a single IIFE by build.mjs (esbuild) so it can be injected as a classic content script.

import { installRuntimeProfiler } from '@asset-doctor/probe/runtime';

const profiler = installRuntimeProfiler({ warmupFrames: 60 });

const hud = document.createElement('div');
hud.id = '__asset_doctor_hud';
hud.style.cssText = [
  'position:fixed',
  'top:8px',
  'right:8px',
  'z-index:2147483647',
  'background:rgba(12,17,22,0.92)',
  'color:#e7ecf1',
  'font:11px/1.45 ui-monospace,SFMono-Regular,monospace',
  'padding:8px 10px',
  'border:1px solid #0e8c8c',
  'border-radius:6px',
  'pointer-events:none',
  'white-space:pre',
  'display:none',
].join(';');

function mount(): void {
  (document.body || document.documentElement).appendChild(hud);
}
if (document.body) mount();
else document.addEventListener('DOMContentLoaded', mount, { once: true });

const fmt = (n: number): string => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

setInterval(() => {
  const r = profiler.report();
  const active = r.liveTextures > 0 || r.drawCalls.max > 0;
  hud.style.display = active ? 'block' : 'none';
  if (!active) return;
  hud.textContent =
    `▣ Asset Doctor · runtime\n` +
    `draw calls/frame  ${r.drawCalls.avg}  (max ${r.drawCalls.max})\n` +
    `redundant binds   ${r.redundantBinds}\n` +
    `VRAM ~${fmt(r.vramBytes)} · textures ${r.liveTextures}\n` +
    `hitch uploads ${r.uploadsDuringGameplay} · shaders ${r.shaderCompilesDuringGameplay}\n` +
    `fps ${r.timing.fps} · ${r.timing.frameTimeMsAvg}ms (device-dep)`;
}, 1000);
