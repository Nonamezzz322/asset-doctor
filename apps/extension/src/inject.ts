// MAIN-world content script (run_at document_start). Closes the moat IN the page: profiles the live
// renderer AND lets you load the game's asset folder, then correlates static structure × live GPU
// workload into one verdict — shown in a polished, LOCALIZED on-page overlay (minimise/close, language
// picker, severity colours, re-correlate, export). Bundled into one IIFE (~no pixi) by build.mjs.

import { installRuntimeProfiler } from '@asset-doctor/probe/runtime';
import { groupFiles, type RawFile } from '@asset-doctor/ingest';
import { parseAtlas, parseImage, parseSpinePage, type SpinePage } from '@asset-doctor/parsers';
import { analyze } from '@asset-doctor/analysis';
import { correlate, type CorrelationReport } from '@asset-doctor/correlate';
import { detectLocale, isLocale, LOCALES, makeT, NATIVE_NAME, renderCorrelated, type Locale, type T } from '@asset-doctor/i18n';
import type { AnalysisReport, Asset, Severity } from '@asset-doctor/core';

const profiler = installRuntimeProfiler({ warmupFrames: 60 });
const fmt = (n: number): string => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const SEV: Record<Severity, string> = { crit: '#e5484d', warn: '#d98a00', ok: '#1f9d63', info: '#2b8fc9' };

let locale: Locale = detectLocale();
let t: T = makeT(locale);
let lastStatic: AnalysisReport | null = null;
let lastCorrelation: CorrelationReport | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

/* ── overlay ─────────────────────────────────────────────────────────── */
const ICON = 'cursor:pointer;background:transparent;color:#9fb0bd;border:0;font:13px ui-monospace,monospace;line-height:1;padding:0 2px';
const ACTION = 'cursor:pointer;background:#0e8c8c;color:#fff;border:0;border-radius:4px;padding:3px 6px;font:10px ui-monospace,monospace';

const root = el('div', [
  'position:fixed', 'top:8px', 'right:8px', 'z-index:2147483647', 'max-width:360px',
  'background:rgba(12,17,22,0.94)', 'color:#e7ecf1', 'font:11px/1.45 ui-monospace,monospace',
  'padding:8px 10px', 'border:1px solid #0e8c8c', 'border-radius:6px', 'display:none',
].join(';'));
root.id = '__asset_doctor_hud';

const header = el('div', 'display:flex;align-items:center;gap:6px');
const title = el('span', 'font-weight:bold;flex:1', '▣ Asset Doctor');
const langSel = el('select', 'background:#0c1116;color:#9fb0bd;border:1px solid #1b2530;border-radius:4px;font:10px ui-monospace,monospace');
for (const l of LOCALES) {
  const o = el('option', '', NATIVE_NAME[l]);
  o.value = l;
  if (l === locale) o.selected = true;
  langSel.append(o);
}
langSel.addEventListener('change', () => {
  if (!isLocale(langSel.value)) return;
  locale = langSel.value;
  t = makeT(locale);
  renderStats(profiler.report());
  if (lastCorrelation) renderCorrelation(lastCorrelation);
});
const minBtn = el('button', ICON, '–');
const closeBtn = el('button', ICON, '×');
header.append(title, langSel, minBtn, closeBtn);

