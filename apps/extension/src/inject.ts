// MAIN-world content script (run_at document_start). Closes the moat IN the page: profiles the live
// renderer AND lets you load the game's asset folder, then correlates static structure × live GPU
// workload into one verdict — shown in a polished, LOCALIZED on-page overlay (minimise/close, language
// picker, severity colours, re-correlate, export). Bundled into one IIFE (~no pixi) by build.mjs.

import { installRuntimeProfiler, blendModeLabel } from '@asset-doctor/probe/runtime';
import { groupFiles, type RawFile } from '@asset-doctor/ingest';
import { parseAtlas, parseImage, parseSpinePage, type SpinePage } from '@asset-doctor/parsers';
import { analyze } from '@asset-doctor/analysis';
import { decodeImageFeatures, featureFromDecode, extractFrameRegions, FRAME_HASH_MAX_SPRITES, pageExceedsScanBudget } from '@asset-doctor/pixel';
import { correlate, type CorrelationReport } from '@asset-doctor/correlate';
import { detectLocale, isLocale, LOCALES, makeT, NATIVE_NAME, renderCorrelated, renderFinding, type Locale, type T } from '@asset-doctor/i18n';
import type { AnalysisReport, Asset, AtlasFrameHashes, Finding, ImageFeatures, Severity, Sprite } from '@asset-doctor/core';

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
  if (lastStatic) renderStatic(lastStatic);
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
// Static folder-audit findings (the SAME measured findings the web app shows) — computed off the loaded
// folder incl. the shared pixel-feature scan, so the feature-gated findings (solid/opaque/upscale/
// premultiplied/interior/binary/duplicate) are now VISIBLE here, not just fed to correlate. Scrolls so a
// large audit never blows out the compact overlay.
const staticEl = el('div', 'margin-top:6px;max-height:220px;overflow-y:auto');
staticEl.id = '__ad_static';
body.append(stats, actions, corr, staticEl);
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
  // P8: the MEASURED blend mode of the running game (only once a blend/pixelStorei was observed) — a
  // factual GL readout, not a verdict. The mode token is technical GL terminology (kept as-is in every
  // locale, like fps/RGBA8888); only the "blend" label is localized.
  const blend = blendModeLabel(r.blend);
  stats.textContent = [
    t('ext.hud.drawCalls', { avg: r.drawCalls.avg, max: r.drawCalls.max }),
    t('ext.hud.binds', { avg: r.textureBinds.avg, redundant: r.redundantBinds }),
    t('ext.hud.vram', { vram: fmt(r.vramBytes), textures: r.liveTextures }),
    t('ext.hud.hitches', { uploads: r.uploadsDuringGameplay, shaders: r.shaderCompilesDuringGameplay }),
    ...(blend ? [t('ext.hud.blend', { mode: blend })] : []),
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

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Per-atlas frame-region hashes — the SAME decoded-RGBA basis as the loose pixelHash (SHA-256 is universal,
 *  so an untrimmed frame's region hash equals a loose copy's pixelHash by construction). ONE
 *  createImageBitmap + getImageData per page; the pure extractFrameRegions does the caps / bounds / flat-guard
 *  / region extraction (identical to the web worker). Null (no OffscreenCanvas / decode fail / over-cap) ⇒ the
 *  atlas contributes no hashes ⇒ its relationship findings simply don't fire (deps-gated, honest). */
async function hashAtlasFrames(pageBytes: ArrayBuffer, sprites: Sprite[]): Promise<(string | null)[] | null> {
  if (typeof OffscreenCanvas === 'undefined' || sprites.length > FRAME_HASH_MAX_SPRITES) return null;
  try {
    const bmp = await createImageBitmap(new Blob([pageBytes]));
    const { width, height } = bmp;
    if (width <= 0 || height <= 0 || pageExceedsScanBudget(width, height)) {
      bmp.close();
      return null;
    }
    const canvas = new OffscreenCanvas(width, height);
    const c2d = canvas.getContext('2d', { willReadFrequently: true });
    if (!c2d) {
      bmp.close();
      return null;
    }
    c2d.drawImage(bmp, 0, 0);
    bmp.close();
    const page = c2d.getImageData(0, 0, width, height).data;
    const regions = extractFrameRegions(page, width, height, sprites.map((sp) => sp.frame));
    if (!regions) return null;
    const hashes: (string | null)[] = [];
    for (const region of regions) hashes.push(region === null ? null : await sha256Hex(region.buffer as ArrayBuffer));
    return hashes;
  } catch {
    return null;
  }
}

async function runAudit(list: FileList): Promise<void> {
  corr.replaceChildren(el('div', 'color:#9fb0bd', t('ext.corr.auditing')));
  const files: RawFile[] = [];
  for (const f of Array.from(list)) {
    if (!RELEVANT.test(f.name)) continue;
    files.push({ name: f.name, path: f.webkitRelativePath || f.name, bytes: await f.arrayBuffer() });
  }
  const grouped = groupFiles(files);
  const assets: Asset[] = [];
  const features: ImageFeatures[] = [];
  const frameHashes: AtlasFrameHashes[] = [];
  for (const a of grouped.atlases) {
    const img = { ref: a.name, bytes: new Uint8Array(a.image.bytes) };
    const r = a.kind === 'spine' ? parseSpinePage(a.manifest as SpinePage, img) : parseAtlas(a.manifest, img);
    if (!r.ok || r.asset.kind !== 'atlas') continue;
    assets.push(r.asset);
    // Frame-region hashes (same decoded-RGBA basis as the loose pixelHash) so the atlas-relationship
    // findings — cross-atlas-redundancy, frame-redundancy, loose-in-atlas — fire + display in the overlay.
    const hashes = await hashAtlasFrames(a.image.bytes, r.asset.atlas.sprites);
    if (hashes) frameHashes.push({ atlasRef: r.asset.atlas.name, frameHashes: hashes });
  }
  for (const im of grouped.images) {
    const ref = im.name.split('/').pop() ?? im.name;
    const r = parseImage(ref, new Uint8Array(im.bytes));
    if (!r.ok || r.asset.kind !== 'image') continue;
    assets.push(r.asset);
    // Same per-image pixel scan the web analyze worker runs (shared @asset-doctor/pixel: decode →
    // measurements → additive features), so the overlay surfaces the same feature-gated folder findings
    // (premultiplied-alpha, solid-fill, wasted-alpha, upscaled-source, interior-transparency, binary-alpha,
    // duplicate-exact) — closing the featureless-static gap and giving correlate the premultiplied input
    // its P8 blend capture needs. Loose-only pixel scan; atlas-page frame-hash deps stay web-only for now.
    const mime = r.asset.image.mime;
    const scanAlpha = mime === 'image/png' || mime === 'image/webp';
    // loose-in-atlas needs the loose pixelHash only when an atlas exists to match against ⇒ skip the full-res
    // SHA in a loose-only folder (byte-identical — that finding can never fire without frame hashes).
    const decoded = await decodeImageFeatures(im.bytes, scanAlpha, { pixelHash: grouped.atlases.length > 0 });
    features.push(featureFromDecode(ref, await sha256Hex(im.bytes), decoded));
  }
  lastStatic = await analyze(assets, undefined, { features, ...(frameHashes.length ? { frameHashes } : {}) });
  lastCorrelation = correlate(lastStatic, profiler.report());
  (window as unknown as { __assetDoctorCorrelation: CorrelationReport }).__assetDoctorCorrelation = lastCorrelation;
  renderCorrelation(lastCorrelation);
  renderStatic(lastStatic);
}

/** The static folder-audit findings, localized (the SAME renderFinding the web app uses). Title + fix per
 *  card — concise for the compact overlay; the full detail rides the exported session JSON. Findings arrive
 *  already severity-sorted from analyze; a crit-first list needs no re-sort here. */
function renderStatic(report: AnalysisReport): void {
  staticEl.replaceChildren();
  const findings: Finding[] = report.findings;
  if (!findings.length) return; // nothing measured — no section (the correlation area owns the empty state)
  staticEl.append(el('div', 'color:#566472;margin-bottom:2px', t('ext.static.header', { n: findings.length })));
  for (const f of findings) {
    const r = renderFinding(f, locale);
    const card = el('div', `border-left:2px solid ${SEV[f.severity]};padding-left:6px;margin:5px 0`);
    const titleEl = el('div', `color:${SEV[f.severity]};font-weight:bold`, `[${t(`severity.${f.severity}`)}] ${r.title}`);
    titleEl.setAttribute('data-sev', f.severity);
    card.append(titleEl);
    if (r.fix) card.append(el('div', 'color:#0e8c8c', `→ ${r.fix}`));
    staticEl.append(card);
  }
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
      if (lastStatic) renderStatic(lastStatic);
    }
  },
};
