import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisReport, BundleAvailability, LazyMarking, ScaleTier, SkinGuard } from '@asset-doctor/core';
import type { PackMode, StaticGranularity } from '@asset-doctor/ingest';
import { bundleOf, cmp } from '@asset-doctor/analysis';
import { DEFAULT_SCALE_TIERS } from '@asset-doctor/fix';
import {
  filesFromDataTransfer,
  filesFromInput,
  pickFolder,
  supportsDirectoryPicker,
  type PickedFile,
} from './lib/import';
import { keyOf } from './lib/group';
import { runAnalysis, type Progress } from './lib/worker-client';
import { planFix, runFix, type FixOutcome, type FixProgress } from './lib/fix-client';
import type { FixOptions, FixPlanSummary, FixReceipt } from './worker/fix-protocol';
import { fmtBytes, SEVERITY_TEXT } from './lib/format';
import { groupOps, OP_KIND_ORDER, REFERENCE_CHANGING, type OpKind } from './lib/op-manifest';
import { LOCALES, NATIVE_NAME, useI18n } from './lib/i18n';
import { isProUnlocked, maybeRefresh, PRO_GATE_ENABLED } from './lib/license';
import { ActivatePanel, ProBadge } from './components/LicensePanel';
import { FilmViewer } from './components/FilmViewer';
import { Findings } from './components/Findings';
import { FolderReport } from './components/FolderReport';

type Phase =
  | { t: 'idle' }
  | { t: 'analyzing'; progress?: Progress }
  | { t: 'done' }
  | { t: 'error'; message: string };

function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9.2" stroke="#0E8C8C" strokeWidth="1.8" />
      <path d="M12 6.5v11M6.5 12h11" stroke="#0E8C8C" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function App() {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>({ t: 'idle' });
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<string | undefined>();
  const [selectedFinding, setSelectedFinding] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.setAttribute('webkitdirectory', '');
  }, []);

  // Key by the SAME dir-aware key ingest/the workers use (keyOf) so the FilmViewer selection — which
  // selects by asset ref — resolves the right bytes even when two files share a basename across folders.
  const fileMap = useMemo(() => {
    const m = new Map<string, ArrayBuffer>();
    for (const f of files) m.set(keyOf(f), f.bytes);
    return m;
  }, [files]);

  async function run(picked: PickedFile[]) {
    if (picked.length === 0) {
      setPhase({ t: 'error', message: t('error.noFiles') });
      return;
    }
    setFiles(picked);
    setReport(null);
    setSelectedFinding(undefined);
    setPhase({ t: 'analyzing' });
    try {
      const rep = await runAnalysis(picked, (p) => setPhase({ t: 'analyzing', progress: p }));
      setReport(rep);
      setSelectedAsset(rep.assets[0]?.assetRef);
      setPhase({ t: 'done' });
    } catch (e) {
      setPhase({ t: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function openFolder() {
    try {
      if (supportsDirectoryPicker()) await run(await pickFolder());
      else inputRef.current?.click();
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return; // user cancelled
      setPhase({ t: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  const totals = report?.totals;
  const savedPct = totals && totals.diskBytes > 0 ? Math.round((totals.potentialDiskSaved / totals.diskBytes) * 100) : 0;
  const folderFindings = report?.findings.filter((f) => f.scope === 'folder') ?? [];
  const assetFindings = report?.findings.filter((f) => f.scope !== 'folder' && f.assetRef === selectedAsset) ?? [];
  const selectedBytes = selectedAsset ? fileMap.get(selectedAsset) : undefined;
  const selectedMetrics = report?.assets.find((a) => a.assetRef === selectedAsset);

  return (
    <div className="min-h-full bg-bg text-ink">
      <header className="sticky top-0 z-50 border-b border-line bg-bg/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-2.5">
            <Logo />
            <span className="font-display text-[16.5px] font-semibold tracking-tight">Asset Doctor</span>
            <span className="hidden font-mono text-[11px] text-ink-soft sm:inline">{t('app.tag')}</span>
          </div>
          <div className="flex items-center gap-4">
            {report ? (
              <div className="hidden items-stretch gap-px overflow-hidden rounded-lg border border-line bg-line md:flex">
                <HeaderMetric label={t('metric.disk')} value={fmtBytes(totals?.diskBytes ?? 0)} />
                <HeaderMetric label={t('metric.vram')} value={`${fmtBytes(totals?.loadedVramBytes ?? 0)}`} />
                <HeaderMetric label={t('metric.saveable')} value={`${fmtBytes(totals?.potentialDiskSaved ?? 0)} · ${savedPct}%`} accent />
              </div>
            ) : null}
            <LanguageSwitcher />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {phase.t !== 'done' && (
          <Dropzone
            phase={phase}
            onOpen={openFolder}
            onDrop={(dt) => void filesFromDataTransfer(dt).then(run)}
          />
        )}

        {report && phase.t === 'done' && (
          <div className="space-y-6">
            <FolderReport
              findings={folderFindings}
              onPick={(ref) => {
                if (report.assets.some((a) => a.assetRef === ref)) {
                  setSelectedAsset(ref);
                  setSelectedFinding(undefined);
                }
              }}
            />
            {report.assets.length === 0 ? (
              <p className="font-mono text-sm text-ink-soft">{t('report.noAssets')}</p>
            ) : (
              <section className="grid gap-6 lg:grid-cols-[1fr_minmax(320px,420px)]">
                <div className="space-y-3">
                  <AssetSelector
                    report={report}
                    selected={selectedAsset}
                    onSelect={(a) => {
                      setSelectedAsset(a);
                      setSelectedFinding(undefined);
                    }}
                  />
                  {selectedBytes && selectedAsset ? (
                    <FilmViewer bytes={selectedBytes} findings={assetFindings} highlightId={selectedFinding} name={selectedAsset} metrics={selectedMetrics} />
                  ) : (
                    <p className="font-mono text-sm text-ink-soft">{t('report.noImage')}</p>
                  )}
                </div>

                <aside className="space-y-3">
                  <h2 className="font-mono text-xs uppercase tracking-[0.06em] text-teal">{t('findings.title')}</h2>
                  <Findings findings={assetFindings} selectedId={selectedFinding} onSelect={setSelectedFinding} />
                  <FixCard files={files} />
                  <button
                    type="button"
                    onClick={() => setPhase({ t: 'idle' })}
                    className="font-mono text-xs text-teal underline-offset-2 hover:underline"
                  >
                    {t('action.analyzeAnother')}
                  </button>
                </aside>
              </section>
            )}
          </div>
        )}
      </main>

      <input ref={inputRef} type="file" multiple hidden onChange={(e) => {
        const list = e.target.files;
        if (list) void filesFromInput(list).then(run);
      }} />
    </div>
  );
}

function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <select
      aria-label={t('ui.language')}
      value={locale}
      onChange={(e) => setLocale(e.target.value as typeof locale)}
      className="rounded-lg border border-line bg-panel px-2 py-1.5 font-mono text-xs text-ink-soft transition hover:border-teal hover:text-teal focus:border-teal focus:outline-none"
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {NATIVE_NAME[l]}
        </option>
      ))}
    </select>
  );
}

function HeaderMetric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-panel px-3 py-1.5">
      <div className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-soft">{label}</div>
      <div className={`font-mono text-xs font-semibold ${accent ? 'text-cta' : 'text-ink'}`}>{value}</div>
    </div>
  );
}

