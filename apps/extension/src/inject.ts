// MAIN-world content script (run_at document_start). Closes the moat IN the page: it profiles the
// live renderer AND lets you load the game's asset folder, then correlates static structure × live
// GPU workload into one verdict — shown in an on-page overlay. Bundled into one IIFE by build.mjs.

import { installRuntimeProfiler } from '@asset-doctor/probe/runtime';
import { groupFiles, type RawFile } from '@asset-doctor/ingest';
import { parseAtlas, parseImage, parseSpinePage, type SpinePage } from '@asset-doctor/parsers';
import { analyze } from '@asset-doctor/analysis';
import { correlate, type CorrelationReport } from '@asset-doctor/correlate';
import type { Asset } from '@asset-doctor/core';

const profiler = installRuntimeProfiler({ warmupFrames: 60 });
const fmt = (n: number): string => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/* ── overlay ─────────────────────────────────────────────────────────── */
const root = document.createElement('div');
root.id = '__asset_doctor_hud';
root.style.cssText = [
  'position:fixed', 'top:8px', 'right:8px', 'z-index:2147483647', 'max-width:340px',
  'background:rgba(12,17,22,0.94)', 'color:#e7ecf1', 'font:11px/1.45 ui-monospace,monospace',
  'padding:8px 10px', 'border:1px solid #0e8c8c', 'border-radius:6px', 'white-space:pre-wrap', 'display:none',
].join(';');

const stats = document.createElement('pre');
stats.style.cssText = 'margin:0;white-space:pre';
const btn = document.createElement('button');
btn.textContent = '▶ load asset folder & correlate';
btn.style.cssText = 'margin:6px 0 0;cursor:pointer;background:#0e8c8c;color:#fff;border:0;border-radius:4px;padding:3px 6px;font:11px ui-monospace,monospace';
const corr = document.createElement('pre');
corr.style.cssText = 'margin:6px 0 0;white-space:pre-wrap;color:#e7ecf1';
root.append(stats, btn, corr);

const input = document.createElement('input');
input.type = 'file';
input.multiple = true;
input.setAttribute('webkitdirectory', '');
input.style.display = 'none';
input.addEventListener('change', () => {
  if (input.files) void runAudit(input.files);
});
btn.onclick = () => input.click();

function mount(): void {
  (document.body || document.documentElement).append(root, input);
}
if (document.body) mount();
else document.addEventListener('DOMContentLoaded', mount, { once: true });

/* ── live HUD ────────────────────────────────────────────────────────── */
setInterval(() => {
  const r = profiler.report();
  const active = r.liveTextures > 0 || r.drawCalls.max > 0;
  root.style.display = active ? 'block' : 'none';
  if (!active) return;
  stats.textContent =
    `▣ Asset Doctor · runtime\n` +
    `draw calls/frame  ${r.drawCalls.avg}  (max ${r.drawCalls.max})\n` +
    `texture binds/frame ${r.textureBinds.avg} · redundant ${r.redundantBinds}\n` +
    `VRAM ~${fmt(r.vramBytes)} · textures ${r.liveTextures}\n` +
    `hitch uploads ${r.uploadsDuringGameplay} · shaders ${r.shaderCompilesDuringGameplay}\n` +
    `fps ${r.timing.fps} · ${r.timing.frameTimeMsAvg}ms (device-dep)`;
}, 1000);

/* ── static audit + correlation ──────────────────────────────────────── */
const RELEVANT = /\.(json|atlas|png|webp|jpe?g|avif)$/i;

async function runAudit(list: FileList): Promise<void> {
  corr.textContent = 'auditing folder…';
  const files: RawFile[] = [];
  for (const f of Array.from(list)) {
    if (!RELEVANT.test(f.name)) continue;
    files.push({ name: f.name, path: f.webkitRelativePath || f.name, bytes: await f.arrayBuffer() });
  }
  const grouped = groupFiles(files);
  const assets: Asset[] = [];
  for (const a of grouped.atlases) {
    const img = { ref: a.name, bytes: new Uint8Array(a.image.bytes) };
    const r = a.kind === 'spine' ? parseSpinePage(a.manifest as SpinePage, img) : parseAtlas(a.manifest, img);
    if (r.ok && r.asset.kind === 'atlas') assets.push(r.asset);
  }
  for (const im of grouped.images) {
    const r = parseImage(im.name.split('/').pop() ?? im.name, new Uint8Array(im.bytes));
    if (r.ok && r.asset.kind === 'image') assets.push(r.asset);
  }
  const staticReport = await analyze(assets); // no features/encoder → no dup/format findings (not needed for correlation)
  const c = correlate(staticReport, profiler.report());
  (window as unknown as { __assetDoctorCorrelation: CorrelationReport }).__assetDoctorCorrelation = c;
  render(c);
}

function render(c: CorrelationReport): void {
  if (!c.findings.length) {
    corr.textContent = `✓ ${c.summary}`;
    return;
  }
  corr.textContent =
    `── doctor (static × runtime) ──\n` +
    c.findings
      .map((f) => `[${f.severity}] ${f.title}\n  static: ${f.staticEvidence}\n  live:   ${f.runtimeEvidence}\n  → ${f.fix}`)
      .join('\n');
}

// expose a hook for automation / testing
(window as unknown as { __assetDoctor: { audit(list: FileList): Promise<void> } }).__assetDoctor = {
  audit: runAudit,
};
