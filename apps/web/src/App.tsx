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
  const assetFindings =
    report?.findings.filter((f) => f.scope !== 'folder' && f.assetRef === selectedAsset) ?? [];
  const selectedBytes = selectedAsset ? fileMap.get(selectedAsset) : undefined;

  return (
    <div className="min-h-full bg-bg text-ink">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-baseline gap-3">
            <span className="font-display text-xl font-semibold tracking-tight">Asset Doctor</span>
            <span className="font-mono text-xs text-ink-soft">{t('app.tag')}</span>
          </div>
          <div className="flex items-center gap-5">
            {report ? (
              <div className="flex items-center gap-5 font-mono text-xs">
                <Metric label={t('metric.disk')} value={fmtBytes(totals?.diskBytes ?? 0)} />
                <Metric
                  label={t('metric.vram')}
                  value={`${fmtBytes(totals?.vramBytes ?? 0)} → ~${fmtBytes(totals?.loadedVramBytes ?? 0)} ${t('metric.loaded')}`}
                />
                <Metric label={t('metric.saveable')} value={`${fmtBytes(totals?.potentialDiskSaved ?? 0)} · ${savedPct}%`} accent />
              </div>
            ) : (
              <span className="font-mono text-xs text-teal">{t('header.xray')}</span>
            )}
            <LanguageSwitcher />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
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
                  {selectedBytes ? (
                    <FilmViewer bytes={selectedBytes} findings={assetFindings} highlightId={selectedFinding} />
                  ) : (
                    <p className="font-mono text-sm text-ink-soft">{t('report.noImage')}</p>
                  )}
                </div>

                <aside className="space-y-3">
                  <h2 className="font-display text-lg font-semibold">{t('findings.title')}</h2>
                  <Findings findings={assetFindings} selectedId={selectedFinding} onSelect={setSelectedFinding} />
                  <div className="rounded-md border border-dashed border-line p-3 text-center">
                    <p className="font-mono text-xs text-ink-soft">{t('pro.note')}</p>
                    <button
                      type="button"
                      disabled
                      className="mt-2 cursor-not-allowed rounded bg-cta px-3 py-1.5 font-mono text-xs text-white opacity-60"
                    >
                      {t('pro.cta')}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPhase({ t: 'idle' })}
                    className="font-mono text-xs text-teal underline"
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
      className="rounded border border-line bg-panel px-2 py-1 font-mono text-xs text-ink-soft hover:border-ink-soft"
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {NATIVE_NAME[l]}
        </option>
      ))}
    </select>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-ink-soft">{label}</span>
      <span className={accent ? 'text-cta' : 'text-ink'}>{value}</span>
    </span>
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
  const analyzing = phase.t === 'analyzing';
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.items.length) onDrop(e.dataTransfer.items);
      }}
      className="rounded-lg border border-dashed border-line bg-film p-12 text-center"
    >
      <h1 className="font-display text-2xl font-semibold tracking-tight text-white">{t('dropzone.title')}</h1>
      <p className="mx-auto mt-2 max-w-xl font-mono text-xs text-line">{t('dropzone.subtitle')}</p>

      {analyzing ? (
        <div className="mt-6">
          <p className="font-mono text-sm text-teal">
            {t('dropzone.analyzing')}{' '}
            {phase.progress ? t('dropzone.progress', { done: phase.progress.done, total: phase.progress.total, label: phase.progress.label }) : ''}
          </p>
        </div>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="mt-6 rounded bg-cta px-4 py-2 font-mono text-sm text-white"
        >
          {t('dropzone.open')}
        </button>
      )}

      {phase.t === 'error' && <p className="mt-4 font-mono text-xs text-crit">{phase.message}</p>}
      <p className="mt-6 font-mono text-[11px] text-ink-soft">{t('dropzone.footnote')}</p>
    </div>
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
          className={`rounded border px-2 py-1 font-mono text-xs ${
            a.assetRef === selected ? 'border-teal text-ink' : 'border-line text-ink-soft hover:border-ink-soft'
          }`}
        >
          <span className={SEVERITY_TEXT[worst(a.assetRef)]}>●</span> {a.assetRef}
        </button>
      ))}
    </div>
  );
}
