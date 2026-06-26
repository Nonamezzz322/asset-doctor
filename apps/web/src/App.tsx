import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisReport } from '@asset-doctor/core';
import {
  filesFromDataTransfer,
  filesFromInput,
  pickFolder,
  supportsDirectoryPicker,
  type PickedFile,
} from './lib/import';
import { runAnalysis, type Progress } from './lib/worker-client';
import { runFix, type FixOutcome, type FixProgress } from './lib/fix-client';
import type { FixReceipt } from './worker/fix-protocol';
import { fmtBytes, SEVERITY_TEXT } from './lib/format';
import { LOCALES, NATIVE_NAME, useI18n } from './lib/i18n';
import { FilmViewer } from './components/FilmViewer';
import { Findings } from './components/Findings';
import { FolderReport } from './components/FolderReport';

type Phase =
  | { t: 'idle' }
  | { t: 'analyzing'; progress?: Progress }
  | { t: 'done' }
  | { t: 'error'; message: string };

const baseName = (p: string): string => p.split('/').pop() ?? p;

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

  const fileMap = useMemo(() => {
    const m = new Map<string, ArrayBuffer>();
    for (const f of files) m.set(baseName(f.name), f.bytes);
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

// The Phase-2 fix: repack + transcode the loaded folder in a worker, then download a drop-in
// optimized .zip. Free in this build (no monetization yet); assets never leave the device.
function FixCard({ files }: { files: PickedFile[] }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<FixPhase>({ t: 'idle' });

  async function run() {
    setPhase({ t: 'running', p: { label: '', done: 0, total: 1 } });
    try {
      const out = await runFix(files, { targetMime: 'image/avif', quality: 0.85, padding: 2, maxSize: 4096, maxEdge: 2048 }, (p) => setPhase({ t: 'running', p }));
      downloadZip(out.zip);
      setPhase({ t: 'done', out });
    } catch (e) {
      setPhase({ t: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className="rounded-xl border-2 border-teal/70 bg-panel p-4 text-center">
      <p className="font-mono text-xs text-ink-soft">{t('pro.note')}</p>
      {phase.t === 'running' ? (
        <p className="mt-2.5 font-mono text-xs text-teal">{t('fix.optimizing')} {phase.p.total > 1 ? `${phase.p.done}/${phase.p.total}` : ''} {phase.p.label}</p>
      ) : phase.t === 'done' ? (
        <Receipt receipt={phase.out.receipt} onRedownload={() => downloadZip(phase.out.zip)} />
      ) : (
        <button
          type="button"
          onClick={run}
          disabled={files.length === 0}
          className="mt-2.5 w-full rounded-lg bg-cta px-3 py-2 font-sans text-xs font-semibold text-white shadow-[0_2px_6px_rgba(21,160,106,0.32)] transition hover:bg-cta-hover disabled:opacity-55"
        >
          {t('pro.cta')}
        </button>
      )}
      {phase.t === 'error' && <p className="mt-2 font-mono text-[11px] text-crit">{phase.message}</p>}
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
