import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisReport, AssetMetrics, BundleAvailability, ExportFormat, ExportProfile, Finding, FormatTarget, LazyMarking, ProfileOverride, ResolutionTier, ScaleTier, Severity, SkinGuard } from '@asset-doctor/core';
import type { PackMode, StaticGranularity } from '@asset-doctor/ingest';
import { bundleOf, cmp } from '@asset-doctor/analysis';
import { DEFAULT_SCALE_TIERS, RESOLUTION_TOKEN } from '@asset-doctor/fix';
import {
  filesFromDataTransfer,
  filesFromInput,
  pickFolder,
  supportsDirectoryPicker,
  type PickedFile,
} from './lib/import';
import { keyOf } from './lib/group';
import { filmSelectionAction } from './lib/film-selection';
import { readSourceBytes, sourceReaders } from './lib/source-bytes';
import { attachProbeReadings } from './lib/probe-run';
import { runAnalysis, type Progress } from './lib/worker-client';
import { planFix, runFix, type FixOutcome, type FixProgress } from './lib/fix-client';
import type { BackendOptions, FixChange, FixOptions, FixPlanSummary, FixReceipt, NativeOpKind, SheetDiff } from './worker/fix-protocol';
import { fmtBytes } from './lib/format';
import { groupOps, OP_KIND_ORDER, REFERENCE_CHANGING, type OpKind } from './lib/op-manifest';
import { migrationSnippet, type Engine } from './lib/loader-migration';
import { LOCALES, NATIVE_NAME, useI18n } from './lib/i18n';
import { correlateFix } from '@asset-doctor/correlate';
import { renderCorrelated } from '@asset-doctor/i18n';
import { API_BASE, isProUnlocked, loadStoredEntitlement, maybeRefresh, PRO_GATE_ENABLED } from './lib/license';
import { backendReachable } from './lib/backend-client';
import { ActivatePanel, ProBadge } from './components/LicensePanel';
import { FilmViewer } from './components/FilmViewer';
import { Findings } from './components/Findings';
import { VerdictBar } from './components/VerdictBar';
import { TriageLedger } from './components/TriageLedger';
import { useDebounced } from './lib/useDebounced';
import { buildIndex, countCandidates, defaultSelectOpts, DEFAULT_SEVERITIES, DEFAULT_SORT, selectRows, type LedgerRow, type SelectOpts, type SortKey } from './lib/triage';
import { analysisReadyMessage, resultCountMessage } from './lib/announce';

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
  // Round 21 #2: LAZY dir-aware byte readers for the picked folder — keyed by the SAME keyOf the workers/probe
  // use so a basename collision across folders never resolves the wrong bytes. Replaces the former EAGER byte
  // `map` (which captured `f.bytes` BEFORE runAnalysis transferred — and would hold DETACHED buffers after the
  // transfer): each reader RE-READS from disk on demand (lib/source-bytes), so the worker holds the only
  // resident copy of the folder's bytes (the former ~2× copy is gone). Built once per run() (from `picked`)
  // and reused for BOTH the FilmViewer selection AND the render-probe. State (not useMemo) so `run()` writes
  // the same object the probe closes over.
  const [readers, setReaders] = useState<Map<string, () => Promise<ArrayBuffer | null>>>(new Map());
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<string | undefined>();
  const [selectedFinding, setSelectedFinding] = useState<string | undefined>();
  // ── Triage-ledger controls (presentation only — the diagnosis stays byte-accurate). Initial values come
  //    from the ONE canonical defaultSelectOpts() (round11 #3) so they can never drift from run()'s
  //    worst-offender auto-select, which uses the SAME source of truth. ──
  const [sort, setSort] = useState<SortKey>(DEFAULT_SORT);
  const [search, setSearch] = useState(''); // raw input; debounced before it feeds the filter memo.
  const [severityFilter, setSeverityFilter] = useState<Set<Severity>>(() => new Set<Severity>(DEFAULT_SEVERITIES));
  const [problemsOnly, setProblemsOnly] = useState(true);
  const [groupByFolder, setGroupByFolder] = useState(false);
  const [showClean, setShowClean] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Tracks the report identity we have already auto-selected a worst offender for, so the async probe
  // re-set (a NEW report object with the same findings) can never yank the user's selection back to row 0
  // mid-session (round11 correction #1).
  const autoSelectedFor = useRef<AnalysisReport | null>(null);
  // Aborts a still-running run when a fresh analysis starts (round18-abortable-workers): ONE controller
  // now governs BOTH the analysis worker AND the render-probe, so a re-drop terminates the prior worker
  // and drops the stale probe's late results. Lives in a ref (not state) — it's control flow, not render
  // data.
  const probeAbort = useRef<AbortController | null>(null);

  // ── a11y live region (round: aria-live) ─────────────────────────────────────────────────────────────
  // ONE persistent visually-hidden polite region speaks every otherwise-silent analysis transition: the
  // analyzing→done diagnosis-ready moment and the settled "showing N of M" count. It is mounted ONCE at the
  // top of <main> (below) so it survives the Dropzone↔results swap. `nudge` is an alternating trailing-NBSP
  // toggle: when an emit lands the SAME text as before (e.g. clear-then-retype yields an identical count),
  // SRs may not re-announce unchanged textContent — flipping one invisible char forces a fresh announcement.
  // This region concern is deliberately kept OUT of the pure formatters (announce.ts stays string-equal-
  // testable). `emitLive` is the single imperative entry point used by both the run() success path and the
  // count effect; it always flips `nudge` so a repeat string still speaks.
  const [live, setLive] = useState<{ text: string; nudge: boolean }>({ text: '', nudge: false });
  const emitLive = (text: string): void => setLive((prev) => ({ text, nudge: !prev.nudge }));

  useEffect(() => {
    inputRef.current?.setAttribute('webkitdirectory', '');
  }, []);

  async function run(picked: PickedFile[]) {
    if (picked.length === 0) {
      setPhase({ t: 'error', message: t('error.noFiles') });
      return;
    }
    // Abort any in-flight run from a previous drop (the analysis worker AND its probe) before starting a
    // new analysis. The fresh controller is created HERE — before runAnalysis — so the SAME signal aborts
    // the worker too (round18-abortable-workers); it is reused for the probe below.
    probeAbort.current?.abort();
    const ctrl = new AbortController();
    probeAbort.current = ctrl;
    // Round 21 #2: build the LAZY dir-aware readers from `picked`, keyed by the SAME keyOf the workers/probe
    // use (assetRef === atlas.name === keyOf). These readers close over each PickedFile's retained `.file`
    // and re-read from disk on demand — they do NOT touch `.bytes`, so building them BEFORE runAnalysis (which
    // TRANSFERS/detaches `.bytes` into the worker) is safe; the old eager `map.set(keyOf(f), f.bytes)` would
    // instead have captured the about-to-be-detached buffers. This `lazyReaders` IS the object stored in state
    // AND closed over by the probe, so there is exactly ONE resident copy of the folder's bytes (in the worker).
    const lazyReaders = sourceReaders(picked);
    setFiles(picked);
    setReaders(lazyReaders);
    setReport(null);
    setSelectedFinding(undefined);
    setPhase({ t: 'analyzing' });
    try {
      const rep = await runAnalysis(picked, (p) => setPhase({ t: 'analyzing', progress: p }), ctrl.signal);
      // The static result lands FIRST (invariant 4: ≤10s instant-wow is never blocked by the probe).
      setReport(rep);
      // Auto-select the WORST offender (not array-order-first) so the ≤10s payoff lands on a glowing
      // overlay. Computed from the SAME defaultSelectOpts() the ledger opens with (round11 #3 — ONE source
      // of truth, can't drift); falls back to the first asset when there are no problems. Runs ONCE per
      // analysis here (before the probe write-back), and autoSelectedFor is stamped so the probe re-set
      // never re-selects (correction #1).
      const firstIndex = buildIndex(rep);
      const firstRows = selectRows(firstIndex, defaultSelectOpts());
      const worst = firstRows[0];
      setSelectedAsset((worst ?? undefined)?.assetRef ?? rep.assets[0]?.assetRef);
      setSelectedFinding(worst?.scope === 'asset' ? worst.id : undefined);
      autoSelectedFor.current = rep;
      setPhase({ t: 'done' });
      // Speak the diagnosis-ready moment for assistive tech (the ≤10s payoff is otherwise a silent DOM swap).
      // Emitted IMPERATIVELY here — exactly once per analysis, BEFORE the async probe write-back below — so the
      // probe re-set (a NEW report object with the same findings, App.tsx attachProbeReadings) can never
      // re-announce "diagnosis ready". HONEST: problems = crit+warn+info on the SAME freshly-built index
      // VerdictBar/auto-select read; ok/clean and VRAM are never spoken.
      emitLive(analysisReadyMessage(firstIndex.tally, t));
      // THEN, non-blocking, replay each atlas through real offscreen-WebGL (main thread) and fill in
      // the MEASURED draw-calls / decoded-VRAM. Skipped silently when there's no WebGL or no atlas.
      // The probe RE-READS each atlas's bytes from disk on demand via the SAME lazy readers (Round 21 #2 —
      // the worker holds the only resident copy; the accessor is async now). Reuses the SAME `ctrl` created
      // above (a re-drop aborts it ⇒ the worker rejects AbortError before this even attaches; if it attaches
      // and is then aborted, the ctrl.signal.aborted guards drop the write-back).
      void attachProbeReadings(rep, (ref) => lazyReaders.get(ref)?.(), ctrl.signal).then((probed) => {
        // Only write back if this probe wasn't superseded AND it actually produced readings (a new
        // object reference signals readings attached; identity ⇒ nothing measured, leave the report).
        if (!ctrl.signal.aborted && probed !== rep) setReport(probed);
      });
    } catch (e) {
      // A superseded run rejects AbortError — a newer drop now owns the UI, so swallow it (mirrors the
      // openFolder AbortError contract below). round18-abortable-workers.
      if (e instanceof DOMException && e.name === 'AbortError') return;
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

  // ── Triage index + ordered rows. buildIndex is ONE O(assets+findings) pass per report identity (it
  // re-runs on the probe re-set — cheap, and the order is stable because the probe feeds no sort key).
  // selectRows is one pure sort per control change. Search is debounced so keystrokes don't re-sort. ──
  const debouncedSearch = useDebounced(search, 150);
  const index = useMemo(() => (report ? buildIndex(report) : null), [report]);
  // problemsOnly is forced off whenever "show clean" is on, so the synthesized `ok` rows can surface
  // (honest hiding). showClean also drives includeClean — analysis emits no ok finding, so clean assets
  // only become rows when selectRows synthesizes them. Toggling now changes the row set by exactly N clean.
  const effectiveProblemsOnly = problemsOnly && !showClean;
  const selectOpts = useMemo<SelectOpts | null>(
    () =>
      index
        ? {
            sort,
            search: debouncedSearch,
            severityFilter,
            problemsOnly: effectiveProblemsOnly,
            includeClean: showClean,
            groupByFolder,
          }
        : null,
    [index, sort, debouncedSearch, severityFilter, effectiveProblemsOnly, showClean, groupByFolder],
  );
  const rows = useMemo(() => (index && selectOpts ? selectRows(index, selectOpts) : []), [index, selectOpts]);
  // Candidate count under the current severity/clean policy but ignoring search (the "of M" in "showing N
  // of M") — so search visibly narrows N against the stable severity-scoped M. countCandidates does a
  // filter-only pass (no second full sort+group per keystroke — round11 #4); pure, deterministic.
  const totalRows = useMemo(
    () => (index && selectOpts ? countCandidates(index, selectOpts) : 0),
    [index, selectOpts],
  );
  // id → Finding for the ledger's renderFinding titles (O(1), no scan per row).
  const findingById = useMemo(() => {
    const m = new Map<string, Finding>();
    for (const f of report?.findings ?? []) m.set(f.id, f);
    return m;
  }, [report]);

  // Debounce the FilmViewer's input so arrow-key / scroll scrubbing fires ONE decode after settling
  // (invariant 4). The decode effect keys on [bytes, findings, highlightId]; debounce ALL THREE inputs in
  // lockstep so a row click (which moves selectedAsset AND selectedFinding together) settles into exactly one
  // decode — passing the raw highlightId here would fire a SECOND decode of the still-stale image before the
  // settled asset's bytes/findings arrive.
  const debouncedSelected = useDebounced(selectedAsset, 120);
  const debouncedHighlight = useDebounced(selectedFinding, 120);
  // Memoized so an unrelated re-render keeps a STABLE findings array identity → no needless FilmViewer decode.
  // (folder findings now flow into the ledger rows, not a separate FolderReport.)
  const assetFindings = useMemo(
    () => report?.findings.filter((f) => f.scope !== 'folder' && f.assetRef === debouncedSelected) ?? [],
    [report, debouncedSelected],
  );
  // Round 21 #2: the selected film's bytes are RE-READ from disk on demand (the worker holds the only resident
  // copy now). Async ⇒ resolved into state by the effect below, gated by a cancel flag so a rapid re-selection
  // never lands stale bytes on a newer film. null ⇒ no bytes yet (loading) OR the source is unavailable
  // (folder moved/deleted, or a legacy producer with no `file`) → the honest "no image" branch renders, never
  // a fabricated film. The re-read is byte-identical to the original ⇒ identical decode/overlay (Inv 3).
  const [selectedBytes, setSelectedBytes] = useState<ArrayBuffer | null>(null);
  useEffect(() => {
    // Pure decision (film-selection.ts) so the "never blank on a live re-selection" rule is Node-testable.
    const action = filmSelectionAction(!!debouncedSelected, !!debouncedSelected && readers.has(debouncedSelected));
    if (action === 'clear') {
      // No selection OR no reader (folder moved/deleted, or a legacy producer with no `file`) → honest no-image.
      setSelectedBytes(null);
      return;
    }
    let cancelled = false;
    const reader = readers.get(debouncedSelected!)!; // action==='read' ⇒ reader present (filmSelectionAction)
    // Round 24: KEEP the prior film mounted while the new ref re-reads — no blank flash on row click / arrow-
    // scrub. FilmViewer redraws atomically (clearRect→drawImage in one tick) so the canvas shows the PREVIOUS
    // real atlas until the new bytes resolve, then the new one. The cancel flag still guarantees a rapid re-
    // selection never lands stale bytes on a newer film (the newest read always wins).
    void reader().then((b) => {
      if (!cancelled) setSelectedBytes(b);
    });
    return () => {
      cancelled = true;
    };
  }, [debouncedSelected, readers]);
  const selectedMetrics = report?.assets.find((a) => a.assetRef === debouncedSelected);

  // Orphan-reselect: when a filter/sort/search change leaves the current selection out of the visible rows,
  // fall back to the new worst row so the film never goes blank. Gated on autoSelectedFor so it cannot fire
  // from the probe re-set (the probe changes only metric NUMBERS, never which rows are visible — correction #1).
  useEffect(() => {
    if (!report || rows.length === 0) return;
    if (selectedAsset !== undefined && rows.some((r) => r.assetRef === selectedAsset)) return;
    const top = rows[0]!;
    setSelectedAsset(top.assetRef);
    setSelectedFinding(top.scope === 'asset' ? top.id : undefined);
  }, [rows, report, selectedAsset]);

  // a11y: speak the settled "showing N of M" whenever a filter/search/sort changes the visible count. Keyed
  // on the two integers [rows.length, totalRows] — they only change AFTER the existing 150ms search debounce
  // settles (debouncedSearch), so this is naturally debounced with zero new timers and no per-keystroke chatter
  // (PERF: no row iteration). HONEST: announces the EXACT ledger numbers (rows.length / totalRows), never VRAM.
  // The FIRST settle for a fresh report is skipped (countAnnouncedFor guard) because emitLive already spoke
  // "Diagnosis ready. N problems." for that same moment — we only want the count on subsequent control changes.
  const countAnnouncedFor = useRef<AnalysisReport | null>(null);
  useEffect(() => {
    if (!report || phase.t !== 'done') return;
    if (countAnnouncedFor.current !== report) {
      // Fresh report: the diagnosis-ready announcement already covered this settle; arm for the NEXT change.
      countAnnouncedFor.current = report;
      return;
    }
    emitLive(resultCountMessage(rows.length, totalRows, t));
    // Deliberately keyed on the two settled integers (with report/phase as fresh-report guards). `t` and
    // `emitLive` are intentionally NOT deps: keying on `t` would re-announce the count on a mere relocale,
    // and `emitLive` is a per-render closure over the stable setLive — including it would add no signal.
  }, [rows.length, totalRows, report, phase.t]);

  const onRowClick = (row: LedgerRow) => {
    setSelectedAsset(row.assetRef);
    // A folder finding spans many assets ⇒ no single-asset overlay to highlight.
    setSelectedFinding(row.scope === 'asset' ? row.id : undefined);
  };
  const toggleSeverity = (sev: Severity) =>
    setSeverityFilter((prev) => {
      const next = new Set(prev);
      if (next.has(sev)) next.delete(sev);
      else next.add(sev);
      return next;
    });
  // Sprite count for the MEASURED draw-calls readout ("N sprites batched"). Same keying invariant as
  // the probe (assetRef === atlas.name === atlasFrames key). 0 for loose / un-probed assets. Keyed on the
  // debounced asset so it moves in lockstep with the film it annotates.
  const selectedFrameCount = debouncedSelected ? report?.atlasFrames?.[debouncedSelected]?.length ?? 0 : 0;

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
                {/* MEASURED aggregate, additive — appears only once the render-probe has run (WebGL
                    present, ≥1 atlas). It's the REAL decoded footprint, a different quantity from the
                    declared estimate beside it — never a savings delta (BLOCKER1). */}
                {totals?.probe ? (
                  <HeaderMetric
                    label={t('metric.vramMeasured')}
                    value={fmtBytes(totals.probe.vramBytes)}
                    title={t('readout.measuredTooltip')}
                  />
                ) : null}
                <HeaderMetric label={t('metric.saveable')} value={`${fmtBytes(totals?.potentialDiskSaved ?? 0)} · ${savedPct}%`} accent />
              </div>
            ) : null}
            <LanguageSwitcher />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {/* a11y: ONE persistent polite live region, mounted unconditionally as the FIRST child of <main> so it
            survives the Dropzone↔results swap (mounting a region and its text in the same tick is unreliable in
            some SRs). role=status + aria-live=polite for non-urgent announcements; aria-atomic so the whole
            phrase is read, not just a changed number. Visually clipped (.ad-sr-only) — no layout, no focus, no
            new tab stop. It speaks the diagnosis-ready moment and the settled "showing N of M". The trailing
            NBSP toggle (live.nudge) forces re-announcement of an identical string. */}
        <span role="status" aria-live="polite" aria-atomic="true" className="ad-sr-only">
          {live.text}
          {live.nudge ? ' ' : ''}
        </span>
        {phase.t !== 'done' && (
          <Dropzone
            phase={phase}
            onOpen={openFolder}
            onDrop={(dt) => void filesFromDataTransfer(dt).then(run)}
          />
        )}

        {report && phase.t === 'done' && index && selectOpts && (
          <div className="space-y-5">
            <VerdictBar tally={index.tally} severityFilter={severityFilter} onToggle={toggleSeverity} />
            {report.assets.length === 0 && index.rows.length === 0 ? (
              <p className="font-mono text-sm text-ink-soft">{t('report.noAssets')}</p>
            ) : (
              // Two-column x-ray triage board: the virtualized ledger (left, 1fr) drives the sticky film
              // detail (right, minmax(320px,420px) — the existing token). On <lg it stacks; the ledger's
              // own scroll container is the only long scroller.
              <section className="grid items-start gap-6 lg:grid-cols-[1fr_minmax(320px,420px)]">
                <TriageLedger
                  index={index}
                  rows={rows}
                  findingById={findingById}
                  selectedAsset={selectedAsset}
                  opts={selectOpts}
                  setSort={setSort}
                  search={search}
                  setSearch={setSearch}
                  setProblemsOnly={setProblemsOnly}
                  setGroupByFolder={setGroupByFolder}
                  showClean={showClean}
                  setShowClean={setShowClean}
                  totalRows={totalRows}
                  onRowClick={onRowClick}
                />

                <aside className="space-y-3 lg:sticky lg:top-20">
                  {selectedBytes && debouncedSelected ? (
                    <FilmViewer bytes={selectedBytes} findings={assetFindings} highlightId={debouncedHighlight} name={debouncedSelected} metrics={selectedMetrics} frameCount={selectedFrameCount} />
                  ) : (
                    <p className="rounded-xl border border-line bg-panel p-4 font-mono text-sm text-ink-soft">{t('report.noImage')}</p>
                  )}
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
            {report.unparsed?.length ? <UnparsedNotice items={report.unparsed} /> : null}
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
      className="rounded-lg border border-line bg-panel px-2 py-1.5 font-mono text-xs text-ink-soft transition hover:border-teal hover:text-teal focus:border-teal"
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {NATIVE_NAME[l]}
        </option>
      ))}
    </select>
  );
}