const body = el('div', 'margin-top:6px');
const stats = el('pre', 'margin:0;white-space:pre');
const actions = el('div', 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px');
const loadBtn = el('button', ACTION);
const recorrBtn = el('button', ACTION);
const exportBtn = el('button', ACTION);
actions.append(loadBtn, recorrBtn, exportBtn);
const corr = el('div', 'margin-top:6px');
body.append(stats, actions, corr);
root.append(header, body);

function relabel(): void {
  loadBtn.textContent = t('ext.btn.load');
  recorrBtn.textContent = t('ext.btn.recorrelate');
  exportBtn.textContent = t('ext.btn.export');
}
relabel();

const input = el('input', 'display:none');
input.type = 'file';
input.multiple = true;
input.setAttribute('webkitdirectory', '');
input.addEventListener('change', () => {
  if (input.files) void runAudit(input.files);
});

let minimised = false;
let timer = 0;
minBtn.onclick = () => {
  minimised = !minimised;
  body.style.display = minimised ? 'none' : 'block';
  minBtn.textContent = minimised ? '+' : '–';
};
closeBtn.onclick = () => {
  clearInterval(timer);
  profiler.stop();
  root.remove();
};
loadBtn.onclick = () => input.click();
recorrBtn.onclick = () => {
  if (lastStatic) renderCorrelation((lastCorrelation = correlate(lastStatic, profiler.report())));
};
exportBtn.onclick = downloadSession;

function mount(): void {
  (document.body || document.documentElement).append(root, input);
}
if (document.body) mount();
else document.addEventListener('DOMContentLoaded', mount, { once: true });

/* ── live HUD ────────────────────────────────────────────────────────── */
function renderStats(r: ReturnType<typeof profiler.report>): void {
  stats.textContent = [
    t('ext.hud.drawCalls', { avg: r.drawCalls.avg, max: r.drawCalls.max }),
    t('ext.hud.binds', { avg: r.textureBinds.avg, redundant: r.redundantBinds }),
    t('ext.hud.vram', { vram: fmt(r.vramBytes), textures: r.liveTextures }),
    t('ext.hud.hitches', { uploads: r.uploadsDuringGameplay, shaders: r.shaderCompilesDuringGameplay }),
    t('ext.hud.fps', { fps: r.timing.fps, ms: r.timing.frameTimeMsAvg }),
  ].join('\n');
}
timer = window.setInterval(() => {
  const r = profiler.report();
  const active = r.liveTextures > 0 || r.drawCalls.max > 0;
  if (!root.isConnected) return;
  root.style.display = active ? 'block' : 'none';
  if (!active || minimised) return;
  renderStats(r);
}, 1000);

/* ── static audit + correlation ──────────────────────────────────────── */
const RELEVANT = /\.(json|atlas|png|webp|jpe?g|avif)$/i;

async function runAudit(list: FileList): Promise<void> {
  corr.replaceChildren(el('div', 'color:#9fb0bd', t('ext.corr.auditing')));
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
  lastStatic = await analyze(assets); // no features/encoder → no dup/format findings (not needed to correlate)
  lastCorrelation = correlate(lastStatic, profiler.report());
  (window as unknown as { __assetDoctorCorrelation: CorrelationReport }).__assetDoctorCorrelation = lastCorrelation;
  renderCorrelation(lastCorrelation);
}

function renderCorrelation(c: CorrelationReport): void {
  corr.replaceChildren();
  if (!c.findings.length) {
    corr.append(el('div', 'color:#1f9d63', `✓ ${t('corr.summaryNone')}`));
    return;
  }
  corr.append(el('div', 'color:#566472;margin-bottom:2px', t('ext.corr.header')));
  for (const f of c.findings) {
    const r = renderCorrelated(f, locale);
    const card = el('div', `border-left:2px solid ${SEV[f.severity]};padding-left:6px;margin:5px 0`);
    const titleEl = el('div', `color:${SEV[f.severity]};font-weight:bold`, `[${t(`severity.${f.severity}`)}] ${r.title}`);
    titleEl.setAttribute('data-sev', f.severity);
    card.append(titleEl);
    card.append(el('div', 'color:#aebac6', r.staticEvidence));
    card.append(el('div', 'color:#aebac6', r.runtimeEvidence));
    card.append(el('div', 'color:#0e8c8c', `→ ${r.fix}`));
    corr.append(card);
  }
}

function sessionJson(): string {
  return JSON.stringify(
    { url: location.href, locale, runtime: profiler.report(), correlation: lastCorrelation, staticFindings: lastStatic?.findings ?? [] },
    null,
    2,
  );
}

function downloadSession(): void {
  const a = el('a', 'display:none');
  a.href = URL.createObjectURL(new Blob([sessionJson()], { type: 'application/json' }));
  a.download = 'asset-doctor-session.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

// expose hooks for automation / testing
(window as unknown as { __assetDoctor: unknown }).__assetDoctor = {
  audit: runAudit,
  recorrelate: () => (lastStatic ? (lastCorrelation = correlate(lastStatic, profiler.report())) : null),
  export: sessionJson,
  runtime: () => profiler.report(),
  setLocale: (l: string) => {
    if (isLocale(l)) {
      locale = l;
      t = makeT(locale);
      langSel.value = l;
      renderStats(profiler.report());
      if (lastCorrelation) renderCorrelation(lastCorrelation);
    }
  },
};