function Dropzone({
  phase,
  onOpen,
  onDrop,
}: {
  phase: Phase;
  onOpen: () => void;
  onDrop: (dt: DataTransferItemList) => void;
}) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState(false);
  const analyzing = phase.t === 'analyzing';
  return (
    <section className="mx-auto max-w-3xl">
      <div className="text-center">
        <div className="mb-5 inline-flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-[0.06em] text-teal">
          <span className="ad-pulse-dot inline-block h-[7px] w-[7px] rounded-full bg-cta" />
          {t('header.xray')}
        </div>
        <h1 className="text-balance font-display text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl">{t('dropzone.title')}</h1>
        <p className="mx-auto mt-4 max-w-xl text-pretty text-[15px] leading-relaxed text-ink-soft">{t('dropzone.subtitle')}</p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.items.length) onDrop(e.dataTransfer.items);
        }}
        className="ad-grid ad-clip ad-viewer-shadow relative mt-9 rounded-2xl border border-film-border p-3.5"
      >
        <div
          className={`relative flex min-h-[240px] flex-col items-center justify-center gap-5 overflow-hidden rounded-[10px] border-2 border-dashed px-6 py-10 text-center transition-colors ${
            dragging ? 'border-teal bg-teal/10' : 'border-teal/35'
          }`}
        >
          <div className="ad-scanline" />
          <Logo size={40} />
          {analyzing ? (
            <p className="font-mono text-sm text-[#9be7e7]">
              {t('dropzone.analyzing')}{' '}
              {phase.progress ? t('dropzone.progress', { done: phase.progress.done, total: phase.progress.total, label: phase.progress.label }) : ''}
            </p>
          ) : (
            <button
              type="button"
              onClick={onOpen}
              className="rounded-lg bg-cta px-5 py-2.5 font-sans text-sm font-semibold text-white shadow-[0_2px_6px_rgba(21,160,106,0.32)] transition hover:bg-cta-hover"
            >
              {t('dropzone.open')}
            </button>
          )}
        </div>
      </div>

      {phase.t === 'error' && <p className="mt-3 text-center font-mono text-xs text-crit">{phase.message}</p>}
      <p className="mt-5 text-center font-mono text-[11px] text-ink-soft">{t('dropzone.footnote')}</p>
    </section>
  );
}

function AssetSelector({
  report,
  selected,
  onSelect,
}: {
  report: AnalysisReport;
  selected: string | undefined;
  onSelect: (assetRef: string) => void;
}) {
  if (report.assets.length <= 1) return null;
  const worst = (ref: string) => {
    const sevs = report.findings.filter((f) => f.assetRef === ref).map((f) => f.severity);
    return sevs.includes('crit') ? 'crit' : sevs.includes('warn') ? 'warn' : sevs.includes('info') ? 'info' : 'ok';
  };
  return (
    <div className="flex flex-wrap gap-2">
      {report.assets.map((a) => (
        <button
          key={a.assetRef}
          type="button"
          onClick={() => onSelect(a.assetRef)}
          className={`rounded-lg border px-2.5 py-1 font-mono text-xs transition ${
            a.assetRef === selected ? 'border-teal text-ink' : 'border-line text-ink-soft hover:border-ink-soft'
          }`}
        >
          <span className={SEVERITY_TEXT[worst(a.assetRef)]}>●</span> {a.assetRef}
        </button>
      ))}
    </div>
  );
}

type FixPhase =
  | { t: 'idle' }
  // Dry-run preview (docs/improvements/dry-run-plan-preview.md): the Pro CTA first posts mode:'plan'
  // (cheap/pure — no compose/encode/zip), shows the Plan card, then "Run fix" re-posts mode:'execute'
  // with the IDENTICAL options (today's auto-download path).
  | { t: 'planning' }
  // `pending` marks a re-preview triggered by a PlanCard checkbox toggle: the card stays MOUNTED (no
  // flicker, checkbox focus kept) showing the last summary with a subtle "updating…" hint while the worker
  // recomputes the masked plan. A fresh preview (from idle) uses the 'planning' spinner instead.
  | { t: 'plan'; summary: FixPlanSummary; pending?: boolean }
  | { t: 'running'; p: FixProgress }
  | { t: 'done'; out: FixOutcome }
  | { t: 'error'; message: string };

function downloadZip(zip: Blob): void {
  const url = URL.createObjectURL(zip);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'optimized-folder.zip';
  a.click();
  URL.revokeObjectURL(url);
}

// Per-bundle marking (aggressive dedup only). Marking changes ONLY which copy is chosen as the dedup
// owner across folders — unmarked bundles stay 'isolated' (duplicates merged within the same bundle
// only). Mark 'eager' (globally resident before everything) to let other bundles share its copies.
// (SkinGuard key/value rows are deferred per design §5b; skinGuard defaults to {} for now.)
function BundlesPanel({
  folders,
  rootLoose,
  marking,
  setMarking,
}: {
  folders: string[];
  rootLoose: number;
  marking: LazyMarking;
  setMarking: (m: LazyMarking) => void;
}) {
  const { t } = useI18n();
  const set = (bundle: string, v: BundleAvailability): void => setMarking({ ...marking, [bundle]: v });
  const states: BundleAvailability[] = ['eager', 'lazy', 'isolated'];
  return (
    <details className="mt-2 rounded-md border border-line bg-bg p-2 text-left open:pb-2.5">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-teal">{t('fix.bundles.title')}</summary>
      <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.bundles.hint')}</p>
      <div className="mt-2 space-y-1.5">
        {folders.map((b) => (
          <div key={b} className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[11px] text-ink">{b}/</span>
            <select
              aria-label={b}
              value={marking[b] ?? 'isolated'}
              onChange={(e) => set(b, e.target.value as BundleAvailability)}
              className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-soft transition hover:border-teal focus:border-teal focus:outline-none"
            >
              {states.map((s) => (
                <option key={s} value={s}>
                  {t(`fix.lazy.${s}`)}
                </option>
              ))}
            </select>
          </div>
        ))}
        {rootLoose > 0 ? <p className="truncate font-mono text-[10px] text-ink-soft/80">{t('fix.bundles.root')} · {rootLoose}</p> : null}
      </div>
      <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-soft/80">{t('fix.lazy.note')}</p>
    </details>
  );
}