function HeaderMetric({ label, value, accent, title }: { label: string; value: string; accent?: boolean; title?: string }) {
  return (
    <div className="bg-panel px-3 py-1.5" title={title}>
      <div className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-soft">{label}</div>
      <div className={`font-mono text-xs font-semibold ${accent ? 'text-cta' : 'text-ink'}`}>{value}</div>
    </div>
  );
}

// Honest "could not analyze" surface — symmetric with the fix receipt's skipped[] list. Reuses the
// fix.skipped <details> styling. Reasons stay English (parser strings, same precedent as fix.skipped).
function UnparsedNotice({ items }: { items: NonNullable<AnalysisReport['unparsed']> }) {
  const { t } = useI18n();
  return (
    <details className="rounded-md border border-line bg-bg p-2 text-left open:pb-2.5">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-ink-soft">
        {t('report.unparsed.title', { n: items.length })}
      </summary>
      <ul className="mt-1.5 space-y-1">
        {items.map((u, i) => (
          <li key={i} className="font-mono text-[10px] leading-relaxed text-ink-soft">
            <span className="break-all">{u.ref}</span> — {u.reason}
          </li>
        ))}
      </ul>
    </details>
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
          // a11y: aria-busy while analysis runs so assistive tech knows the region is updating (cleared the
          // moment phase leaves 'analyzing' — the whole Dropzone unmounts at done, so it can never get stuck on).
          aria-busy={analyzing}
          className={`relative flex min-h-[240px] flex-col items-center justify-center gap-5 overflow-hidden rounded-[10px] border-2 border-dashed px-6 py-10 text-center transition-colors ${
            dragging ? 'border-teal bg-teal/10' : 'border-teal/35'
          }`}
        >
          <div className="ad-scanline" />
          <Logo size={40} />
          {analyzing ? (
            // a11y: the otherwise-silent progress text becomes a polite live region so a SR user who clicked
            // "open folder" hears "analyzing… N/M · label". aria-atomic reads the whole phrase, not just the
            // changed number. No copy/visual change — the existing localized strings are spoken verbatim.
            <p role="status" aria-live="polite" aria-atomic="true" className="font-mono text-sm text-[#9be7e7]">
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

      {/* a11y: role=alert (implicit aria-live=assertive) so a failed parse is announced immediately —
          interrupting is correct for a failure. The message is the existing localized phase.message
          (e.g. error.noFiles) or the raw worker message; nothing is fabricated. */}
      {phase.t === 'error' && <p role="alert" className="mt-3 text-center font-mono text-xs text-crit">{phase.message}</p>}
      <p className="mt-5 text-center font-mono text-[11px] text-ink-soft">{t('dropzone.footnote')}</p>
    </section>
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
              className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-soft transition hover:border-teal focus:border-teal"
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
  opaqueAlpha,
  setOpaqueAlpha,
  bestFormatPerImage,
  setBestFormatPerImage,
  frameRedundancy,
  setFrameRedundancy,
  trimMargin,
  setTrimMargin,
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
  opaqueAlpha: boolean;
  setOpaqueAlpha: (b: boolean) => void;
  bestFormatPerImage: boolean;
  setBestFormatPerImage: (b: boolean) => void;
  frameRedundancy: boolean;
  setFrameRedundancy: (b: boolean) => void;
  trimMargin: boolean;
  setTrimMargin: (b: boolean) => void;
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
      {/* Opaque-alpha (round15): drop the DEAD alpha channel of a fully-opaque image. HONESTY (invariant 5):
          the title states DISK-only — the GPU still allocates RGBA8888, so this is NEVER a VRAM claim. */}
      <label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.settings.opaqueAlphaHint')}>
        <input type="checkbox" checked={opaqueAlpha} onChange={(e) => setOpaqueAlpha(e.target.checked)} className="accent-teal" />
        {t('fix.settings.opaqueAlpha')}
      </label>
      {/* Per-image best format (round17): transcode each loose image to the format the audit MEASURED smallest
          (WebP vs AVIF) instead of one fixed target. HONESTY: bestMime is the measured winner (invariant 3);
          a format transcode is DISK-only (invariant 5 — never a VRAM claim). */}
      <label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.settings.bestFormatHint')}>
        <input type="checkbox" checked={bestFormatPerImage} onChange={(e) => setBestFormatPerImage(e.target.checked)} className="accent-teal" />
        {t('fix.settings.bestFormat')}
      </label>
      {/* Frame-redundancy aliasing (round19) — DEFAULT ON. Byte-identical animation frames within an atlas share
          ONE packed region; every name still resolves, the sheet shrinks, exact VRAM before→after (invariant 5). */}
      <label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.settings.frameRedundancyHint')}>
        <input type="checkbox" checked={frameRedundancy} onChange={(e) => setFrameRedundancy(e.target.checked)} className="accent-teal" />
        {t('fix.settings.frameRedundancy')}
      </label>
      {/* Trim-margin → repack scheduling (round21 #0) — DEFAULT ON. Untrimmed sprites carrying transparent
          padding are tightened to their opaque bounds inside a scheduled repack; every name still resolves, the
          sheet shrinks, exact VRAM before→after (invariant 5). */}
      <label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.settings.trimMarginHint')}>
        <input type="checkbox" checked={trimMargin} onChange={(e) => setTrimMargin(e.target.checked)} className="accent-teal" />
        {t('fix.settings.trimMargin')}
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
              className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink focus:border-teal"
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
              className="w-14 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink focus:border-teal"
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
              className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-soft transition hover:border-teal focus:border-teal"
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
              className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-soft transition hover:border-teal focus:border-teal"
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
          className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-soft transition hover:border-teal focus:border-teal"
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

// OPT-IN backend native KTX2 (docs/improvements/round12-backend-processing.md, Phase 3) — the user-directed
// carve-out of invariants 1 & 2. DEFAULT OFF. KTX2/UASTC is impossible in-browser, so it (and ONLY it, v1)
// moves to an opt-in backend; assets leave the device ONLY on explicit per-run consent. The panel renders
// nothing actionable unless a backend is configured (an API base + a stored entitlement token). It surfaces
// THREE honest costs before any upload (round12 B3/B4): the zip gets bigger (ships both KTX2 and the raster
// page), the VRAM win is conditional (only GPUs with BC7/ASTC/ETC2), and the game must add a KTX2 transcoder
// bundle + Pixi loader. The consent checkbox is enabled ONLY when the gateway healthz probe succeeded; it is
// the explicit "these images are uploaded to the server" acknowledgement, reset every run (never sticky).
function BackendKtx2Panel({
  configured,
  ready,
  ktx2Enable,
  setKtx2Enable,
  pngquantEnable,
  setPngquantEnable,
  resampleEnable,
  setResampleEnable,
  consent,
  setConsent,
  uploadPreview,
}: {
  configured: boolean;
  ready: boolean;
  ktx2Enable: boolean;
  setKtx2Enable: (b: boolean) => void;
  pngquantEnable: boolean;
  setPngquantEnable: (b: boolean) => void;
  resampleEnable: boolean;
  setResampleEnable: (b: boolean) => void;
  consent: boolean;
  setConsent: (b: boolean) => void;
  /** HONEST upper-bound of files that would leave the device under the enabled ops (count + short sample),
   *  surfaced BEFORE consent for transparency (round12). */
  uploadPreview: { count: number; sample: string[] };
}) {
  const { t } = useI18n();
  const anyEnable = ktx2Enable || pngquantEnable || resampleEnable;
  return (
    <details className="mt-2 rounded-md border border-line bg-bg p-2 text-left open:pb-2.5">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-teal">{t('fix.backend.title')}</summary>

      <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-soft/80">{t('fix.backend.hint')}</p>

      {!configured ? (
        // No API base / no entitlement token ⇒ the whole path is unavailable. Stay honest, don't offer it.
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-soft/70">{t('fix.backend.unconfigured')}</p>
      ) : (
        <>
          <label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.backend.ktx2Hint')}>
            <input type="checkbox" checked={ktx2Enable} onChange={(e) => setKtx2Enable(e.target.checked)} className="accent-teal" />
            {t('fix.backend.ktx2')}
          </label>

          {/* round13: the OPT-IN pngquant op (lossy-indexed PNG → smaller DOWNLOAD only; NO GPU/VRAM change).
              Shares this panel's host + consent + reachability. Takes effect with the PNG-lossy profile toggle. */}
          <label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.backend.pngquantHint')}>
            <input type="checkbox" checked={pngquantEnable} onChange={(e) => setPngquantEnable(e.target.checked)} className="accent-teal" />
            {t('fix.backend.pngquant')}
          </label>

          {/* round24: the OPT-IN libvips lanczos3 resample op (high-quality tier downscale; DISK/QUALITY-only,
              NO GPU/VRAM change). Shares this panel's host + consent + reachability. Takes effect on the
              scale-tier downscale path (a real lower tier); the top tier (scale 1) is never resampled. */}
          <label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.backend.resampleHint')}>
            <input type="checkbox" checked={resampleEnable} onChange={(e) => setResampleEnable(e.target.checked)} className="accent-teal" />
            {t('fix.backend.resample')}
          </label>

          {anyEnable ? (
            <>
              {/* Reachability status from the healthz probe (fired only after Pro unlock + a toggle). */}
              <p className={`mt-2 font-mono text-[10px] ${ready ? 'text-ok' : 'text-warn'}`}>
                {ready ? t('fix.backend.reachable') : t('fix.backend.unreachable')}
              </p>

              {/* Honest costs. KTX2 (round12 B3/B4): bigger zip, conditional VRAM, transcoder dependency.
                  pngquant (round13): a SMALLER DOWNLOAD on disk, but ZERO GPU/VRAM change (it decodes to full
                  RGBA8888). Each op's costs shown only when that op is on. */}
              <ul className="mt-2 list-disc space-y-1 pl-4 font-mono text-[10px] leading-relaxed text-ink-soft/80">
                {ktx2Enable ? (
                  <>
                    <li>{t('fix.backend.costZip')}</li>
                    <li>{t('fix.backend.costVram')}</li>
                    <li>{t('fix.backend.costLoader')}</li>
                  </>
                ) : null}
                {pngquantEnable ? <li>{t('fix.backend.costPngquant')}</li> : null}
                {resampleEnable ? <li>{t('fix.backend.costResample')}</li> : null}
              </ul>

              {/* TRANSPARENCY (round12): the EXACT upper-bound count + a short sample of which files would
                  leave the device, shown BEFORE consent. The worker may upload fewer (compose/skip), never
                  more. "up to" keeps it honest (the loaded set is the ceiling). */}
              <div className="mt-2 rounded border border-line bg-panel/60 p-1.5">
                <p className="font-mono text-[10px] font-semibold text-ink">{t('fix.backend.uploadCount', { n: uploadPreview.count })}</p>
                {uploadPreview.sample.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {uploadPreview.sample.map((ref) => (
                      <li key={ref} className="truncate font-mono text-[9px] text-ink-soft" title={ref}>
                        {ref}
                      </li>
                    ))}
                    {uploadPreview.count > uploadPreview.sample.length ? (
                      <li className="font-mono text-[9px] text-ink-soft/70">{t('fix.backend.uploadMore', { n: uploadPreview.count - uploadPreview.sample.length })}</li>
                    ) : null}
                  </ul>
                ) : null}
              </div>

              {/* CONSENT — the explicit "these images are uploaded to the server" acknowledgement. Enabled
                  ONLY when the backend is reachable; unticking it (or losing the backend) cancels the upload
                  path entirely. Default OFF, reset every run (never sticky). */}
              <label className={`mt-2 flex items-start gap-1.5 font-mono text-[10px] ${ready ? 'text-ink' : 'text-ink-soft/50'}`}>
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={!ready}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5 accent-cta"
                />
                <span className="font-semibold">{t('fix.backend.consent')}</span>
              </label>
            </>
          ) : null}
        </>
      )}
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
  resampleAvailable,
}: {
  tierEnable: boolean;
  setTierEnable: (b: boolean) => void;
  /** Suffixes of the lower tiers the user opted into (the scale-1 top tier is always implied). */
  tierSuffixes: Set<string>;
  setTierSuffixes: (s: Set<string>) => void;
  /** round24: the OPT-IN lanczos3 resample backend op is enabled+configured+consented this run, so the tier
   *  DOWNSCALE path will actually use the vips kernel (not the browser resampler). Surfaces a SEPARATE
   *  tier-only hint key — NEVER retargets the existing `whyNoKernel` note (which stays true at the non-tier
   *  sites where resample is not routed). False ⇒ the tier downscale uses the browser resampler as today. */
  resampleAvailable: boolean;
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

          {/* Downscale honesty — REUSE the existing browser-limit notes (no kernel / no pre-blur control).
              round24: when the OPT-IN lanczos3 resample backend op is live this run, the tier DOWNSCALE will
              actually use the vips kernel — surface a SEPARATE tier-only hint (NEVER retarget whyNoKernel,
              which stays true on the non-tier paths where resample is not routed). The whyNoKernel note still
              applies to the in-browser fallback (resample off / declined / hashFilenames on), so both show. */}
          <ul className="space-y-1 border-t border-line pt-2 font-mono text-[10px] leading-relaxed text-ink-soft/80">
            <li>{t('fix.skipped.whyNoKernel')}</li>
            <li>{t('fix.skipped.whyNoPreBlur')}</li>
            {resampleAvailable ? <li className="text-teal">{t('fix.backend.resampleTierHint')}</li> : null}
          </ul>
        </div>
      ) : null}
    </details>
  );
}

// ── Config-driven export profile (round7-export-profile.md §7, T11) — sibling of TierPanel, DEFAULT OFF ──
// Generalizes the single hardcoded format + closed tier ladder into { formats × resolutions × per-format
// compression }. OFF ⇒ exportProfile is undefined ⇒ byte-identical to today; the TierPanel above governs
// tiers. ON ⇒ MUTUALLY EXCLUSIVE with the tier ladder (buildOptions omits scaleTiers + webpNearLossless).
// AVIF lossless is DISABLED in the UI (no honest in-browser path — avifNoLossless note). Custom tiers add
// rows on top of the default ladder; the suffix is validated client-side against RESOLUTION_TOKEN so a
// non-clustering suffix is caught before the run (the worker also validates fail-closed). The shared
// effort/scaleAwareQuality knobs live in SettingsPanel and are folded into the profile's global knobs.

/** Per-format UI settings (the format checkbox state lives in `enabled`). Honest browser subset only. */
export interface ProfileFormatState {
  enabled: boolean;
  /** 0..100 lossy quality (ignored when lossless or for png). */
  quality: number;
  /** webp/png lossless (AVIF disabled in the UI — no honest path). */
  lossless: boolean;
  /** webp near-lossless toggle (maps to near=60 when on; off ⇒ omit ⇒ near off). */
  near: boolean;
  /** PNG ONLY (round13): route this PNG target through the OPT-IN pngquant backend (lossy-indexed
   *  re-compression → smaller download). Maps to FormatTarget.pngLossy. Has effect ONLY when the pngquant
   *  backend op is also enabled + consented; otherwise the worker emits a lossless PNG (honest fallback).
   *  DISK-ONLY — no VRAM change. Off ⇒ ordinary native-lossless PNG (byte-identical to today). */
  pngLossy?: boolean;
}

export const FORMAT_KEYS: { mime: ExportFormat; key: string }[] = [
  { mime: 'image/png', key: 'fix.profile.format.png' },
  { mime: 'image/webp', key: 'fix.profile.format.webp' },
  { mime: 'image/avif', key: 'fix.profile.format.avif' },
];

/** One UI override rule (round10-profile-overrides.md §6). `match` is a dir-aware prefix / exact ref /
 *  `type:loose|pixi|spine` key; `mode` chooses the headline preset (Fonts→AVIF 4:4:4) or a quality/lossless
 *  overlay. Mapped to a core ProfileOverride in the exportProfile memo; blank `match` rows are dropped so a
 *  half-typed row never silently matches. DISTINCT from the legacy SettingsPanel per-folder overrides
 *  (opts.overrides) — these ride INSIDE the export profile and govern its per-ref fan-out. */
export type OverrideMode = 'fonts444' | 'quality' | 'lossless';
export interface UiOverride {
  match: string;
  mode: OverrideMode;
  /** Lossy quality 0..100 for the 'quality' (and 'fonts444' AVIF) modes; ignored for 'lossless'. */
  quality?: number;
}

export const OVERRIDE_MODE_KEYS: { mode: OverrideMode; key: string }[] = [
  { mode: 'quality', key: 'fix.profile.overrideMode.quality' },
  { mode: 'lossless', key: 'fix.profile.overrideMode.lossless' },
  { mode: 'fonts444', key: 'fix.profile.overrideMode.fonts444' },
];

function ExportProfilePanel({
  profileEnable,
  setProfileEnable,
  formats,
  setFormats,
  customTiers,
  setCustomTiers,
  overrides,
  setOverrides,
}: {
  profileEnable: boolean;
  setProfileEnable: (b: boolean) => void;
  formats: Record<ExportFormat, ProfileFormatState>;
  setFormats: (f: Record<ExportFormat, ProfileFormatState>) => void;
  /** Extra resolution rows on top of the default ladder (the scale-1 top tier is always implied). */
  customTiers: ResolutionTier[];
  setCustomTiers: (t: ResolutionTier[]) => void;
  /** Per-folder/prefix override rules (round10). Empty ⇒ no `overrides` ⇒ additive (byte-identical). */
  overrides: UiOverride[];
  setOverrides: (o: UiOverride[]) => void;
}) {
  const { t } = useI18n();
  const patch = (mime: ExportFormat, p: Partial<ProfileFormatState>): void => setFormats({ ...formats, [mime]: { ...formats[mime], ...p } });
  const addTier = (): void => setCustomTiers([...customTiers, { label: '0.5×', scale: 0.5, suffix: '_540p' }]);
  const patchTier = (i: number, p: Partial<ResolutionTier>): void => setCustomTiers(customTiers.map((tt, j) => (j === i ? { ...tt, ...p } : tt)));
  const removeTier = (i: number): void => setCustomTiers(customTiers.filter((_, j) => j !== i));
  // round10 override-rule editor: the fonts-444 preset + generic add/remove rows. Opt-in only — the default
  // is [] (a non-empty default would break byte-identity). A fonts-444 preset row is the headline use.
  const addFonts444 = (): void => setOverrides([...overrides, { match: 'fonts', mode: 'fonts444', quality: 85 }]);
  const addOverride = (): void => setOverrides([...overrides, { match: '', mode: 'quality', quality: 85 }]);
  const patchOverride = (i: number, p: Partial<UiOverride>): void => setOverrides(overrides.map((o, j) => (j === i ? { ...o, ...p } : o)));
  const removeOverride = (i: number): void => setOverrides(overrides.filter((_, j) => j !== i));

  return (
    <details className="mt-2 rounded-md border border-line bg-bg p-2 text-left open:pb-2.5">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-teal">{t('fix.profile.title')}</summary>

      <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-soft/80">{t('fix.profile.hint')}</p>

      <label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft">
        <input type="checkbox" checked={profileEnable} onChange={(e) => setProfileEnable(e.target.checked)} className="accent-teal" />
        {t('fix.profile.enable')}
      </label>

      {profileEnable ? (
        <div className="mt-2 space-y-3">
          {/* ── Formats ── */}
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-soft/70">{t('fix.profile.formats')}</p>
            <div className="mt-1 space-y-2">
              {FORMAT_KEYS.map(({ mime, key }) => {
                const f = formats[mime];
                const isAvif = mime === 'image/avif';
                const isPng = mime === 'image/png';
                return (
                  <div key={mime} className="rounded border border-line/70 p-1.5">
                    <label className="flex items-center gap-1.5 font-mono text-[10px] text-ink-soft">
                      <input type="checkbox" checked={f.enabled} onChange={(e) => patch(mime, { enabled: e.target.checked })} className="accent-teal" />
                      {t(key)}
                    </label>
                    {f.enabled ? (
                      <div className="mt-1.5 space-y-1 pl-4">
                        {/* PNG is native-lossless; quality slider hidden. WebP/AVIF: hide quality when lossless. */}
                        {!isPng && !f.lossless ? (
                          <label className="flex items-center justify-between font-mono text-[10px] text-ink-soft">
                            <span>
                              {t('fix.profile.quality')} <span className="text-ink">{f.quality}</span>
                            </span>
                            <input type="range" min={0} max={100} step={1} value={f.quality} onChange={(e) => patch(mime, { quality: Number(e.target.value) })} className="ml-2 w-1/2 accent-teal" />
                          </label>
                        ) : null}
                        {/* Lossless — DISABLED for AVIF (no honest path; avifNoLossless note). */}
                        <label className="flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={isAvif ? t('fix.profile.avifNoLossless') : undefined}>
                          <input type="checkbox" checked={!isAvif && f.lossless} disabled={isAvif} onChange={(e) => patch(mime, { lossless: e.target.checked })} className="accent-teal disabled:opacity-60" />
                          {t('fix.profile.lossless')}
                        </label>
                        {/* PNG lossy (round13 pngquant) — the OPT-IN backend-routed lossy-indexed PNG (smaller
                            download, NO VRAM change). Sibling to the AVIF-4:4:4 override preset. Effective only
                            when the pngquant backend op is also enabled + consented; else a lossless PNG ships. */}
                        {isPng ? (
                          <label className="flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.profile.pngLossyHint')}>
                            <input type="checkbox" checked={!!f.pngLossy} onChange={(e) => patch(mime, { pngLossy: e.target.checked })} className="accent-teal" />
                            {t('fix.profile.pngLossy')}
                          </label>
                        ) : null}
                        {/* WebP near-lossless (ignored when lossless on). */}
                        {mime === 'image/webp' && !f.lossless ? (
                          <label className="flex items-center gap-1.5 font-mono text-[10px] text-ink-soft">
                            <input type="checkbox" checked={f.near} onChange={(e) => patch(mime, { near: e.target.checked })} className="accent-teal" />
                            {t('fix.profile.nearLossless')}
                          </label>
                        ) : null}
                        {isAvif ? <p className="font-mono text-[9px] leading-relaxed text-ink-soft/70">{t('fix.profile.avifNoLossless')}</p> : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Resolutions: the default ladder is always available; custom rows add to it ── */}
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-soft/70">{t('fix.profile.resolutions')}</p>
            <p className="mt-1 font-mono text-[10px] leading-relaxed text-ink-soft/80">
              {DEFAULT_SCALE_TIERS.map((tt) => tt.suffix).join('  ')}
            </p>
            {customTiers.map((tt, i) => {
              const validSuffix = RESOLUTION_TOKEN.test(tt.suffix);
              return (
                <div key={i} className="mt-1 flex items-center gap-1.5">
                  <span className="font-mono text-[10px] text-ink-soft">{t('fix.profile.tierScale')}</span>
                  <input
                    type="number"
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={tt.scale}
                    onChange={(e) => patchTier(i, { scale: Number(e.target.value) })}
                    className="w-16 rounded border border-line bg-panel px-1 font-mono text-[10px] text-ink"
                  />
                  <input
                    type="text"
                    value={tt.suffix}
                    onChange={(e) => patchTier(i, { suffix: e.target.value })}
                    placeholder="_540p"
                    className={`w-20 rounded border bg-panel px-1 font-mono text-[10px] text-ink ${validSuffix ? 'border-line' : 'border-crit'}`}
                  />
                  <button type="button" onClick={() => removeTier(i)} className="font-mono text-[10px] text-crit hover:underline" aria-label="remove">
                    ✕
                  </button>
                  {!validSuffix ? <span className="font-mono text-[9px] text-crit">{t('fix.profile.tierBadSuffix', { suffix: tt.suffix })}</span> : null}
                </div>
              );
            })}
            <button type="button" onClick={addTier} className="mt-1 font-mono text-[10px] text-teal hover:underline">
              + {t('fix.profile.addTier')}
            </button>
          </div>

          {/* ── Per-folder overrides (round10) — opt-in rules: a fonts→AVIF 4:4:4 preset + generic rows ── */}
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-soft/70">{t('fix.profile.overrides')}</p>
            <p className="mt-1 font-mono text-[10px] leading-relaxed text-ink-soft/80">{t('fix.profile.overridesHint')}</p>
            {overrides.map((o, i) => (
              <div key={i} className="mt-1 flex flex-wrap items-center gap-1.5">
                <input
                  type="text"
                  value={o.match}
                  onChange={(e) => patchOverride(i, { match: e.target.value })}
                  placeholder={t('fix.profile.overrideMatchPlaceholder')}
                  className="w-28 rounded border border-line bg-panel px-1 font-mono text-[10px] text-ink"
                />
                <select
                  value={o.mode}
                  onChange={(e) => patchOverride(i, { mode: e.target.value as OverrideMode })}
                  className="rounded border border-line bg-panel px-1 font-mono text-[10px] text-ink"
                >
                  {OVERRIDE_MODE_KEYS.map(({ mode, key }) => (
                    <option key={mode} value={mode}>
                      {t(key)}
                    </option>
                  ))}
                </select>
                {o.mode !== 'lossless' ? (
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={o.quality ?? 85}
                    onChange={(e) => patchOverride(i, { quality: Number(e.target.value) })}
                    className="w-14 rounded border border-line bg-panel px-1 font-mono text-[10px] text-ink"
                  />
                ) : null}
                <button type="button" onClick={() => removeOverride(i)} className="font-mono text-[10px] text-crit hover:underline" aria-label="remove">
                  ✕
                </button>
              </div>
            ))}
            <div className="mt-1 flex flex-wrap gap-3">
              <button type="button" onClick={addFonts444} className="font-mono text-[10px] text-teal hover:underline">
                + {t('fix.profile.overrideFonts444')}
              </button>
              <button type="button" onClick={addOverride} className="font-mono text-[10px] text-teal hover:underline">
                + {t('fix.profile.addOverride')}
              </button>
            </div>
          </div>

          {/* Honesty notes — reuse browser-limit disclosures + the profile-specific bundle/disk notes. */}
          <ul className="space-y-1 border-t border-line pt-2 font-mono text-[10px] leading-relaxed text-ink-soft/80">
            <li>{t('fix.profile.noBundleNote')}</li>
            <li>{t('fix.profile.diskNote')}</li>
            <li>{t('fix.skipped.whyNoKernel')}</li>
            <li>{t('fix.skipped.whyNoPreBlur')}</li>
            <li>{t('fix.skipped.whyNoPngquant')}</li>
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
  // Opaque-alpha (round15) — own Pro toggle, DEFAULT OFF. The fix for `wasted-alpha` findings: re-encode a
  // fully-opaque image WITHOUT its dead alpha channel for a DISK saving (invariant 5 — NEVER a VRAM claim;
  // the GPU still allocates RGBA8888). Off ⇒ no transcode op carries `opaque` ⇒ byte-identical to today.
  const [opaqueAlpha, setOpaqueAlpha] = useState(false);
  // Per-image MEASURED best-format pick (round17) — own Pro toggle, DEFAULT OFF. The diagnosis ALREADY
  // measured the smallest real encode per loose image (WebP vs AVIF); when ON the fix transcodes each image
  // to its measured winner instead of one fixed format for all. HONESTY: bestMime is the MEASURED winner
  // (invariant 3); a format transcode is DISK-only (invariant 5). Off ⇒ every op carries the global target
  // ⇒ byte-identical to today. An active export profile / a per-folder override still take precedence.
  const [bestFormatPerImage, setBestFormatPerImage] = useState(false);
  // Frame-redundancy aliasing (round19) — DEFAULT ON (drop-in, lossless, shrinks the sheet). Byte-identical
  // animation frames within an atlas are aliased onto ONE shared packed region — every original name still
  // resolves, the sheet is smaller, exact VRAM before→after (invariant 5, no estimate). Off ⇒ no hashing, no
  // new op, no aliasing ⇒ byte-identical to today (the frame-redundancy finding stays a diagnosis-only verdict).
  const [frameRedundancy, setFrameRedundancy] = useState(true);
  // Trim-margin → repack scheduling (round21 #0) — DEFAULT ON (drop-in, lossless, shrinks the sheet). UNtrimmed
  // sprites carrying transparent padding get tightened to their opaque bounds inside a scheduled repack — every
  // name still resolves (trimmed:true + spriteSourceSize), the sheet is smaller, exact VRAM before→after
  // (invariant 5, no estimate). Off ⇒ no bboxes fed, no new op, no trim ⇒ byte-identical to today (the
  // trim-margin finding stays a diagnosis-only verdict).
  const [trimMargin, setTrimMargin] = useState(true);
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

  // Config-driven export profile (round7-export-profile.md §7, T11/T12) — own Pro opt-in, DEFAULT OFF.
  // OFF ⇒ exportProfile is undefined ⇒ byte-identical to today (the tier ladder above governs tiers). ON
  // ⇒ MUTUALLY EXCLUSIVE with scaleTiers + webpNearLossless (omitted in buildOptions). Defaults reproduce
  // today's single emit (AVIF q85) so a freshly-enabled profile with no edits is a no-surprise baseline.
  const [profileEnable, setProfileEnable] = useState(false);
  const [profileFormats, setProfileFormats] = useState<Record<ExportFormat, ProfileFormatState>>(() => ({
    'image/png': { enabled: false, quality: 85, lossless: true, near: false, pngLossy: false },
    'image/webp': { enabled: false, quality: 85, lossless: false, near: false },
    'image/avif': { enabled: true, quality: 85, lossless: false, near: false },
  }));
  const [customTiers, setCustomTiers] = useState<ResolutionTier[]>([]);
  // round10-profile-overrides.md §6: per-folder override RULES (the fonts→AVIF 4:4:4 preset + generic rows).
  // DEFAULT [] (opt-in only — a non-empty default would break byte-identity). Mapped to ProfileOverride[] in
  // the exportProfile memo; empty ⇒ no `overrides` field ⇒ additive (byte-identical to a no-override run).
  const [profileOverrides, setProfileOverrides] = useState<UiOverride[]>([]);
  // PixiJS-v8 asset manifest (round8-pixi-manifest.md C6) — its OWN Pro opt-in, DEFAULT OFF. ON ⇒ the fix
  // output gains an additive `manifest.json` mapping every emitted image/sheet so a PixiJS game can load the
  // whole folder with one Assets.init({ manifest }). OFF ⇒ buildOptions omits it ⇒ zip byte-identical to today.
  const [emitPixiManifest, setEmitPixiManifest] = useState(false);
  // AssetPack includeFileSizes parity (round23 #2) — adds `progressSize` (KB, 2dp) to each manifest src so
  // PixiJS shows accurate load progress. DEFAULT OFF ('off' ⇒ buildOptions omits it ⇒ bare-string src ⇒
  // manifest byte-identical to today). 'raw' = uncompressed KB; 'gzip' = REAL gzipped KB. Gated on the Pixi
  // manifest being emitted (a bare-string manifest has no src objects to carry a size).
  const [includeFileSizes, setIncludeFileSizes] = useState<'off' | 'raw' | 'gzip'>('off');
  // Content-hash cache-busting (round9-cache-busting.md K9) — its OWN Pro opt-in, DEFAULT OFF. ON ⇒ every
  // emitted image/sheet AD references is renamed name.<hash>.ext (hash = sha256 of the final bytes) and every
  // referrer is repointed (atlas meta.image / Spine .atlas line 0 / the Pixi manifest src[] / dedup consumer
  // meta.image / the loader-migration rows). Pairs with emitPixiManifest (the manifest is the guaranteed
  // referrer for pass-through loose images). OFF ⇒ buildOptions omits it ⇒ zip byte-identical to today.
  const [hashFilenames, setHashFilenames] = useState(false);

  // ── OPT-IN backend native KTX2 (docs/improvements/round12-backend-processing.md, Phase 3) ───────────
  // The user-directed amendment of invariants 1 & 2: native-only ops (KTX2/UASTC, impossible in-browser)
  // move to an OPT-IN backend; assets leave the device ONLY on explicit per-run consent. SAFETY: when the
  // backend is unconfigured (no VITE_API_BASE) OR not opted-in OR not consented, buildOptions omits the
  // `backend` field ⇒ the worker's whole KTX2 path is dead ⇒ zip BYTE-IDENTICAL to today.
  //
  // `ktx2Enable` = the user turned the KTX2 toggle on (offer native compression). `backendConsent` = the
  // per-run "these images are sent to the server" acknowledgement — RESET to false on every option change
  // (and on a fresh preview) so consent is never sticky across runs. `backendReady` = the gateway healthz
  // probe succeeded (fired ONLY after Pro unlock + a configured host). A backend is "configured" when an
  // API base is set AND we hold a stored entitlement token (the gateway requires the Bearer token).
  const backendConfigured = API_BASE !== '' && loadStoredEntitlement() != null;
  const [ktx2Enable, setKtx2Enable] = useState(false);
  // round13: the OPT-IN pngquant op (lossy-indexed PNG → smaller download, DISK-ONLY). Shares the SAME
  // backend host + consent + healthz gate as KTX2 (no new privacy surface). DEFAULT OFF ⇒ no `pngquant` op
  // forwarded ⇒ the worker's pngquant path is dead ⇒ byte-identical to today.
  const [pngquantEnable, setPngquantEnable] = useState(false);
  // round24: the OPT-IN libvips lanczos3 resample op (high-quality tier DOWNSCALE → measured high-frequency
  // retention; DISK/QUALITY-only, NO GPU/VRAM change). Shares the SAME backend host + consent + healthz gate.
  // DEFAULT OFF ⇒ no `resample` op forwarded ⇒ the worker's resample path is dead ⇒ byte-identical to today.
  const [resampleEnable, setResampleEnable] = useState(false);
  // Any backend op being enabled opens the shared backend path (healthz probe + consent).
  const backendAnyEnable = ktx2Enable || pngquantEnable || resampleEnable;
  const [backendConsent, setBackendConsent] = useState(false);
  const [backendReady, setBackendReady] = useState(false);

  // round12 B-transparency: BEFORE the user consents, surface the EXACT count + a short sample of which
  // files would leave the device. This is an HONEST UPPER BOUND from the loaded folder (the worker may
  // compose/skip fewer at execute, never more): KTX2 can transcode any raster page (every image file);
  // pngquant only re-compresses PNG pages. The union of the enabled ops' candidate sets — deterministic,
  // dir-aware (the SAME keyOf the worker keys by), pure presentation (no bytes read, no network).
  const uploadPreview = useMemo(() => {
    if (!backendAnyEnable) return { count: 0, sample: [] as string[] };
    const refs: string[] = [];
    for (const f of files) {
      const ref = keyOf(f);
      const isPng = /\.png$/i.test(ref);
      const isImage = /\.(png|webp|jpe?g|avif)$/i.test(ref);
      // KTX2 ⇒ any raster page; pngquant ⇒ PNG only; resample ⇒ any raster page that a tier downscale could
      // emit (honest UPPER bound — the worker uploads only the actually-tiered, hashFilenames-off refs at
      // execute, never more). Union when multiple ops are enabled.
      if ((ktx2Enable && isImage) || (pngquantEnable && isPng) || (resampleEnable && isImage)) refs.push(ref);
    }
    refs.sort(cmp);
    return { count: refs.length, sample: refs.slice(0, 8) };
  }, [files, backendAnyEnable, ktx2Enable, pngquantEnable, resampleEnable]);
  // Derive the ExportProfile the worker consumes. Formats kept in the canonical FORMAT_KEYS order (PNG,
  // WebP, AVIF) — deterministic. Tiers = the implied scale-1 top (validateProfile requires it) + any custom
  // rows. Per-format compression: PNG is native-lossless (no quality field); WebP/AVIF carry quality unless
  // lossless; WebP `near` maps to 60 (matching the shared near-lossless preset). Undefined when disabled OR
  // no format selected (the worker would reject an empty-formats profile — never send a known-bad one).
  const exportProfile: ExportProfile | undefined = useMemo(() => {
    if (!profileEnable) return undefined;
    const formats: FormatTarget[] = FORMAT_KEYS.filter(({ mime }) => profileFormats[mime].enabled).map(({ mime }) => {
      const f = profileFormats[mime];
      if (mime === 'image/png') return { format: mime, ...(f.pngLossy ? { pngLossy: true } : {}) }; // native lossless unless pngLossy (round13 pngquant)
      if (mime === 'image/webp') return { format: mime, ...(f.lossless ? { lossless: true } : { quality: f.quality, ...(f.near ? { near: 60 } : {}) }) };
      return { format: mime, quality: f.quality }; // AVIF: lossy only (UI disables lossless)
    });
    if (formats.length === 0) return undefined;
    const tiers: ResolutionTier[] = [{ label: '1080p (full)', scale: 1, suffix: '_1080p' }, ...customTiers];
    // round10-profile-overrides.md §6: map the UI rules → core ProfileOverride[]. Drop blank-match rows (a
    // half-typed row must never silently match). fonts444 ⇒ REPLACE formats with one AVIF target + merge
    // avifSubsample:3 (the headline 4:4:4); lossless ⇒ a lossless overlay; quality ⇒ a quality overlay.
    // OMIT the `overrides` field entirely when empty ⇒ the worker resolver no-ops ⇒ byte-identical (additive).
    const overrides: ProfileOverride[] = profileOverrides
      .filter((o) => o.match.trim() !== '')
      .map((o) =>
        o.mode === 'fonts444'
          ? { match: o.match, formats: [{ format: 'image/avif', quality: o.quality ?? 85 }], avifSubsample: 3 }
          : o.mode === 'lossless'
            ? { match: o.match, lossless: true }
            : { match: o.match, quality: o.quality ?? 85 },
      );
    return { formats, tiers, ...(overrides.length > 0 ? { overrides } : {}) };
  }, [profileEnable, profileFormats, customTiers, profileOverrides]);

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

  // OPT-IN backend healthz probe (round12 §4 + round13): fire the GET probe ONLY AFTER Pro unlock + a
  // configured host + EITHER backend op toggle ON (ktx2 or pngquant), so a non-paying / pre-opt-in visitor's
  // browser never pings the encoder host on page load. Re-probes whenever those preconditions flip. NO token,
  // NO bytes (backendReachable is a bare GET). When unreachable, the consent step stays disabled with an
  // honest "backend unreachable" note.
  useEffect(() => {
    if (!(unlocked && backendAnyEnable && backendConfigured)) {
      setBackendReady(false);
      return;
    }
    let alive = true;
    void (async () => {
      const ok = await backendReachable(API_BASE);
      if (alive) setBackendReady(ok);
    })();
    return () => {
      alive = false;
    };
  }, [unlocked, backendAnyEnable, backendConfigured]);

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
      // ROUND7 T12: webpNearLossless is MUTUALLY EXCLUSIVE with an export profile — the profile carries its
      // own per-format near-lossless, so omit the legacy global knob when a profile is sent (no double-source).
      webpNearLossless: !exportProfile && webpNearLossless ? 60 : undefined,
      pngRecompressLevel: pngRecompress ? 2 : undefined,
      // Opaque-alpha (round15) — forwarded only when enabled; off ⇒ undefined ⇒ no transcode op carries
      // `opaque` ⇒ byte-identical to today. DISK-only saving (invariant 5 — never a VRAM claim).
      opaqueAlpha: opaqueAlpha || undefined,
      // Per-image MEASURED best-format pick (round17) — forwarded only when enabled; off ⇒ undefined ⇒ every
      // loose transcode op carries the global targetMime ⇒ byte-identical to today (the fixed-target path).
      // When ON, the plan routes each loose `format` transcode to the diagnosis-measured winner (params.
      // bestMime). An active exportProfile / a per-folder override still take precedence (worker-side). DISK-
      // only (invariant 5 — both formats decode to RGBA8888); honest (invariant 3 — bestMime is measured).
      bestFormatPerImage: bestFormatPerImage || undefined,
      // Frame-redundancy aliasing (round19) — DEFAULT ON. The worker treats undefined as ON, so we only send
      // `false` when the user opts OUT (keeps a default run's option bag byte-identical to today's absent
      // field). ON ⇒ duplicate frames alias onto one packed region (drop-in, exact VRAM before→after).
      frameRedundancy: frameRedundancy ? undefined : false,
      // Trim-margin → repack scheduling (round21 #0) — DEFAULT ON. The worker treats undefined as ON, so we
      // only send `false` when the user opts OUT (keeps a default run's option bag byte-identical to today's
      // absent field). ON ⇒ untrimmed sprites are tightened to their opaque bounds inside a scheduled repack
      // (drop-in, exact VRAM before→after).
      trimMargin: trimMargin ? undefined : false,
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
      // ROUND7 T12: MUTUALLY EXCLUSIVE with the export profile — when a profile is sent it is the SOLE
      // source of formats + resolutions, so scaleTiers is omitted (never both feed the tier axis, B3).
      scaleTiers: !exportProfile && scaleTiers.length > 1 ? scaleTiers : undefined,
      // Config-driven export profile (round7-export-profile.md §7) — forwarded only when enabled with ≥1
      // format. Undefined ⇒ byte-identical to today. When sent it SUPERSEDES targetMime/scaleTiers/
      // webpNearLossless for the loose/tier paths; the worker validates it fail-closed.
      exportProfile,
      // Edge-extrude (bleed) — only forwarded when > 0; off ⇒ undefined ⇒ no gutter, byte-identical
      // to today. The plan sets each repack/pack op's symmetric gutter >= extrude (invariant 5: a
      // gutter can grow a sheet ⇒ VRAM reported honestly via extrudeVramDelta).
      extrude: extrude > 0 ? extrude : undefined,
      // Selective fix — the deselected OpKinds (empty ⇒ undefined ⇒ full fix, byte-identical to today).
      // The worker SKIPS each excluded kind and surfaces an honest skipped[] note (never a silent drop).
      excludeKinds: exclude.size > 0 ? [...exclude] : undefined,
      // PixiJS-v8 asset manifest (round8-pixi-manifest.md) — forwarded when the user enabled it OR a backend
      // op will engage (round12 auto-pair: the .ktx2 sibling / re-compressed PNG needs loader wiring, else it
      // ships orphaned). Off + no consented backend ⇒ undefined ⇒ no manifest ⇒ zip byte-identical to today.
      emitPixiManifest: effectiveEmitManifest || undefined,
      // AssetPack includeFileSizes parity (round23 #2) — forwarded only when the manifest is actually emitted
      // AND the user picked a real mode. UI values ARE the contract values ('raw'/'gzip') — no remap. 'off' or
      // no manifest ⇒ undefined ⇒ bare-string src ⇒ manifest byte-identical to today.
      includeFileSizes: effectiveEmitManifest && includeFileSizes !== 'off' ? includeFileSizes : undefined,
      // Content-hash cache-busting (round9-cache-busting.md) — forwarded only when enabled; off ⇒ undefined
      // ⇒ no hashing branch runs in the worker ⇒ zip byte-identical to today.
      hashFilenames: hashFilenames || undefined,
      // OPT-IN backend native KTX2 (round12-backend-processing.md, Phase 3) — the SOLE place a `backend`
      // field is set. Forwarded ONLY when ALL of: KTX2 enabled, a backend configured (API base + stored
      // token), the healthz probe succeeded, AND the user ticked per-run consent. Any missing precondition ⇒
      // omitted ⇒ the worker's KTX2 path is dead ⇒ zip BYTE-IDENTICAL to today (the default browser fix).
      // `consent` carries the explicit "these images are uploaded" acknowledgement to the worker; the worker
      // double-checks it before any upload (defense in depth).
      backend: buildBackendOptions(),
    };
  }

  /** The `backend` FixOptions field, or undefined when ANY precondition is unmet (default OFF). HONESTY: the
   *  token comes from the stored entitlement; consent is the live per-run checkbox. `ops` lists EXACTLY the
   *  native ops the user opted into (ktx2 and/or pngquant) — empty ⇒ the worker has nothing to offer (we omit
   *  the whole field). Both ops share the SAME host + token + consent (no new privacy surface). */
  function buildBackendOptions(): BackendOptions | undefined {
    if (!(backendAnyEnable && backendConfigured && backendReady && backendConsent)) return undefined;
    const stored = loadStoredEntitlement();
    if (!stored) return undefined; // configured implies a token, but never send without one
    const ops: NativeOpKind[] = [];
    if (ktx2Enable) ops.push('ktx2');
    if (pngquantEnable) ops.push('pngquant');
    if (resampleEnable) ops.push('resample');
    if (ops.length === 0) return undefined; // nothing opted in ⇒ dead path
    return { apiBase: API_BASE, token: stored.token, ops, consent: true };
  }

  // round12 orphan-fix: a backend op emits new/changed files (a `.ktx2` sibling; a re-compressed PNG) that a
  // PixiJS game can only LOAD if the manifest maps them. AUTO-PAIR the Pixi manifest the moment the backend
  // path will actually engage (consent given + reachable + an op chosen) so no orphan ships. ADDITIVITY: this
  // can only flip to true on an explicit consented backend run — the default/off/un-consented path leaves
  // emitPixiManifest exactly as the user set it ⇒ byte-identical to today. Surfaced visibly (forced checkbox
  // + note) so the auto-enable is never silent.
  const backendWillUpload = backendAnyEnable && backendConfigured && backendReady && backendConsent && loadStoredEntitlement() != null;
  const effectiveEmitManifest = emitPixiManifest || backendWillUpload;

  // Monotonic preview request id — guards against an out-of-order worker resolve when rapid toggles spawn
  // overlapping plan passes (each toggle starts one planFix; only the LATEST resolve may write the phase).
  const previewSeq = useRef(0);
  // round18-abortable-workers: aborts the prior fix/plan worker when a new run()/preview() supersedes it,
  // so a discarded plan/fix stops competing for CPU (complements previewSeq, which only drops a stale
  // resolve). ONE controller governs whichever worker is in flight (preview OR run — never both at once).
  const fixAbort = useRef<AbortController | null>(null);

  // Dry-run preview: post mode:'plan' (cheap/pure — no compose/encode/zip) and show the Plan card. The
  // user confirms with "Run fix" (re-posts the SAME options with mode:'execute' via run()). `over` lets a
  // PlanCard toggle re-preview with the explicit next exclude set (no setState-batching dependency); a fresh
  // preview (no `over`) resets the selection to empty unconditionally, so re-entering the plan starts full.
  // A FRESH preview (over absent) flips to the 'planning' spinner; a TOGGLE re-preview (over present) keeps
  // the PlanCard MOUNTED with a subtle pending hint (no flicker, no lost checkbox focus) — design B1/S4.
  // Round 21 #2: re-source the picked files from disk BEFORE posting to the fix worker. runAnalysis
  // TRANSFERRED (detached) the original `files[i].bytes` into the analyze worker ONLY when every file had a
  // re-readable `.file` (worker-client canTransfer); in that mode posting `files` as-is would ship
  // empty/detached buffers (and a second post of an already-transferred buffer throws). Re-read each file's
  // bytes fresh via its retained `.file` (fix is user-initiated, off the ≤10s path).
  //
  // LEGACY/CLONE FALLBACK (additivity): when ANY file lacks `.file`, runAnalysis CLONED instead of
  // transferring, so `f.bytes` is STILL VALID — we must reuse it rather than refuse. A re-read miss falls
  // back to the still-attached live bytes IFF they are non-detached (byteLength > 0). A transferred buffer
  // is detached ⇒ byteLength === 0 ⇒ no `.file` re-read ⇒ still refused HONESTLY (we never zip a detached
  // buffer). Only when EVERYTHING is unavailable (no re-read AND detached/empty) is the whole fix refused
  // → caller surfaces an error rather than producing a corrupt zip.
  async function resourceFiles(): Promise<PickedFile[] | null> {
    const out: PickedFile[] = [];
    for (const f of files) {
      const re = await readSourceBytes(f);
      const bytes = re ?? (f.bytes.byteLength ? f.bytes : null);
      if (!bytes) return null;
      out.push({ ...f, bytes });
    }
    return out;
  }

  async function preview(over?: Set<OpKind>) {
    if (!over) setExcludeKinds(new Set());
    const seq = ++previewSeq.current;
    // Abort the prior fix/plan worker (round18-abortable-workers) and start a fresh controller for THIS
    // plan so a superseded preview stops its worker's CPU; previewSeq still guards resolve ordering.
    fixAbort.current?.abort();
    const ctrl = new AbortController();
    fixAbort.current = ctrl;
    if (over) setPhase((p) => (p.t === 'plan' ? { ...p, pending: true } : { t: 'planning' }));
    else setPhase({ t: 'planning' });
    try {
      const sourced = await resourceFiles();
      if (seq !== previewSeq.current) return; // a newer toggle superseded this preview during the re-read
      if (!sourced) {
        setPhase({ t: 'error', message: t('error.noFiles') });
        return;
      }
      const summary = await planFix(sourced, buildOptions(over), ctrl.signal);
      if (seq !== previewSeq.current) return; // a newer toggle superseded this preview — drop the stale resolve
      setPhase({ t: 'plan', summary });
    } catch (e) {
      // Swallow a superseded run's AbortError FIRST (before the seq guard, which would otherwise also
      // return but is unreachable for the aborted promise once a newer preview bumped previewSeq).
      if (e instanceof DOMException && e.name === 'AbortError') return;
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
    // Abort the prior fix/plan worker (round18-abortable-workers) — e.g. a still-running preview — and
    // start a fresh controller for this execute run so a superseded run stops its worker's CPU.
    fixAbort.current?.abort();
    const ctrl = new AbortController();
    fixAbort.current = ctrl;
    setPhase({ t: 'running', p: { label: '', done: 0, total: 1 } });
    try {
      // Round 21 #2: re-read fresh bytes (the originals were transferred into the analyze worker). Null ⇒
      // the folder is no longer readable → refuse honestly rather than zip detached/empty buffers.
      const sourced = await resourceFiles();
      if (!sourced) {
        setPhase({ t: 'error', message: t('error.noFiles') });
        return;
      }
      const out = await runFix(sourced, buildOptions(), (p) => setPhase({ t: 'running', p }), ctrl.signal);
      downloadZip(out.zip);
      setPhase({ t: 'done', out });
    } catch (e) {
      // A superseded run rejects AbortError — a newer run/preview now owns the card; swallow it.
      if (e instanceof DOMException && e.name === 'AbortError') return;
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
  }, [aggressive, polygon, marking, effort, scaleAwareQ, webpNearLossless, pngRecompress, opaqueAlpha, bestFormatPerImage, frameRedundancy, trimMargin, overrides, packLoose, packMode, packGranularity, packTrim, extrude, tierEnable, tierSuffixes, profileEnable, profileFormats, customTiers, profileOverrides, ktx2Enable, pngquantEnable, resampleEnable]);
  // Consent is NEVER sticky: drop the per-run "uploaded to server" acknowledgement the moment BOTH backend
  // ops are disabled OR the backend becomes unreachable, so a fresh run can't inherit a prior tick. The user
  // must re-consent each time the upload path could engage.
  useEffect(() => {
    if (!(backendAnyEnable && backendReady)) setBackendConsent(false);
  }, [backendAnyEnable, backendReady]);
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
            opaqueAlpha={opaqueAlpha}
            setOpaqueAlpha={setOpaqueAlpha}
            bestFormatPerImage={bestFormatPerImage}
            setBestFormatPerImage={setBestFormatPerImage}
            frameRedundancy={frameRedundancy}
            setFrameRedundancy={setFrameRedundancy}
            trimMargin={trimMargin}
            setTrimMargin={setTrimMargin}
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
            resampleAvailable={resampleEnable && backendWillUpload}
          />

          <ExportProfilePanel
            profileEnable={profileEnable}
            setProfileEnable={setProfileEnable}
            formats={profileFormats}
            setFormats={setProfileFormats}
            customTiers={customTiers}
            setCustomTiers={setCustomTiers}
            overrides={profileOverrides}
            setOverrides={setProfileOverrides}
          />

          {/* PixiJS-v8 asset manifest (round8-pixi-manifest.md C6) — additive, DEFAULT OFF. Off ⇒ no extra
              file ⇒ zip byte-identical to today. round12 auto-pair: when a backend op will upload, the manifest
              is FORCED ON (the .ktx2/re-compressed page needs loader wiring) — shown as a checked+disabled box
              with an honest note so the auto-enable is visible, never silent. */}
          <label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.pixiManifestHint')}>
            <input
              type="checkbox"
              checked={effectiveEmitManifest}
              disabled={backendWillUpload}
              onChange={(e) => setEmitPixiManifest(e.target.checked)}
              className="accent-teal disabled:opacity-60"
            />
            {t('fix.pixiManifest')}
          </label>
          {backendWillUpload && !emitPixiManifest ? (
            <p className="mt-1 font-mono text-[10px] leading-relaxed text-ink-soft/80">{t('fix.backend.manifestAutoPaired')}</p>
          ) : null}

          {/* AssetPack includeFileSizes parity (round23 #2) — adds `progressSize` (KB) to each manifest src so
              PixiJS shows accurate load progress. DEFAULT 'off' ⇒ buildOptions omits it ⇒ bare-string src ⇒
              manifest byte-identical to today. DISABLED unless the Pixi manifest is actually emitted (a
              bare-string manifest has no src objects to carry a size). */}
          <label className="mt-1 ml-5 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.includeFileSizesHint')}>
            {t('fix.includeFileSizes')}
            <select
              value={includeFileSizes}
              disabled={!effectiveEmitManifest}
              onChange={(e) => setIncludeFileSizes(e.target.value as 'off' | 'raw' | 'gzip')}
              className="rounded border border-line bg-panel px-1 py-0.5 font-mono text-[10px] text-ink disabled:opacity-60"
            >
              <option value="off">{t('fix.includeFileSizes.off')}</option>
              <option value="raw">{t('fix.includeFileSizes.raw')}</option>
              <option value="gzip">{t('fix.includeFileSizes.gzip')}</option>
            </select>
          </label>

          {/* Content-hash cache-busting (round9-cache-busting.md K9) — additive, DEFAULT OFF. Pairs with the
              Pixi manifest (the guaranteed referrer for pass-through loose images). Off ⇒ zip byte-identical. */}
          <label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-ink-soft" title={t('fix.hashFilenamesHint')}>
            <input type="checkbox" checked={hashFilenames} onChange={(e) => setHashFilenames(e.target.checked)} className="accent-teal" />
            {t('fix.hashFilenames')}
          </label>

          {/* OPT-IN backend native KTX2 (round12-backend-processing.md, Phase 3) — DEFAULT OFF, gated behind
              a configured backend + per-run consent. When unconfigured/unconsented, buildOptions omits the
              `backend` field ⇒ the worker's KTX2 path is dead ⇒ zip byte-identical to today. */}
          <BackendKtx2Panel
            configured={backendConfigured}
            ready={backendReady}
            ktx2Enable={ktx2Enable}
            setKtx2Enable={setKtx2Enable}
            pngquantEnable={pngquantEnable}
            setPngquantEnable={setPngquantEnable}
            resampleEnable={resampleEnable}
            setResampleEnable={setResampleEnable}
            consent={backendConsent}
            setConsent={setBackendConsent}
            uploadPreview={uploadPreview}
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
      {/* Before/after FilmViewer X-ray of each repacked/merged/packed/Spine-repacked sheet (round6-f1-
          sheet-diff.md): the visual TRUST PROOF behind the headline VRAM row above. Two films per sheet
          (the after-film glows red where space is STILL empty) + a per-sheet OCC/dims/VRAM strip of two
          MEASURED states (`→`, NEVER a pct — the VRAM ReceiptRow above is the SOLE saving claim, invariant
          5). Capped at the first N composed (≤8 MB/side); "showing N of M" when more were composed. Gated
          on a non-empty sheetDiffs[] so absent/empty runs render byte-identical to today (spread-omitted). */}
      {/* round18 correlateFix: the MEASURED before→after sheet probe (attachSheetProbes filled the
          per-sheet draw-call and decoded-VRAM readings on the main thread) turned into a localized
          doctor's verdict via the SAME CorrelatedFinding + renderCorrelated machinery as the extension
          overlay — "measured N→M draw calls on your GPU this run" / measured decoded-VRAM. HONEST: only
          emitted when both before+after probes are present; a field absent (no WebGL / pure-pack page)
          means no verdict. ADDITIVE: empty list renders nothing (byte-identical to today). Sits ABOVE the
          per-sheet strip as the aggregate measured read; never folded into the static VRAM ReceiptRow
          (invariant 5). */}
      <FixVerdicts receipt={receipt} />
      {(receipt.sheetDiffs?.length ?? 0) > 0 ? <SheetDiffs sheetDiffs={receipt.sheetDiffs ?? []} total={receipt.sheetDiffsTotal ?? 0} /> : null}
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
      {/* Frame-redundancy aliasing (round19): byte-identical animation frames aliased onto a shared region. The
          VRAM win is EXACT (vramBytesBefore→After of the de-duplicated sheet, no estimate — invariant 5); every
          original name still resolves in the emitted manifest. Present ONLY when ≥1 frame was aliased. */}
      {(receipt.framesAliased ?? 0) > 0 ? (
        <p className="font-mono text-[10px] text-ink-soft">
          {t('fix.framesAliased', { n: receipt.framesAliased ?? 0, before: receipt.vramBytesBefore, after: receipt.vramBytesAfter })}
        </p>
      ) : null}
      {/* Cross-atlas frame dedup during MERGE (round22 #1): byte-identical frames that spanned MULTIPLE source
          sheets, deduped onto ONE merged region (every name still resolves). HONESTY (invariant 5): when the
          POT bin dropped a tier the reclaimed VRAM is EXACT (measured from the real merge bin); otherwise the
          win is disk-only (same tier) and we say so. Present ONLY when ≥1 cross-sheet frame was deduped. */}
      {(receipt.crossSheetFramesDeduped ?? 0) > 0 ? (
        <p className="font-mono text-[10px] text-ink-soft">
          {receipt.crossSheetPotTierDropped
            ? t('fix.crossSheetFramesDeduped', { n: receipt.crossSheetFramesDeduped ?? 0, vram: receipt.crossSheetVramReclaimedBytes ?? 0 })
            : t('fix.crossSheetFramesDedupedDiskOnly', { n: receipt.crossSheetFramesDeduped ?? 0 })}
        </p>
      ) : null}
      {/* Trim-on-repack (round20): untrimmed sprites tightened to their opaque bounds during a repack. The
          reclaimed px is MEASURED (Σ frame − bbox), not the detector's "up to" estimate; the VRAM win is EXACT
          (already inside vramBytesBefore→After — invariant 5). Every name still resolves (drop-in). Present
          ONLY when ≥1 sprite was trimmed. */}
      {(receipt.trimmedSprites ?? 0) > 0 ? (
        <p className="font-mono text-[10px] text-ink-soft">
          {t('fix.trimmedOnRepack', { n: receipt.trimmedSprites ?? 0, area: receipt.trimmedAreaReclaimed ?? 0, before: receipt.vramBytesBefore, after: receipt.vramBytesAfter })}
        </p>
      ) : null}
      {/* Export-profile summary: variant files emitted (formats × resolutions × assets). DISK-only fan-out —
          the device loads ONE variant, so this is a count, never a saving (invariant 5). */}
      {receipt.exportProfile ? (
        <p className="font-mono text-[10px] text-ink-soft">
          {t('fix.profile.title')} — {receipt.exportProfile.filesEmitted} files · {receipt.exportProfile.formats}×
          {receipt.exportProfile.tiers} · {receipt.exportProfile.assets} assets
          <span className="mt-0.5 block text-ink-soft/80">{t('fix.profile.diskNote')}</span>
        </p>
      ) : null}
      {/* PixiJS-v8 asset manifest (round8-pixi-manifest.md C8): present ONLY when the opt-in emitted a
          manifest. Names/structure only — no saving claimed (the manifest sums nothing, invariant 5). */}
      {receipt.pixiManifest ? (
        <p className="font-mono text-[10px] text-ink-soft">{t('fix.pixiManifestReceipt', { path: receipt.pixiManifest.path, n: receipt.pixiManifest.assets })}</p>
      ) : null}
      {/* OPT-IN backend native ops receipt (round12 §7 + round13): ONE block per op. KTX2 reports the SEPARATE
          worst-case VRAM CEILING (≤, never w·h·4 — invariant 5) + the transcoder-bundle requirement. pngquant
          reports the REAL measured DISK saving ("smaller download") and NEVER a VRAM/GPU win (it decodes to
          full RGBA8888). Present ONLY when the user consented + ≥1 page was offered. */}
      {receipt.backendNative?.map((bn) => (
        <div key={bn.op} className="mt-1 space-y-1 rounded-md border border-line bg-bg p-2">
          <p className="font-mono text-[10px] text-ink-soft">
            {bn.op === 'pngquant'
              ? t('fix.backend.receiptPngquant', {
                  produced: bn.produced,
                  uploaded: bn.uploaded,
                  host: bn.host,
                  before: bn.bytesBefore ?? 0,
                  after: bn.bytesAfter ?? 0,
                })
              : bn.op === 'resample'
                ? t('fix.backend.receiptResample', {
                    produced: bn.produced,
                    uploaded: bn.uploaded,
                    host: bn.host,
                  })
                : t('fix.backend.receipt', {
                    produced: bn.produced,
                    uploaded: bn.uploaded,
                    host: bn.host,
                  })}
          </p>
          {bn.failed > 0 ? (
            <p className="font-mono text-[10px] text-warn">{t('fix.backend.receiptFailed', { failed: bn.failed })}</p>
          ) : null}
          {/* round24 resample: the MEASURED high-frequency-energy retention delta — a FACT ("retained N% more
              high-frequency content at the same file size"), NOT a "sharper/cleaner/better" verdict (invariant
              3: lanczos3's extra HF energy includes ringing/overshoot, an artifact). DISK/QUALITY-only — there
              is NO VRAM and NO disk field for resample, ever (invariant 5). Shown only when >0 (a ≤0 delta kept
              the browser tile and reads as 0). */}
          {bn.op === 'resample' && (bn.qualityHfEnergyDelta ?? 0) > 0 ? (
            <p className="font-mono text-[10px] text-ok">{t('fix.backend.receiptResampleQuality', { pct: bn.qualityHfEnergyDelta ?? 0 })}</p>
          ) : null}
          {/* KTX2 worst-case VRAM ceiling rides on the ktx2 entry only; pngquant is DISK-ONLY (no VRAM field). */}
          {bn.op === 'ktx2' && (receipt.ktx2VramBytesWorstCase ?? 0) > 0 ? (
            <p className="font-mono text-[10px] text-ink-soft">{t('fix.backend.receiptVram', { bytes: receipt.ktx2VramBytesWorstCase ?? 0 })}</p>
          ) : null}
          {/* Round15: the MEASURED, DEVICE-LOCAL GPU residency shown BESIDE the worst-case ceiling — the
              one estimated headline turned into a fact ("measured X on your GPU, ceiling ≤ Y — this device
              only"). NEVER folded into vramBytesAfter (invariant 5) nor claimed across devices (invariant 3).
              When the probe fell back to raster (no block-compression support / transcoder didn't load), the
              honest fallback note is shown instead. Absent fields ⇒ no probe ran ⇒ renders exactly as today. */}
          {bn.op === 'ktx2' && receipt.probedKtx2VramBytes != null && !receipt.probedKtx2Fallback ? (
            <p className="font-mono text-[10px] text-ok">
              {t('fix.backend.receiptVramMeasured', {
                measured: receipt.probedKtx2VramBytes,
                baseline: receipt.probedKtx2RasterBaselineBytes ?? 0,
                ceiling: receipt.ktx2VramBytesWorstCase ?? 0,
              })}
            </p>
          ) : null}
          {bn.op === 'ktx2' && receipt.probedKtx2Fallback ? (
            <p className="font-mono text-[10px] text-warn">{t('fix.backend.receiptVramFallback')}</p>
          ) : null}
          {bn.op === 'ktx2' ? (
            <p className="font-mono text-[10px] leading-relaxed text-ink-soft/80">{t('fix.backend.receiptLoader')}</p>
          ) : null}
        </div>
      )) ?? null}
      {receipt.referencesChanged ? <p className="font-mono text-[10px] text-warn">⚠ {t('fix.mergeWarn')}</p> : null}
      {/* Loader-migration guide (docs/improvements/loader-migration.md): when the fix recorded genuine
          loader-CALL rewrites, surface a concrete repointing list + an engine-aware copy-pasteable snippet
          below the bare ⚠ banner. ADDITIVE — absent/empty changes render exactly as today. */}
      {(receipt.changes?.length ?? 0) > 0 ? <LoaderMigration changes={receipt.changes ?? []} ktx2={receipt.ktx2Produced ?? false} /> : null}
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

// round18 correlateFix verdict surface — turns the MEASURED before→after sheet probe into the SAME
// localized doctor's verdict the extension overlay shows (renderCorrelated path), reusing the batching/vram
// CorrelatedFinding families (NOT a new finding type). HONEST: correlateFix only emits when both probe
// halves exist; absent ⇒ [] ⇒ this renders nothing (additive). Severity-bordered like the static findings.
const FIX_VERDICT_SEV: Record<Severity, string> = { crit: 'border-crit text-crit', warn: 'border-warn text-warn', ok: 'border-ok text-ok', info: 'border-info text-info' };
function FixVerdicts({ receipt }: { receipt: FixReceipt }) {
  const { locale, t } = useI18n();
  const verdicts = correlateFix(receipt);
  if (verdicts.length === 0) return null;
  return (
    <div className="space-y-1.5 text-left">
      {verdicts.map((f) => {
        const r = renderCorrelated(f, locale);
        const sev = FIX_VERDICT_SEV[f.severity] ?? FIX_VERDICT_SEV.info;
        return (
          <div key={f.id} className={`rounded-md border-l-2 ${sev} bg-bg p-2 pl-2.5`}>
            <p className="font-mono text-[11px] font-semibold">[{t(`severity.${f.severity}`)}] {r.title}</p>
            <p className="mt-0.5 font-mono text-[10px] text-ink-soft">{r.runtimeEvidence}</p>
            <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-ink-soft/80">{r.diagnosis}</p>
            <p className="mt-0.5 font-mono text-[10px] text-teal">→ {r.fix}</p>
          </div>
        );
      })}
    </div>
  );
}

// Before/after FilmViewer X-ray of the repacked/merged/packed/Spine-repacked sheets (round6-f1-sheet-
// diff.md) — the VISUAL TRUST PROOF for a paid repack, collapsed under the receipt's VRAM row (the headline
// claim it backs). Reuses the fix.skipped <details> chrome. HONESTY (invariant 5): the per-sheet OCC/dims/
// VRAM strip shows two MEASURED states with `→` only — NO pct/"saved %" here; the receipt's VRAM ReceiptRow
// is the SOLE saving claim. "showing N of M" surfaces when more sheets were composed than the capped N kept.
function SheetDiffs({ sheetDiffs, total }: { sheetDiffs: SheetDiff[]; total: number }) {
  const { t } = useI18n();
  return (
    <details className="rounded-md border border-line bg-bg p-2 text-left open:pb-2.5">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-teal">
        {t('fix.sheetDiff.title', { n: sheetDiffs.length })}
      </summary>
      <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-ink-soft/80">{t('fix.sheetDiff.proofNote')}</p>
      {/* The cap kept the first N composed; surface the honest "showing N of M" when more were composed. */}
      {total > sheetDiffs.length ? (
        <p className="mt-1 font-mono text-[10px] text-ink-soft">{t('fix.sheetDiff.showing', { shown: sheetDiffs.length, total })}</p>
      ) : null}
      <div className="mt-2 space-y-4">
        {sheetDiffs.map((d, i) => (
          <SheetDiffView key={`${d.name}-${i}`} diff={d} />
        ))}
      </div>
    </details>
  );
}

// ONE sheet's before/after: two side-by-side FilmViewers (BEFORE = source bytes, no findings; AFTER =
// emitted bytes + one synthetic wasted-regions Finding whose overlay = the after-film's still-empty zones,
// so the empty space glows red — no cast: SheetDiff.afterZones is already OverlayZone[]). Each viewer gets a
// partial { occupancy, vramBytes } AssetMetrics (FilmViewer's metric reads are all optional-guarded, so a
// partial renders cleanly). Below the pair: a compact OCC/dims/VRAM strip of two MEASURED states joined by
// `→` — NEVER a pct (invariant 5; the receipt VRAM row is the sole saving claim).
function SheetDiffView({ diff }: { diff: SheetDiff }) {
  const { t } = useI18n();
  // Synthetic finding so the after-film glows where space is STILL empty. `overlay` is fed verbatim from the
  // worker's wasted-regions proof (OverlayZone[]); constant id/rule/severity drive only the overlay styling.
  const afterFinding: Finding = {
    id: 'sheet-diff-empty',
    rule: 'wasted-regions',
    severity: 'crit',
    assetRef: diff.name,
    title: '',
    detail: '',
    overlay: diff.afterZones,
  };
  const beforeMetrics = { occupancy: diff.occBefore, vramBytes: diff.vramBefore } as AssetMetrics;
  const afterMetrics = { occupancy: diff.occAfter, vramBytes: diff.vramAfter } as AssetMetrics;
  // Formats ONE occupancy value as a percentage of itself (e.g. 0.28 → "28%") — a MEASURED state readout,
  // NOT a savings/delta. The strip joins two such states with `→` and never computes a "% saved" (invariant
  // 5): the receipt's VRAM ReceiptRow above is the SOLE saving claim.
  const occPct = (occ: number): string => `${Math.round(occ * 100)}%`;
  const wxh = (s: { w: number; h: number }): string => (s.w === s.h ? `${s.w}²` : `${s.w}×${s.h}`);
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <p className="px-1 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-soft">{t('fix.sheetDiff.before')}</p>
          <FilmViewer bytes={diff.beforeBytes} findings={[]} name={diff.name} metrics={beforeMetrics} />
        </div>
        <div className="space-y-1">
          <p className="px-1 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-soft">{t('fix.sheetDiff.after')}</p>
          <FilmViewer bytes={diff.afterBytes} findings={[afterFinding]} name={diff.name} metrics={afterMetrics} />
        </div>
      </div>
      {/* Two MEASURED states, `→` only — NO pct (invariant 5). Numbers/dims/bytes in mono (instrument readout). */}
      <p className="break-all px-1 font-mono text-[10px] leading-relaxed text-ink-soft">
        <span className="text-ink-soft">OCC</span> {occPct(diff.occBefore)} → {occPct(diff.occAfter)}
        {' · '}
        {wxh(diff.beforeWxH)} → {wxh(diff.afterWxH)}
        {' · '}
        <span className="text-ink-soft">VRAM</span> {fmtBytes(diff.vramBefore)} → {fmtBytes(diff.vramAfter)}
      </p>
      {/* MEASURED on the user's GPU this run (render-probe of the produced sheet, sheet-probe-run.ts).
          DEVICE-LOCAL, kept SEPARATE from the static VRAM strip above — a DIFFERENT quantity (real decoded
          footprint + real draw calls), NEVER a saving, NEVER folded into vramBytes* (invariant 5). Rendered
          only when the probe filled fields; gated PER-METRIC. Pack page (no beforeFrames) shows after-only
          — honest, mirroring the static "OCC 0% →". */}
      {diff.drawCallsAfter != null || diff.decodedVramAfter != null ? (
        <p className="break-all px-1 font-mono text-[10px] leading-relaxed text-teal/90">
          <span className="uppercase tracking-[0.08em]">{t('fix.sheetDiff.measuredBadge')}</span>
          {' · '}
          {diff.drawCallsBefore != null && diff.drawCallsAfter != null ? (
            <>
              <span className="text-ink-soft">DRAWS</span> {diff.drawCallsBefore} → {diff.drawCallsAfter}
              {' · '}
            </>
          ) : diff.drawCallsAfter != null ? (
            <>
              <span className="text-ink-soft">DRAWS</span> {diff.drawCallsAfter}
              {' · '}
            </>
          ) : null}
          {diff.decodedVramBefore != null && diff.decodedVramAfter != null ? (
            <>
              <span className="text-ink-soft">DECODED VRAM</span> {fmtBytes(diff.decodedVramBefore)} → {fmtBytes(diff.decodedVramAfter)}
            </>
          ) : diff.decodedVramAfter != null ? (
            <>
              <span className="text-ink-soft">DECODED VRAM</span> {fmtBytes(diff.decodedVramAfter)}
            </>
          ) : null}
        </p>
      ) : null}
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
      {/* HONEST fix-simulation footprint preview (round22 #2): two stacked rows, never a fabricated total.
          Row 1 "measured now" — ONLY the pre-compose-knowable deltas (transcode/opaque disk · oversize×resize
          VRAM), disk and VRAM kept VISIBLY DISTINCT (invariant 5: disk weight ≠ GPU footprint; VRAM in its
          own teal token). The "~" prefix marks an estimated (lossy q0.9) disk number — never an exact saving.
          Each segment renders ONLY when its value > 0 (a VRAM-only plan never shows a fabricated "disk −0 B").
          Row 2 "+N more computed at download" — the ops whose size the encode/pack alone resolves. Absent
          footprint ⇒ neither row renders ⇒ the card is byte-identical to today (additive). */}
      {summary.footprint && (summary.footprint.diskBytesSaved > 0 || summary.footprint.vramBytesSaved > 0) ? (
        <p className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px]">
          <span className="uppercase tracking-[0.06em] text-ink-soft">{t('fix.plan.measuredNow')}</span>
          {summary.footprint.diskBytesSaved > 0 ? (
            <span className="text-ink">
              {summary.footprint.estimated ? '~' : ''}
              {t('fix.plan.measuredNowDisk', { disk: summary.footprint.diskBytesSaved })}
            </span>
          ) : null}
          {summary.footprint.vramBytesSaved > 0 ? (
            <span className="text-teal">{t('fix.plan.measuredNowVram', { vram: summary.footprint.vramBytesSaved })}</span>
          ) : null}
        </p>
      ) : null}
      {summary.footprint && summary.footprint.deferredOps > 0 ? (
        <p className="font-mono text-[10px] text-ink-soft">{t('fix.plan.alsoRuns', { n: summary.footprint.deferredOps })}</p>
      ) : null}
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

// Loader-migration guide (docs/improvements/loader-migration.md) — rendered below the fix.mergeWarn banner
// when a reference-changing fix recorded genuine loader-CALL rewrites (receipt.changes[]). Three parts:
// (1) a Pixi/Phaser engine toggle, (2) an honest from → to repointing list (warn token; removed rows show
// the fix.migrate.removed label, never a fabricated target), and (3) a copy-pasteable snippet generated as
// CODE via migrationSnippet(changes, engine) — verbatim identifiers, NOT i18n (only the heading/intro/
// removed/copy chrome translates, design M5). The snippet is hidden when every change is a removal (empty
// snippet ⇒ nothing to load). Collapsed by default so the instant-wow headline stays first.
function LoaderMigration({ changes, ktx2 }: { changes: FixChange[]; ktx2: boolean }) {
  const { t } = useI18n();
  const [engine, setEngine] = useState<Engine>('pixi');
  const [copied, setCopied] = useState(false);
  // Code, not t() — verbatim identifiers from loader-migration.ts (design M5). Recompute per engine. When the
  // fix produced .ktx2 pages (round15), `ktx2` makes the Pixi snippet lead with `import 'pixi.js/ktx2'`.
  const snippet = useMemo(() => migrationSnippet(changes, engine, { ktx2 }), [changes, engine, ktx2]);
  const copy = (): void => {
    const done = (): void => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    };
    // navigator.clipboard is undefined on insecure origins / older browsers → fall back to execCommand.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(snippet).then(done, () => fallbackCopy(snippet) && done());
    } else if (fallbackCopy(snippet)) {
      done();
    }
  };
  return (
    <details className="rounded-md border border-warn/40 bg-bg p-2 text-left open:pb-2.5">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-warn">
        {t('fix.migrate.title')} · {changes.length}
      </summary>
      <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-ink-soft/80">{t('fix.migrate.note')}</p>
      {/* Engine toggle — product names are CODE (untranslated, design M5), not catalog entries. */}
      <div className="mt-1.5 flex gap-1">
        {(['pixi', 'phaser'] as const).map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => setEngine(e)}
            aria-pressed={engine === e}
            className={`rounded px-2 py-0.5 font-mono text-[10px] transition ${engine === e ? 'bg-teal text-white' : 'border border-line text-ink-soft hover:border-teal'}`}
          >
            {e === 'pixi' ? 'PixiJS' : 'Phaser'}
          </button>
        ))}
      </div>
      {/* Honest from → to repointing list. `to: []` ⇒ a removal (no fabricated target). Multi-target sets
          (multi-page merge/pack, tier ladder) join with ', '. Warn token reinforces "not a drop-in". */}
      <ul className="mt-1.5 space-y-1">
        {changes.map((ch, i) => (
          <li key={i} className="min-w-0 break-all font-mono text-[10px] leading-relaxed text-warn">
            {ch.from} → {ch.to.length > 0 ? ch.to.join(', ') : t('fix.migrate.removed')}
          </li>
        ))}
      </ul>
      {/* Copy-pasteable snippet — CODE (verbatim identifiers). Hidden when every change is a removal. */}
      {snippet ? (
        <div className="mt-1.5">
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={copy}
              className="rounded border border-line px-2 py-0.5 font-mono text-[10px] text-teal transition hover:border-teal"
            >
              {copied ? '✓ ' : ''}
              {t('fix.migrate.copy')}
            </button>
          </div>
          <pre className="mt-1 overflow-x-auto rounded bg-film p-2 font-mono text-[10px] leading-relaxed text-white/90">
            <code>{snippet}</code>
          </pre>
        </div>
      ) : null}
    </details>
  );
}

// Clipboard fallback for insecure origins / browsers without navigator.clipboard (textarea + execCommand).
function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
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
