import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisReport, BundleAvailability, LazyMarking, SkinGuard } from '@asset-doctor/core';
import type { PackMode, StaticGranularity } from '@asset-doctor/ingest';
import { bundleOf, cmp } from '@asset-doctor/analysis';
import {
  filesFromDataTransfer,
  filesFromInput,
  pickFolder,
  supportsDirectoryPicker,
  type PickedFile,
} from './lib/import';
import { keyOf } from './lib/group';
import { runAnalysis, type Progress } from './lib/worker-client';
import { runFix, type FixOutcome, type FixProgress } from './lib/fix-client';
import type { FixReceipt } from './worker/fix-protocol';
import { fmtBytes, SEVERITY_TEXT } from './lib/format';
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

  async function run() {
    setPhase({ t: 'running', p: { label: '', done: 0, total: 1 } });
    try {
      const out = await runFix(
        files,
        {
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
        },
        (p) => setPhase({ t: 'running', p }),
      );
      downloadZip(out.zip);
      setPhase({ t: 'done', out });
    } catch (e) {
      setPhase({ t: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

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
      {phase.t === 'running' ? (
        <p className="mt-2.5 font-mono text-xs text-teal">{t('fix.optimizing')} {phase.p.total > 1 ? `${phase.p.done}/${phase.p.total}` : ''} {phase.p.label}</p>
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

          <button
            type="button"
            onClick={run}
            disabled={files.length === 0}
            className="mt-2 w-full rounded-lg bg-cta px-3 py-2 font-sans text-xs font-semibold text-white shadow-[0_2px_6px_rgba(21,160,106,0.32)] transition hover:bg-cta-hover disabled:opacity-55"
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
      {receipt.skipped.length > 0 ? <p className="font-mono text-[10px] text-ink-soft">{receipt.skipped.length} {t('fix.skipped')}</p> : null}
      <button type="button" onClick={onRedownload} className="w-full rounded-lg border border-line px-3 py-1.5 font-mono text-[11px] text-teal transition hover:border-teal">
        ↓ {t('fix.download')}
      </button>
    </div>
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