// Collapsible optimization-settings panel (default collapsed — instant-wow defaults are the fast
// preset). Only genuinely portable controls ship. Non-portable controls (resampling kernel, pre-blur,
// pngquant, AVIF chroma) are honestly omitted with a "Why no X?" title explaining browser limits — NOT
// "coming soon". Defaults (effort 0, all checkboxes off, no overrides) reproduce today's behavior.
function SettingsPanel({
  effort,
  setEffort,
  scaleAwareQ,
  setScaleAwareQ,
  webpNearLossless,
  setWebpNearLossless,
  pngRecompress,
  setPngRecompress,
  overrides,
  setOverrides,
}: {
  effort: number;
  setEffort: (n: number) => void;
  scaleAwareQ: boolean;
  setScaleAwareQ: (b: boolean) => void;
  webpNearLossless: boolean;
  setWebpNearLossless: (b: boolean) => void;
  pngRecompress: boolean;
  setPngRecompress: (b: boolean) => void;
  overrides: { match: string; quality: number }[];
  setOverrides: (o: { match: string; quality: number }[]) => void;
}) {
  const { t } = useI18n();
  return (
    <details className="mt-2 rounded-md border border-line bg-bg p-2 text-left open:pb-2.5">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-teal">{t('fix.settings.title')}</summary>

      <label className="mt-2 block font-mono text-[10px] text-ink-soft">
        <span className="flex items-center justify-between" title={t('fix.settings.effortHint')}>
          {t('fix.settings.effort')} <span className="text-ink">{effort}</span>
        </span>
        <input type="range" min={0} max={6} step={1} value={effort} onChange={(e) => setEffort(Number(e.target.value))} className="mt-1 w-full accent-teal" />
      </label>

      <label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.settings.scaleAwareHint')}>
        <input type="checkbox" checked={scaleAwareQ} onChange={(e) => setScaleAwareQ(e.target.checked)} className="accent-teal" />
        {t('fix.settings.scaleAware')}
      </label>
      <label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.settings.nearLosslessHint')}>
        <input type="checkbox" checked={webpNearLossless} onChange={(e) => setWebpNearLossless(e.target.checked)} className="accent-teal" />
        {t('fix.settings.nearLossless')}
      </label>
      <label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.settings.pngRecompressHint')}>
        <input type="checkbox" checked={pngRecompress} onChange={(e) => setPngRecompress(e.target.checked)} className="accent-teal" />
        {t('fix.settings.pngRecompress')}
      </label>

      <div className="mt-3 border-t border-line pt-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-soft" title={t('fix.settings.overridesHint')}>
          {t('fix.settings.overrides')}
        </p>
        {overrides.map((o, i) => (
          <div key={i} className="mt-1.5 flex items-center gap-1.5">
            <input
              value={o.match}
              placeholder="folder/ · type:spine"
              aria-label={t('fix.settings.overrides')}
              onChange={(e) => {
                const next = overrides.slice();
                next[i] = { ...o, match: e.target.value };
                setOverrides(next);
              }}
              className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink focus:border-teal focus:outline-none"
            />
            <input
              type="number"
              min={0}
              max={100}
              value={Math.round(o.quality * 100)}
              aria-label="quality"
              title="quality 0–100"
              onChange={(e) => {
                const next = overrides.slice();
                next[i] = { ...o, quality: Math.max(0, Math.min(100, Number(e.target.value))) / 100 };
                setOverrides(next);
              }}
              className="w-14 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink focus:border-teal focus:outline-none"
            />
            <button type="button" onClick={() => setOverrides(overrides.filter((_, j) => j !== i))} className="font-mono text-[11px] text-ink-soft hover:text-crit" aria-label="remove">
              ✕
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setOverrides([...overrides, { match: '', quality: 0.85 }])} className="mt-1.5 font-mono text-[10px] text-teal underline-offset-2 hover:underline">
          + {t('fix.settings.overrides')}
        </button>
      </div>

      {/* "Why no X?" — honest browser-limit notes for the controls we deliberately omit (NOT
          "coming soon"): resampling kernel, pre-blur, pngquant, AVIF chroma. */}
      <ul className="mt-3 space-y-1 border-t border-line pt-2 font-mono text-[10px] leading-relaxed text-ink-soft/80">
        <li>{t('fix.skipped.whyNoKernel')}</li>
        <li>{t('fix.skipped.whyNoPreBlur')}</li>
        <li>{t('fix.skipped.whyNoPngquant')}</li>
        <li>{t('fix.skipped.whyNoChroma')}</li>
      </ul>
    </details>
  );
}

// Feature 4 — pack loose images into NEW spritesheets (static TexturePacker JSON / Spine .atlas).
// Its OWN explicit Pro opt-in, DEFAULT OFF (NOT folded under `aggressive`): a default Pro run never
// silently reorganizes a folder. Packing is REFERENCE-CHANGING (the game must load the new sheet/atlas,
// not the loose files) — surfaced INLINE here (not just post-run) and again via fix.packWarn in the
// receipt. Spine pages are PNG by default for runtime safety; format/quality/effort reuse the shared
// SettingsPanel controls (no new encode knobs). Off ⇒ no pack groups, byte-identical to today.
function PackPanel({
  packLoose,
  setPackLoose,
  packMode,
  setPackMode,
  packGranularity,
  setPackGranularity,
  packTrim,
  setPackTrim,
}: {
  packLoose: boolean;
  setPackLoose: (b: boolean) => void;
  packMode: PackMode;
  setPackMode: (m: PackMode) => void;
  packGranularity: StaticGranularity;
  setPackGranularity: (g: StaticGranularity) => void;
  packTrim: boolean;
  setPackTrim: (b: boolean) => void;
}) {
  const { t } = useI18n();
  const modes: PackMode[] = ['auto', 'force-static', 'force-spine'];
  const grans: StaticGranularity[] = ['per-leaf-folder', 'one-sheet-for-all', 'per-top-level-bundle'];
  const modeKey: Record<PackMode, string> = { auto: 'auto', 'force-static': 'static', 'force-spine': 'spine' };
  const granKey: Record<StaticGranularity, string> = {
    'per-leaf-folder': 'folder',
    'one-sheet-for-all': 'one',
    'per-top-level-bundle': 'bundle',
  };
  return (
    <details className="mt-2 rounded-md border border-line bg-bg p-2 text-left open:pb-2.5">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-teal">{t('fix.pack.title')}</summary>

      <label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft">
        <input type="checkbox" checked={packLoose} onChange={(e) => setPackLoose(e.target.checked)} className="accent-teal" />
        {t('fix.pack.enable')}
      </label>

      {/* Reference-changing warning shown INLINE (before run), not only in the receipt. */}
      <p className="mt-2 font-mono text-[10px] leading-relaxed text-warn">⚠ {t('fix.pack.inlineWarn')}</p>

      {packLoose ? (
        <div className="mt-2 space-y-2">
          <label className="flex items-center justify-between gap-2 font-mono text-[10px] text-ink-soft">
            {t('fix.pack.mode.label')}
            <select
              aria-label={t('fix.pack.mode.label')}
              value={packMode}
              onChange={(e) => setPackMode(e.target.value as PackMode)}
              className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-soft transition hover:border-teal focus:border-teal focus:outline-none"
            >
              {modes.map((m) => (
                <option key={m} value={m}>
                  {t(`fix.pack.mode.${modeKey[m]}`)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center justify-between gap-2 font-mono text-[10px] text-ink-soft">
            {t('fix.pack.grouping.label')}
            <select
              aria-label={t('fix.pack.grouping.label')}
              value={packGranularity}
              onChange={(e) => setPackGranularity(e.target.value as StaticGranularity)}
              className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-soft transition hover:border-teal focus:border-teal focus:outline-none"
            >
              {grans.map((g) => (
                <option key={g} value={g}>
                  {t(`fix.pack.grouping.${granKey[g]}`)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5 font-mono text-[10px] text-ink-soft">
            <input type="checkbox" checked={packTrim} onChange={(e) => setPackTrim(e.target.checked)} className="accent-teal" />
            {t('fix.pack.trim')}
          </label>

          {/* Sheet format reuses the shared SettingsPanel target/quality/effort controls; Spine sheets
              stay PNG by default for runtime safety regardless of that target. */}
          <p className="font-mono text-[10px] leading-relaxed text-ink-soft/80">{t('fix.pack.spinePng')}</p>
        </div>
      ) : null}
    </details>
  );
}

// Edge-extrude (bleed) — replicate each rectangle sprite's outermost edge rows/cols into the symmetric
// packing gutter (pack.ts OPTION A) so bilinear/mipmap filtering can't sample transparent gutter pixels
// at sprite borders ⇒ no seams. Its OWN Pro knob, DEFAULT OFF (0): off ⇒ no op carries `extrude`, no
// gutter reserved ⇒ byte-identical to today. HONESTY (invariant 5): a symmetric gutter can push a sheet
// to the next power-of-two ⇒ MORE VRAM — disclosed inline here and surfaced truthfully in the receipt
// (extrudeVramDelta), never claimed free. Rectangle sprites only (meshed/rotated blits are skipped and
// reported). The `{px}` in the hint reflects the current selection.
function ExtrudePanel({ extrude, setExtrude }: { extrude: number; setExtrude: (n: number) => void }) {
  const { t } = useI18n();
  const opts = [0, 1, 2];
  return (
    <details className="mt-2 rounded-md border border-line bg-bg p-2 text-left open:pb-2.5">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-teal">{t('fix.extrude')}</summary>

      <label className="mt-2 flex items-center justify-between gap-2 font-mono text-[10px] text-ink-soft">
        {t('fix.extrude')}
        <select
          aria-label={t('fix.extrude')}
          title={t('fix.extrudeHint', { px: extrude || 1 })}
          value={extrude}
          onChange={(e) => setExtrude(Number(e.target.value))}
          className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-soft transition hover:border-teal focus:border-teal focus:outline-none"
        >
          {opts.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? t('fix.extrude.off') : t('fix.extrude.px', { n })}
            </option>
          ))}
        </select>
      </label>

      {/* Honest disclosure (invariant 5): bleed can grow a sheet to the next POT ⇒ more VRAM. */}
      <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-soft/80">{t('fix.extrudeHint', { px: extrude || 1 })}</p>
    </details>
  );
}

// Scale-tier export — emit downscaled copies (_1080p/_720p/_540p…) so the game loads the resolution
// that fits the device. Its OWN explicit Pro opt-in, DEFAULT OFF (NOT under aggressive): a default Pro
// run never multiplies a folder into resolution variants. Tiering is REFERENCE-CHANGING (the game's
// loader must pick a tier at runtime; the source is renamed to the top tier) — surfaced INLINE here and
// again via fix.tierWarn in the receipt. The top tier (scale 1) is always implied: it is the source
// footprint and validateTiers requires it; the user picks which LOWER tiers to also ship. Downscale
// uses the browser's resampler (no kernel/pre-blur control) — disclosed via the existing whyNoKernel/
// whyNoPreBlur honesty notes. Off / no lower tiers checked beyond the implied top ⇒ scaleTiers stays
// empty ⇒ byte-identical to today.
function TierPanel({
  tierEnable,
  setTierEnable,
  tierSuffixes,
  setTierSuffixes,
}: {
  tierEnable: boolean;
  setTierEnable: (b: boolean) => void;
  /** Suffixes of the lower tiers the user opted into (the scale-1 top tier is always implied). */
  tierSuffixes: Set<string>;
  setTierSuffixes: (s: Set<string>) => void;
}) {
  const { t } = useI18n();
  // Map each default tier's suffix → a label key ("_720p" → "fix.tier.label.720p").
  const labelKey = (suffix: string): string => `fix.tier.label.${suffix.replace(/^[_-]/, '')}`;
  const toggle = (suffix: string, on: boolean): void => {
    const next = new Set(tierSuffixes);
    if (on) next.add(suffix);
    else next.delete(suffix);
    setTierSuffixes(next);
  };
  return (
    <details className="mt-2 rounded-md border border-line bg-bg p-2 text-left open:pb-2.5">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-teal">{t('fix.tier.title')}</summary>

      <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-soft/80">{t('fix.tier.hint')}</p>

      <label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft">
        <input type="checkbox" checked={tierEnable} onChange={(e) => setTierEnable(e.target.checked)} className="accent-teal" />
        {t('fix.tier.enable')}
      </label>

      {/* Reference-changing warning shown INLINE (before run), not only in the receipt. */}
      <p className="mt-2 font-mono text-[10px] leading-relaxed text-warn">⚠ {t('fix.tier.inlineWarn')}</p>

      {tierEnable ? (
        <div className="mt-2 space-y-2">
          <div className="space-y-1">
            {DEFAULT_SCALE_TIERS.map((tier) => {
              const top = tier.scale >= 1; // top tier is implied — always shipped, can't be unchecked.
              return (
                <label
                  key={tier.suffix}
                  title={top ? t('fix.tier.inlineWarn') : undefined}
                  className="flex items-center gap-1.5 font-mono text-[10px] text-ink-soft"
                >
                  <input
                    type="checkbox"
                    checked={top || tierSuffixes.has(tier.suffix)}
                    disabled={top}
                    onChange={(e) => toggle(tier.suffix, e.target.checked)}
                    className="accent-teal disabled:opacity-60"
                  />
                  {t(labelKey(tier.suffix))}
                </label>
              );
            })}
          </div>

          {/* Disk-grows note: tiering ships every tier ⇒ total disk increases by design; the win is
              per-device download + per-device VRAM, never total disk (invariant 5). */}
          <p className="font-mono text-[10px] leading-relaxed text-ink-soft/80">{t('fix.tier.diskNote')}</p>

          {/* v1 scope: an asset that gets repacked/merged/packed is NOT also tiered (its emitted sheet is
              not re-fed into tiering yet) — surfaced as a skip in the receipt. State it up front so the
              under-filled-atlas case isn't a confusing silent single-resolution result. */}
          <p className="font-mono text-[10px] leading-relaxed text-ink-soft/80">{t('fix.tier.repackNote')}</p>

          {/* Downscale honesty — REUSE the existing browser-limit notes (no kernel / no pre-blur control). */}
          <ul className="space-y-1 border-t border-line pt-2 font-mono text-[10px] leading-relaxed text-ink-soft/80">
            <li>{t('fix.skipped.whyNoKernel')}</li>
            <li>{t('fix.skipped.whyNoPreBlur')}</li>
          </ul>
        </div>
      ) : null}
    </details>
  );
}

// The Phase-2 fix: repack + transcode the loaded folder in a worker, then download a drop-in
// optimized .zip. Assets never leave the device. The Pro gate is OFF by default (free) and only
// engages when VITE_PRO_GATE === 'true' — then a valid offline-verified entitlement is required.
function FixCard({ files }: { files: PickedFile[] }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<FixPhase>({ t: 'idle' });
  const [aggressive, setAggressive] = useState(false);
  const [polygon, setPolygon] = useState(false);
  const [unlocked, setUnlocked] = useState(!PRO_GATE_ENABLED);

  // Feature 2/3 settings (all default to today's behavior when untouched). Marking defaults to {} ⇒
  // every bundle is treated as 'isolated' by buildDedupGroups (same-bundle dedup only).
  const [marking, setMarking] = useState<LazyMarking>({});
  // SkinGuard MVP: threaded through runFix but defaults to {} — the key/value-skin rows are a follow-up
  // (design §5b). Empty ⇒ buildDedupGroups treats every asset as skinGroup 'general' (today's behavior).
  const skinGuard: SkinGuard = {};
  const [effort, setEffort] = useState(0);
  const [scaleAwareQ, setScaleAwareQ] = useState(false);
  const [webpNearLossless, setWebpNearLossless] = useState(false);
  const [pngRecompress, setPngRecompress] = useState(false);
  const [overrides, setOverrides] = useState<{ match: string; quality: number }[]>([]);

  // Feature 4 — own Pro opt-in, DEFAULT OFF (NOT under aggressive). Defaults reproduce today: off ⇒ no
  // pack groups, no pack ops. When on: Auto mode, per-leaf-folder grouping, trim ON (matching design §9).
  const [packLoose, setPackLoose] = useState(false);
  const [packMode, setPackMode] = useState<PackMode>('auto');
  const [packGranularity, setPackGranularity] = useState<StaticGranularity>('per-leaf-folder');
  const [packTrim, setPackTrim] = useState(true);

  // Edge-extrude (bleed) — own Pro knob, DEFAULT OFF (0). 0 ⇒ no op carries `extrude`, no gutter
  // reserved ⇒ byte-identical to today. >0 ⇒ the worker reserves a symmetric gutter and bleeds rect
  // sprite edges into it (kills bilinear/mipmap seams); a gutter bump can grow a sheet to the next POT
  // ⇒ more VRAM, surfaced honestly in the receipt (invariant 5).
  const [extrude, setExtrude] = useState(0);

  // Selective fix (docs/improvements/selective-fix.md) — the OpKinds the user DESELECTED in the Plan card.
  // INTRA-PLAN state (a per-row checkbox; default = nothing excluded ⇒ full fix). Forwarded VERBATIM through
  // buildOptions to BOTH plan and execute as `excludeKinds`, so a re-previewed plan and its committed run
  // share the mask byte-for-byte. DELIBERATELY ABSENT from the stale-plan reset deps below: toggling a row
  // re-previews IN PLACE via togglePlanKind (it does NOT invalidate the plan), unlike every other option.
  // Reset to empty on every fresh preview(). Empty ⇒ byte-identical to today (no excludeKinds forwarded).
  const [excludeKinds, setExcludeKinds] = useState<Set<OpKind>>(() => new Set());

  // Scale-tier export — own Pro opt-in, DEFAULT OFF (NOT under aggressive). `tierSuffixes` holds the
  // LOWER tiers the user opted into; the scale-1 top tier is always implied (added when building the
  // ladder). Default selection mirrors the design preset (720p + 540p). Off OR no enabled tier beyond
  // the implied top ⇒ scaleTiers stays empty ⇒ no tiering ⇒ byte-identical to today.
  const [tierEnable, setTierEnable] = useState(false);
  const [tierSuffixes, setTierSuffixes] = useState<Set<string>>(
    () => new Set(DEFAULT_SCALE_TIERS.filter((tt) => tt.scale < 1).map((tt) => tt.suffix)),
  );
  // The validated ladder: always include the scale-1 top tier (validateTiers requires it) plus every
  // checked lower tier, in the canonical high→low order of DEFAULT_SCALE_TIERS. Empty when disabled.
  const scaleTiers: ScaleTier[] = useMemo(
    () => (tierEnable ? DEFAULT_SCALE_TIERS.filter((tt) => tt.scale >= 1 || tierSuffixes.has(tt.suffix)) : []),
    [tierEnable, tierSuffixes],
  );

  // Top-level bundles with REAL folder structure: a ref with no "/" is its own singleton (a flat,
  // root-level loose file), which makes per-bundle marking meaningless noise. We collect only segments
  // that own ≥2 files AND contain a "/" somewhere; root-level loose files collapse into one implicit
  // "(root)" bundle. The panel is suppressed unless there are ≥2 distinct multi-file folder bundles —
  // marking only changes owner choice ACROSS multi-folder packs.
  const bundles = useMemo(() => {
    const counts = new Map<string, number>();
    let rootLoose = 0;
    for (const f of files) {
      const ref = keyOf(f);
      if (ref.indexOf('/') < 0) rootLoose++;
      else counts.set(bundleOf(ref), (counts.get(bundleOf(ref)) ?? 0) + 1);
    }
    const folders = [...counts.entries()].filter(([, n]) => n >= 2).map(([b]) => b).sort(cmp);
    return { folders, rootLoose };
  }, [files]);
  const showBundles = bundles.folders.length >= 2;

  useEffect(() => {
    if (!PRO_GATE_ENABLED) return;
    let alive = true;
    void (async () => {
      await maybeRefresh();
      const ok = await isProUnlocked();
      if (alive) setUnlocked(ok);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ONE source of truth for the FixOptions both the dry-run preview (mode:'plan') and the execute run
  // (mode:'execute') send — so "Run fix" commits the EXACT plan the preview described, byte-for-byte.
  // All omitted/false/empty values reproduce today's behavior in the worker. `over` lets a toggle pass the
  // NEXT exclude set explicitly (no async setState-batching dependency); absent ⇒ the live `excludeKinds`.
  function buildOptions(over?: Set<OpKind>): FixOptions {
    const exclude = over ?? excludeKinds;
    return {
      targetMime: 'image/avif',
      quality: 0.85,
      padding: 2,
      maxSize: 4096,
      maxEdge: 2048,
      aggressive,
      polygon,
      // Feature 2/3 — omitted/false/empty values reproduce today's behavior in the worker.
      effort: effort > 0 ? effort : undefined,
      scaleAwareQuality: scaleAwareQ || undefined,
      webpNearLossless: webpNearLossless ? 60 : undefined,
      pngRecompressLevel: pngRecompress ? 2 : undefined,
      marking: aggressive && Object.keys(marking).length > 0 ? marking : undefined,
      skinGuard: aggressive && Object.keys(skinGuard).length > 0 ? skinGuard : undefined,
      overrides: overrides.length > 0 ? overrides.filter((o) => o.match.trim() !== '') : undefined,
      // Feature 4 — only forwarded when explicitly enabled; off ⇒ undefined ⇒ no pack ops (today).
      packLoose: packLoose || undefined,
      packMode: packLoose ? packMode : undefined,
      packGranularity: packLoose ? packGranularity : undefined,
      packTrim: packLoose ? packTrim : undefined,
      // Scale-tier export — only forwarded when enabled AND a real lower tier is selected (the
      // implied scale-1 top tier alone would just rename, not downscale). Off / top-only ⇒ undefined
      // ⇒ no tiering ⇒ byte-identical to today. The worker validates the ladder fail-closed.
      scaleTiers: scaleTiers.length > 1 ? scaleTiers : undefined,
      // Edge-extrude (bleed) — only forwarded when > 0; off ⇒ undefined ⇒ no gutter, byte-identical
      // to today. The plan sets each repack/pack op's symmetric gutter >= extrude (invariant 5: a
      // gutter can grow a sheet ⇒ VRAM reported honestly via extrudeVramDelta).
      extrude: extrude > 0 ? extrude : undefined,
      // Selective fix — the deselected OpKinds (empty ⇒ undefined ⇒ full fix, byte-identical to today).
      // The worker SKIPS each excluded kind and surfaces an honest skipped[] note (never a silent drop).
      excludeKinds: exclude.size > 0 ? [...exclude] : undefined,
    };
  }

  // Monotonic preview request id — guards against an out-of-order worker resolve when rapid toggles spawn
  // overlapping plan passes (each toggle starts one planFix; only the LATEST resolve may write the phase).
  const previewSeq = useRef(0);

  // Dry-run preview: post mode:'plan' (cheap/pure — no compose/encode/zip) and show the Plan card. The
  // user confirms with "Run fix" (re-posts the SAME options with mode:'execute' via run()). `over` lets a
  // PlanCard toggle re-preview with the explicit next exclude set (no setState-batching dependency); a fresh
  // preview (no `over`) resets the selection to empty unconditionally, so re-entering the plan starts full.
  // A FRESH preview (over absent) flips to the 'planning' spinner; a TOGGLE re-preview (over present) keeps
  // the PlanCard MOUNTED with a subtle pending hint (no flicker, no lost checkbox focus) — design B1/S4.
  async function preview(over?: Set<OpKind>) {
    if (!over) setExcludeKinds(new Set());
    const seq = ++previewSeq.current;
    if (over) setPhase((p) => (p.t === 'plan' ? { ...p, pending: true } : { t: 'planning' }));
    else setPhase({ t: 'planning' });
    try {
      const summary = await planFix(files, buildOptions(over));
      if (seq !== previewSeq.current) return; // a newer toggle superseded this preview — drop the stale resolve
      setPhase({ t: 'plan', summary });
    } catch (e) {
      if (seq !== previewSeq.current) return;
      setPhase({ t: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  // Toggle one OpKind in/out of the deselected set and re-preview IN PLACE with the explicit next set (so a
  // mid-flight toggle is never dropped to a stale guard, and Run commits exactly the previewed mask). The
  // worker recomputes the MASKED plan (design S4) — opCounts/refs/skips reflect the chosen subset, never a
  // faked client-side recount. The selection is intra-plan: this does NOT reset to idle (excludeKinds is
  // intentionally out of the stale-plan reset deps below).
  function togglePlanKind(kind: OpKind) {
    setExcludeKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      void preview(next);
      return next;
    });
  }

  async function run() {
    setPhase({ t: 'running', p: { label: '', done: 0, total: 1 } });
    try {
      const out = await runFix(files, buildOptions(), (p) => setPhase({ t: 'running', p }));
      downloadZip(out.zip);
      setPhase({ t: 'done', out });
    } catch (e) {
      setPhase({ t: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  // Stale-plan invalidation: if any option toggle changes after a preview, the shown plan no longer
  // matches what "Run fix" would commit — reset to the options view so the user re-previews. Deps are
  // EXACTLY the live FixCard option state (skinGuard is a const {}, not state). Skips the first render.
  // `excludeKinds` is DELIBERATELY ABSENT here (selective fix): a Plan-card row toggle re-previews IN PLACE
  // via togglePlanKind — it does NOT invalidate the plan. Do NOT add it, or every toggle resets to idle.
  const sawPlan = useRef(false);
  useEffect(() => {
    if (sawPlan.current) setPhase({ t: 'idle' });
  }, [aggressive, polygon, marking, effort, scaleAwareQ, webpNearLossless, pngRecompress, overrides, packLoose, packMode, packGranularity, packTrim, extrude, tierEnable, tierSuffixes]);
  useEffect(() => {
    sawPlan.current = phase.t === 'plan';
  }, [phase.t]);

  // Gated + not yet unlocked → show activation instead of the run button.
  if (PRO_GATE_ENABLED && !unlocked) {
    return (
      <div className="rounded-xl border-2 border-teal/70 bg-panel p-4 text-center">
        <p className="font-mono text-xs text-ink-soft">{t('pro.note')}</p>
        <ActivatePanel onUnlocked={() => setUnlocked(true)} />
      </div>
    );
  }

  return (
    <div className="rounded-xl border-2 border-teal/70 bg-panel p-4 text-center">
      <p className="font-mono text-xs text-ink-soft">{t('pro.note')}</p>
      {phase.t === 'planning' ? (
        <p className="mt-2.5 font-mono text-xs text-teal">{t('dropzone.analyzing')}</p>
      ) : phase.t === 'running' ? (
        <p className="mt-2.5 font-mono text-xs text-teal">{t('fix.optimizing')} {phase.p.total > 1 ? `${phase.p.done}/${phase.p.total}` : ''} {phase.p.label}</p>
      ) : phase.t === 'plan' ? (
        <PlanCard summary={phase.summary} excluded={excludeKinds} pending={phase.pending ?? false} onToggle={togglePlanKind} onRun={run} onBack={() => setPhase({ t: 'idle' })} disabled={files.length === 0} />
      ) : phase.t === 'done' ? (
        <Receipt receipt={phase.out.receipt} onRedownload={() => downloadZip(phase.out.zip)} />
      ) : (
        <>
          <label className="mt-2 flex items-center justify-center gap-1.5 font-mono text-[10px] text-ink-soft">
            <input type="checkbox" checked={aggressive} onChange={(e) => setAggressive(e.target.checked)} className="accent-teal" />
            {t('fix.merge')}
          </label>
          <label title={t('fix.polygonHint')} className="mt-2 flex items-center justify-center gap-1.5 font-mono text-[10px] text-ink-soft">
            <input type="checkbox" checked={polygon} onChange={(e) => setPolygon(e.target.checked)} className="accent-teal" />
            {t('fix.polygon')}
          </label>

          {aggressive && showBundles ? (
            <BundlesPanel folders={bundles.folders} rootLoose={bundles.rootLoose} marking={marking} setMarking={setMarking} />
          ) : null}

          <SettingsPanel
            effort={effort}
            setEffort={setEffort}
            scaleAwareQ={scaleAwareQ}
            setScaleAwareQ={setScaleAwareQ}
            webpNearLossless={webpNearLossless}
            setWebpNearLossless={setWebpNearLossless}
            pngRecompress={pngRecompress}
            setPngRecompress={setPngRecompress}
            overrides={overrides}
            setOverrides={setOverrides}
          />

          <PackPanel
            packLoose={packLoose}
            setPackLoose={setPackLoose}
            packMode={packMode}
            setPackMode={setPackMode}
            packGranularity={packGranularity}
            setPackGranularity={setPackGranularity}
            packTrim={packTrim}
            setPackTrim={setPackTrim}
          />

          <ExtrudePanel extrude={extrude} setExtrude={setExtrude} />

          <TierPanel
            tierEnable={tierEnable}
            setTierEnable={setTierEnable}
            tierSuffixes={tierSuffixes}
            setTierSuffixes={setTierSuffixes}
          />

          {/* Default flow: PREVIEW the plan first (mode:'plan', cheap/pure) — a reference-changing paid
              fix shouldn't run blind. "Run fix" in the Plan card then commits the IDENTICAL options. */}
          <button
            type="button"
            onClick={() => void preview()}
            disabled={files.length === 0}
            className="mt-2 w-full rounded-lg bg-cta px-3 py-2 font-sans text-xs font-semibold text-white shadow-[0_2px_6px_rgba(21,160,106,0.32)] transition hover:bg-cta-hover disabled:opacity-55"
          >
            {t('fix.plan.cta')}
          </button>
          {/* Escape hatch: still go straight to execute + auto-download (today's one-click path) if desired. */}
          <button
            type="button"
            onClick={run}
            disabled={files.length === 0}
            className="mt-2 w-full rounded-lg border border-line px-3 py-1.5 font-mono text-[11px] text-teal transition hover:border-teal disabled:opacity-55"
          >
            {t('pro.cta')}
          </button>
        </>
      )}
      {phase.t === 'error' && <p className="mt-2 font-mono text-[11px] text-crit">{phase.message}</p>}
      {PRO_GATE_ENABLED && unlocked && <ProBadge onDeactivated={() => setUnlocked(false)} />}
    </div>
  );
}

function Receipt({ receipt, onRedownload }: { receipt: FixReceipt; onRedownload: () => void }) {
  const { t } = useI18n();
  const pct = (before: number, after: number): number => (before > 0 ? Math.round((1 - after / before) * 100) : 0);
  return (
    <div className="mt-2.5 space-y-1.5 text-left">
      <div className="flex items-center justify-center gap-1.5 font-mono text-xs text-ok">
        <span className="h-2 w-2 rounded-full bg-ok" /> ✓ {t('fix.optimized')}
      </div>
      <div className="space-y-1 rounded-md bg-bg p-2 font-mono text-[11px]">
        <ReceiptRow label={t('metric.disk')} before={receipt.diskBytesBefore} after={receipt.diskBytesAfter} pct={pct(receipt.diskBytesBefore, receipt.diskBytesAfter)} />
        <ReceiptRow label="VRAM" before={receipt.vramBytesBefore} after={receipt.vramBytesAfter} pct={pct(receipt.vramBytesBefore, receipt.vramBytesAfter)} />
      </div>
      {/* Per-file change manifest — the existing receipt.operations[] trail, grouped by verb, collapsed
          by default (instant-wow headline stays first). Reference-changing verbs (merge/dedup/pack/tier)
          coloured warn, reinforcing the aggregate ⚠ banners at the per-row level. Pure presentation of
          existing data — no faked numbers (op strings carry dims/format, not per-file bytes). */}
      <OpManifest operations={receipt.operations} />
      {(receipt.meshSprites ?? 0) > 0 ? (
        <p className="font-mono text-[10px] text-ink-soft">
          {t('fix.meshedCount', { n: receipt.meshSprites ?? 0 })} ·{' '}
          {receipt.polygonAreaSavedPct ? t('fix.tighter', { pct: Math.round(receipt.polygonAreaSavedPct * 100) }) : t('fix.tighterPlain')}
          <span className="mt-0.5 block text-ink-soft/80">{t('fix.meshNote')}</span>
        </p>
      ) : null}
      {receipt.referencesChanged ? <p className="font-mono text-[10px] text-warn">⚠ {t('fix.mergeWarn')}</p> : null}
      {/* Feature 4 receipt: groups/sheets/regions packed, Spine path-verification, and a dedicated
          reference-changing banner (NOT a drop-in: the game must load the new sheet/atlas). */}
      {(receipt.packedSheets?.groups ?? 0) > 0 ? (
        <>
          <p className="font-mono text-[10px] text-warn">⚠ {t('fix.packWarn')}</p>
          <p className="font-mono text-[10px] text-ink-soft">
            {t('fix.pack.receipt', {
              groups: receipt.packedSheets?.groups ?? 0,
              sheets: receipt.packedSheets?.sheets ?? 0,
              regions: receipt.packedSheets?.regions ?? 0,
            })}
          </p>
          {receipt.packVerification ? (
            <p className="font-mono text-[10px] text-ink-soft/80">
              {t('fix.pack.verified', {
                verified: receipt.packVerification.verified,
                unmatched: receipt.packVerification.unmatched,
                unverified: receipt.packVerification.unverified,
              })}
            </p>
          ) : null}
          {/* VRAM honesty (invariant 5 / §6.8): packing NPOT loose into POT sheets routinely RAISES VRAM.
              Surface the increase SEPARATELY — it is NOT folded into the headline VRAM row; the win is
              fewer draw calls / texture binds, never a guaranteed VRAM saving. */}
          {(receipt.packVramDelta ?? 0) > 0 ? (
            <p className="font-mono text-[10px] text-warn">{t('fix.pack.vramDelta', { bytes: receipt.packVramDelta ?? 0 })}</p>
          ) : null}
        </>
      ) : null}
      {/* Edge-extrude (bleed) receipt: how many rectangle sprites got a bleed (+ the px width), how many
          meshed/rotated sprites were skipped (no polygon-edge extrude in v1), and the HONEST VRAM delta
          when a symmetric gutter pushed a sheet to the next POT (invariant 5 — surfaced separately, the
          growth is already in the headline VRAM row, never claimed free). */}
      {(receipt.extrudedBlits ?? 0) > 0 ? (
        <p className="font-mono text-[10px] text-ink-soft">{t('fix.extrude.receipt', { blits: receipt.extrudedBlits ?? 0, px: receipt.extrudePx ?? 0 })}</p>
      ) : null}
      {(receipt.extrudeSkipped ?? 0) > 0 ? (
        <p className="font-mono text-[10px] text-ink-soft/80">{t('fix.extrudeSkipped', { n: receipt.extrudeSkipped ?? 0 })}</p>
      ) : null}
      {(receipt.extrudeVramDelta ?? 0) > 0 ? (
        <p className="font-mono text-[10px] text-warn">{t('fix.extrudeVramDelta', { bytes: receipt.extrudeVramDelta ?? 0 })}</p>
      ) : null}
      {/* Scale-tier export receipt: tiers/files/assets actually emitted, a reference-changing banner (the
          source was renamed to the top tier; the loader must pick a tier at runtime), the per-device VRAM
          ladder + per-tier sizes (NEVER summed into the headline VRAM row — the runtime loads ONE tier,
          invariant 5), and the explicit disk-grows-by-design note. */}
      {(receipt.scaleTiered?.assets ?? 0) > 0 ? (
        <>
          <p className="font-mono text-[10px] text-warn">⚠ {t('fix.tierWarn')}</p>
          <p className="font-mono text-[10px] text-ink-soft">
            {t('fix.tier.scaleTiered', {
              tiers: receipt.scaleTiered?.tiers ?? 0,
              filesEmitted: receipt.scaleTiered?.filesEmitted ?? 0,
              assets: receipt.scaleTiered?.assets ?? 0,
            })}
          </p>
          {(receipt.tierVram?.length ?? 0) > 0 ? (
            <p className="font-mono text-[10px] text-ink-soft">
              {t('fix.tier.vramLadder', {
                ladder: (receipt.tierVram ?? [])
                  .map((tv) => `${tv.suffix.replace(/^[_-]/, '')} ${fmtBytes(tv.vramBytes)}`)
                  .join(' · '),
              })}
            </p>
          ) : null}
          <p className="font-mono text-[10px] leading-relaxed text-ink-soft/80">{t('fix.tier.diskNote')}</p>
        </>
      ) : null}
      {/* Owner-aware dedup honesty (design §5a / Task 7): surface how many references were repointed, how
          many duplicates were KEPT because their reference may live in game code, the REAL disk saving, and
          the UPPER-BOUND VRAM saving (separate, never folded into the hard VRAM row — invariant 5). */}
      {(receipt.referencesRewritten ?? 0) > 0 ? (
        <p className="font-mono text-[10px] text-ink-soft">{t('fix.dedup.referencesRewritten', { n: receipt.referencesRewritten ?? 0 })}</p>
      ) : null}
      {(receipt.looseRepathSkipped ?? 0) > 0 ? (
        <p className="font-mono text-[10px] text-ink-soft">{t('fix.dedup.looseSkipped', { n: receipt.looseRepathSkipped ?? 0 })}</p>
      ) : null}
      {(receipt.dedupDiskBytesSaved ?? 0) > 0 ? (
        <p className="font-mono text-[10px] text-cta">{t('fix.dedup.diskSaved', { bytes: receipt.dedupDiskBytesSaved ?? 0 })}</p>
      ) : null}
      {(receipt.dedupVramBytesSavedUpperBound ?? 0) > 0 ? (
        <p className="font-mono text-[10px] text-ink-soft">{t('fix.dedup.vramUpperBound', { bytes: receipt.dedupVramBytesSavedUpperBound ?? 0 })}</p>
      ) : null}
      {/* Skipped → first-class list of the honest per-asset reason strings (was a bare count). Skips are
          informational (what the fix REFUSED to touch / couldn't do), not warnings → text-ink-soft. */}
      {receipt.skipped.length > 0 ? (
        <details className="rounded-md border border-line bg-bg p-2 text-left open:pb-2.5">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-ink-soft">
            {t('fix.skipped.title', { n: receipt.skipped.length })}
          </summary>
          <ul className="mt-1.5 space-y-1">
            {receipt.skipped.map((s, i) => (
              <li key={i} className="font-mono text-[10px] leading-relaxed text-ink-soft">
                <span className="break-all">{s.assetRef}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <button type="button" onClick={onRedownload} className="w-full rounded-lg border border-line px-3 py-1.5 font-mono text-[11px] text-teal transition hover:border-teal">
        ↓ {t('fix.download')}
      </button>
    </div>
  );
}

// Dry-run plan preview (docs/improvements/dry-run-plan-preview.md). Shows the FixPlanSummary the worker
// posted in mode:'plan' BEFORE committing a reference-changing paid fix: op COUNTS grouped by kind (the
// SAME OpKind vocabulary + fix.op.<kind> labels + REFERENCE_CHANGING warn coloring as the receipt's
// OpManifest), the pixel-free would-be-skipped list (reused skipped <details> styling), a prominent
// reference-changing banner (reused fix.mergeWarn), and the honesty note (counts only — byte/VRAM savings
// appear AFTER Run; the refs flag is a prediction; tiers are an upper bound). "Run fix" commits the
// IDENTICAL options via the execute path (auto-download); "Back" returns to the options view.
//
// SELECTIVE FIX (docs/improvements/selective-fix.md): each opCounts row is a checkbox, DEFAULT checked (the
// kind runs). Unchecking adds the kind to `excluded` and re-previews IN PLACE via onToggle (counts/refs/skips
// update to reflect the masked plan the worker re-computes — never recomputed client-side, no faked numbers).
// The card stays MOUNTED across a toggle's re-preview (`pending` shows a subtle "updating…" hint, no flicker,
// checkbox focus kept); the worker's masked summary then replaces it. REFERENCE_CHANGING kinds keep the warn
// token; a deselected row is struck through. If EVERY kind is unchecked there is nothing to run ⇒ Run is
// disabled with an honest note (the worker would only emit deselected-skips).
function PlanCard({ summary, excluded, pending, onToggle, onRun, onBack, disabled }: { summary: FixPlanSummary; excluded: Set<OpKind>; pending: boolean; onToggle: (kind: OpKind) => void; onRun: () => void; onBack: () => void; disabled: boolean }) {
  const { t } = useI18n();
  // Counts grouped by kind in the canonical OP_KIND_ORDER (zero kinds were already omitted by the worker).
  const rows = OP_KIND_ORDER.map((k) => [k, summary.opCounts[k]] as const).filter((e): e is readonly [OpKind, number] => (e[1] ?? 0) > 0);
  // Nothing left to run when every shown kind is deselected (the committed run would be a pass-through). Run
  // is disabled with an honest note rather than committing a no-op fix. summary.totalOps>0 ⇒ rows non-empty.
  const allDeselected = rows.length > 0 && rows.every(([kind]) => excluded.has(kind));
  return (
    <div className="mt-2.5 space-y-1.5 text-left">
      <div className="flex items-center justify-center gap-1.5 font-mono text-xs text-teal">
        <span className="h-2 w-2 rounded-full bg-teal" /> {t('fix.plan.title', { n: summary.totalOps })}
        {/* Re-preview in flight after a checkbox toggle: subtle hint, card stays mounted (no flicker). Reuses
            the existing dropzone.analyzing string so no new 9-catalog key is needed (design N3). */}
        {pending ? <span className="font-mono text-[10px] text-ink-soft/70">· {t('dropzone.analyzing')}</span> : null}
      </div>
      {summary.totalOps === 0 ? (
        <p className="font-mono text-[11px] leading-relaxed text-ink-soft">{t('fix.plan.empty')}</p>
      ) : (
        <div className="space-y-0.5 rounded-md bg-bg p-2 font-mono text-[11px]">
          {rows.map(([kind, n]) => {
            const off = excluded.has(kind);
            const ref = REFERENCE_CHANGING.has(kind);
            const label = t(`fix.op.${kind}`);
            return (
              <label key={kind} className="flex cursor-pointer items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={!off}
                    onChange={() => onToggle(kind)}
                    aria-label={t('fix.plan.include', { op: label })}
                    className="accent-teal"
                  />
                  <span className={`${ref ? 'text-warn' : 'text-ink-soft'} ${off ? 'line-through opacity-55' : ''}`}>{label}</span>
                  {off ? <span className="text-[9px] uppercase tracking-[0.06em] text-warn">{t('fix.plan.deselected')}</span> : null}
                </span>
                <span className={`${ref ? 'text-warn' : 'text-ink'} ${off ? 'line-through opacity-55' : ''}`}>{n}</span>
              </label>
            );
          })}
        </div>
      )}
      {/* Prominent reference-changing warning — REUSED receipt banner (fix.mergeWarn): committing this plan
          rewrites manifest/loader references (a prediction; a PNG fallback may still resolve drop-in). */}
      {summary.referencesChanged ? <p className="font-mono text-[10px] text-warn">⚠ {t('fix.mergeWarn')}</p> : null}
      {/* Pixel-free would-be-skips — REUSED skipped <details> styling (informational, text-ink-soft). */}
      {summary.skipped.length > 0 ? (
        <details className="rounded-md border border-line bg-bg p-2 text-left open:pb-2.5">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-ink-soft">
            {t('fix.skipped.title', { n: summary.skipped.length })}
          </summary>
          <ul className="mt-1.5 space-y-1">
            {summary.skipped.map((s, i) => (
              <li key={i} className="font-mono text-[10px] leading-relaxed text-ink-soft">
                <span className="break-all">{s.assetRef}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {/* Honesty note (invariant 5): counts only — byte/VRAM savings appear after Run; refs flag is a
          prediction; tiers are an upper bound; some checks run only at execute. */}
      <p className="font-mono text-[10px] leading-relaxed text-ink-soft/80">{t('fix.plan.deferredNote')}</p>
      {/* All kinds deselected ⇒ nothing to run; honest note + disabled Run (no no-op commit, no faked work). */}
      {allDeselected ? <p className="font-mono text-[10px] text-warn">{t('fix.plan.noneSelected')}</p> : null}
      {/* Primary commit: re-post the IDENTICAL options (incl. the selected excludeKinds mask) with
          mode:'execute' (today's auto-download path). Disabled when nothing is loaded OR all kinds are off. */}
      <button
        type="button"
        onClick={onRun}
        disabled={disabled || allDeselected}
        className="mt-1 w-full rounded-lg bg-cta px-3 py-2 font-sans text-xs font-semibold text-white shadow-[0_2px_6px_rgba(21,160,106,0.32)] transition hover:bg-cta-hover disabled:opacity-55"
      >
        {t('fix.plan.run')}
      </button>
      <button type="button" onClick={onBack} className="w-full rounded-lg border border-line px-3 py-1.5 font-mono text-[11px] text-teal transition hover:border-teal">
        ← {t('fix.plan.back')}
      </button>
    </div>
  );
}

// Per-file change manifest — renders the existing receipt.operations[] free-text trail, grouped by verb
// (groupOps is pure/deterministic), inside a collapsed <details> (precedent: SettingsPanel/PackPanel/…).
// Op strings rendered VERBATIM in mono (they carry the filenames/dims/mime); group headers are the only
// translated chrome. Reference-changing groups (merge/dedup/pack/tier) → text-warn; the rest → text-ink.
function OpManifest({ operations }: { operations: string[] }) {
  const { t } = useI18n();
  if (operations.length === 0) return null;
  const groups = groupOps(operations);
  return (
    <details className="rounded-md border border-line bg-bg p-2 text-left open:pb-2.5">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-teal">
        {t('fix.changes.title', { n: operations.length })}
      </summary>
      <div className="mt-1.5 space-y-2">
        {groups.map((g) => (
          <div key={g.kind ?? 'other'}>
            <p className="font-mono text-[9px] uppercase tracking-[0.06em] text-ink-soft">
              {t(`fix.op.${g.kind ?? 'other'}`)} · {g.rows.length}
            </p>
            <ul className="mt-0.5 space-y-0.5">
              {g.rows.map((row, i) => (
                <li key={i} className={`min-w-0 break-all font-mono text-[10px] leading-relaxed ${g.refChanging ? 'text-warn' : 'text-ink'}`}>
                  {row.text}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}

function ReceiptRow({ label, before, after, pct }: { label: string; before: number; after: number; pct: number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-ink-soft">{label}</span>
      <span>
        <span className="text-ink-soft line-through">{fmtBytes(before)}</span> → <span className="text-ink">{fmtBytes(after)}</span>{' '}
        <span className="text-cta">{pct >= 0 ? `−${pct}%` : `+${-pct}%`}</span>
      </span>
    </div>
  );
}
