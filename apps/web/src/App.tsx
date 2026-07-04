import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AnalysisReport, AssetMetrics, BundleAvailability, Finding, LazyMarking, Rule, Severity, SkinGuard } from '@asset-doctor/core';
import { bundleOf, cmp } from '@asset-doctor/analysis';
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
import type { BackendOptions, FixChange, FixPlanSummary, FixReceipt, NativeOpKind, SheetDiff } from './worker/fix-protocol';
import { buildFixOptions } from './lib/build-settings';
import { BuildSettingsProvider, useBuildSettings } from './lib/settings-ctx';
import { viewOfHash, SETTINGS_HASH, PRO_HASH, type View } from './lib/route';
import { SettingsPage } from './components/SettingsPage';
import { fmtBytes } from './lib/format';
import { OPTIMIZE_ENTRY, optimizeEntryEnabled } from './lib/optimize-entry';
import { groupOps, OP_KIND_ORDER, REFERENCE_CHANGING, type OpKind } from './lib/op-manifest';
import { migrationSnippet, type Engine } from './lib/loader-migration';
import { LOCALES, NATIVE_NAME, useI18n } from './lib/i18n';
import { correlateFix } from '@asset-doctor/correlate';
import { renderCorrelated } from '@asset-doctor/i18n';
import { API_BASE, isProUnlocked, loadStoredEntitlement, maybeRefresh, PRO_GATE_ENABLED } from './lib/license';
import { backendReachable } from './lib/backend-client';
import { ActivatePanel, ProBadge } from './components/LicensePanel';
import { ProPage } from './components/ProPage';
import { planActionKey, planValueKey, proPanel, type ProPanel } from './lib/pro-view';
import { FilmViewer } from './components/FilmViewer';
import { Findings, DOT } from './components/Findings';
import { VerdictBar } from './components/VerdictBar';
import { TriageLedger } from './components/TriageLedger';
import { PrimaryRecommendation } from './components/PrimaryRecommendation';
import { useDebounced } from './lib/useDebounced';
import { buildIndex, countCandidates, defaultSelectOpts, DEFAULT_SEVERITIES, DEFAULT_SORT, foldableFindingIds, isAssetAxis, looseRecommendation, selectRows, typeHiddenCount, type LedgerRow, type SelectOpts, type SortKey } from './lib/triage';
import { loadHiddenRules, saveHiddenRules } from './lib/view-prefs';
import { analysisReadyMessage, resultCountMessage } from './lib/announce';
import { effectiveSeverityFilter } from './lib/ledger-empty';
import { UNPARSED_DETAILS_ID, UNPARSED_SUMMARY_ID } from './lib/skipped-chip';
import { resultsHeading } from './lib/results-heading';
import { errorCard, errDetail, type ErrorState, type ErrorContext } from './lib/error-view';
import { progressView } from './lib/progress-view';
import { assetCounts, budgetModel, folderLabel, type BudgetModel } from './lib/results-summary';
import { focusTargetAfterSwap, type SwapState } from './lib/focus-move';
import { Landing } from './components/landing/Landing';
import { LandingFooter } from './components/landing/LandingFooter';
import { LANDING_OPEN_FOLDER_ID, h2IdOf } from './lib/landing-nav';
import { SPECIMEN_FRAMES, SPECIMEN_ZONES, SPECIMEN_VIEWBOX } from './lib/landing-specimen';
import { ZONE_STYLE } from './lib/film-legend-style';
import { HERO_READOUT_CELLS } from './lib/hero-readout';

// Stable empty Set (constant identity) so the `foldIds` memo has a fixed reference when there is no report —
// no fresh object per render, so nothing downstream needlessly recomputes. PRESENTATION only (design §5.1).
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

// The FixCard root id — the "Download the fix" results-header CTA scrolls to + focuses it (app-screen Phase 2).
const FIX_CARD_ID = 'ad-fix-card';

type Phase =
  | { t: 'idle' }
  | { t: 'analyzing'; progress?: Progress }
  | { t: 'done' }
  | { t: 'error'; error: ErrorState };

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
  // Settings-page routing (design §5.1): a hash-based view switch (no react-router — repo convention). The
  // MAIN tree stays MOUNTED (hidden) while the Settings page shows, so all analysis/fix state (report, film
  // selection, probe readings, FixCard receipt) survives navigation. Initial read + a hashchange listener
  // keep `view` in sync with location.hash; `hidden` removes the main subtree from the AOM ⇒ exactly one h1.
  const [view, setView] = useState<View>(() => (typeof location !== 'undefined' ? viewOfHash(location.hash) : 'main'));
  useEffect(() => {
    const onHash = (): void => setView(viewOfHash(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // App-level Pro entitlement for the sidebar plan card (app-screen Phase 4; mirrors FixCard's probe). Seed
  // to !gate (beta ⇒ free), then refresh + verify the offline ed25519 entitlement when the gate is ON. This
  // async re-set NEVER feeds focus-move (its deps stay [view, phase.t]) — it only drives the plan-card copy.
  const [proUnlocked, setProUnlocked] = useState(!PRO_GATE_ENABLED);
  useEffect(() => {
    if (!PRO_GATE_ENABLED) return;
    let alive = true;
    void (async () => {
      await maybeRefresh();
      const ok = await isProUnlocked();
      if (alive) setProUnlocked(ok);
    })();
    return () => {
      alive = false;
    };
  }, []);
  const plan: ProPanel = proPanel(PRO_GATE_ENABLED, proUnlocked);
  // a11y (UX-4): move focus on view/phase swaps — the pure decision lives in lib/focus-move.ts (Node-tested).
  // Every swap unmounts (or display:none-s, via the settings `hidden` wrapper below) the focused control,
  // dropping keyboard/SR focus to <body> at the exact ≤10s payoff moment. Deps are ONLY the swap coordinates
  // [view, phase.t] — `report` is deliberately NOT a dep, so the async probe re-set (a NEW report object with
  // the same phase, attachProbeReadings) can STRUCTURALLY never re-fire this (stronger than the autoSelectedFor
  // ref-guard it mirrors). focus() on the sr-only results/dropzone h1 scrolls to that region's top (a
  // position:absolute anchor — desired); the jump is instant (no scroll-behavior:smooth anywhere) ⇒
  // reduced-motion safe. This is the ONE focus owner for BOTH directions of the settings swap (SettingsPage's
  // former mount-focus effect is deleted — it could never handle settings→main, being unmounted by then).
  // Initial mount seeds prev to the current state ⇒ rule 5 ⇒ null ⇒ no focus steal on load (the first Tab must
  // reach the skip link; SRs must start at the document top).
  const prevSwap = useRef<SwapState>({ view, phase: phase.t });
  useEffect(() => {
    const next: SwapState = { view, phase: phase.t };
    const target = focusTargetAfterSwap(prevSwap.current, next);
    prevSwap.current = next;
    if (target) document.getElementById(target)?.focus();
  }, [view, phase.t]);
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
  // ── Finding-TYPE visibility (view-prefs slice — an EXPLICIT, one-click-reversible USER filter, NEVER
  //    silent suppression; invariant 3). UNLIKE severityFilter it is DURABLE (localStorage 'ad.hiddenRules',
  //    the locale precedent) because the user set it "в настройках" — a sticky preference. Default = empty ⇒
  //    the filter is a byte-identical no-op. Loaded once (lazy init, fail-closed); the persisting setter
  //    writes storage + state together so the durable value and the live view can never diverge. It stores a
  //    list of RULE NAMES only — never asset bytes — so invariant 1 (nothing leaves the device) is intact. ──
  const [hiddenRules, setHiddenRules] = useState<Set<Rule>>(loadHiddenRules);
  const setHiddenRulesPersisted = (next: Set<Rule>): void => {
    saveHiddenRules(next);
    setHiddenRules(next);
  };
  const clearHiddenRules = (): void => setHiddenRulesPersisted(new Set<Rule>());
  const [problemsOnly, setProblemsOnly] = useState(true);
  const [groupByFolder, setGroupByFolder] = useState(false);
  const [showClean, setShowClean] = useState(false);
  // Controlled open-state of the skipped-files <details> (UX-4): the VerdictBar's skipped chip opens it +
  // anchor-scrolls to it. Reset to collapsed at the start of every run() so a re-drop starts closed. The
  // user can still close it natively (onToggle keeps this in sync). Pure presentation.
  const [unparsedOpen, setUnparsedOpen] = useState(false);
  // Monotonic "the user asked to build a spritesheet" signal (spritesheet-first design §4.3). The primary
  // recommendation card's [Build] bumps this AND flips packLoose (via the context patch); the FixCard's
  // nonce effect reads the increment and previews a pack-inclusive plan. Pure UI state — feeds no analysis.
  const [buildNonce, setBuildNonce] = useState(0);
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
      setPhase({ t: 'error', error: { kind: 'noFiles' } });
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
    setUnparsedOpen(false); // a fresh run starts with the skipped-files disclosure collapsed (UX-4)
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
      // Respect the user's finding-type filter when picking the opening worst offender, so the ≤10s film/
      // detail never lands on a type the user chose to hide. defaultSelectOpts() stays the ONE canonical
      // default (empty hiddenRules); the live value is spread in here — the same one-source pattern the live
      // selectOpts memo uses, so the two can't drift.
      const firstRows = selectRows(firstIndex, { ...defaultSelectOpts(), hiddenRules });
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
      setPhase({ t: 'error', error: { kind: 'failed', detail: errDetail(e) } });
    }
  }

  async function openFolder() {
    try {
      if (supportsDirectoryPicker()) await run(await pickFolder());
      else inputRef.current?.click();
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return; // user cancelled
      setPhase({ t: 'error', error: { kind: 'failed', detail: errDetail(e) } });
    }
  }

  const totals = report?.totals;

  // ── Triage index + ordered rows. buildIndex is ONE O(assets+findings) pass per report identity (it
  // re-runs on the probe re-set — cheap, and the order is stable because the probe feeds no sort key).
  // selectRows is one pure sort per control change. Search is debounced so keystrokes don't re-sort. ──
  const debouncedSearch = useDebounced(search, 150);
  const index = useMemo(() => (report ? buildIndex(report) : null), [report]);
  // The spritesheet-first primary recommendation (design §4). null unless the folder is loose-dominated —
  // reads the single should-atlas finding + report.thresholds, invents nothing. Drives ONLY the card's
  // presence + its verbatim `n`; the ledger/tally/VerdictBar are untouched (invariant 3). The collapse that
  // also consumes this signal lands in task C.
  const rec = useMemo(() => (report ? looseRecommendation(report) : null), [report]);
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
            // §1.3 fix: admit the synthesized `ok` rows through the severity filter ONLY while showClean is
            // on, so the "show N clean" toggle actually reveals N (it was a dead control — the filter dropped
            // every synthesized ok row). Fresh Set (effectiveSeverityFilter never aliases state); deps already
            // list both severityFilter + showClean so the memo recomputes exactly as before.
            severityFilter: effectiveSeverityFilter(severityFilter, showClean),
            // The finding-type filter (view-prefs) — a candidate predicate alongside severity. Empty ⇒ no-op.
            hiddenRules,
            problemsOnly: effectiveProblemsOnly,
            includeClean: showClean,
            groupByFolder,
          }
        : null,
    [index, sort, debouncedSearch, severityFilter, hiddenRules, effectiveProblemsOnly, showClean, groupByFolder],
  );
  const rows = useMemo(() => (index && selectOpts ? selectRows(index, selectOpts) : []), [index, selectOpts]);
  // Candidate count under the current severity/clean policy but ignoring search (the "of M" in "showing N
  // of M") — so search visibly narrows N against the stable severity-scoped M. countCandidates does a
  // filter-only pass (no second full sort+group per keystroke — round11 #4); pure, deterministic.
  const totalRows = useMemo(
    () => (index && selectOpts ? countCandidates(index, selectOpts) : 0),
    [index, selectOpts],
  );
  // Honest "H hidden by your finding-type filter" — how many MORE candidate rows the current view would show
  // if the type filter were cleared (typeHiddenCount, design §1.3). Same axis/units as `totalRows` (M), so
  // M + H can never contradict. 0 whenever hiddenRules is empty (guarded) ⇒ no H-line, byte-identical view.
  // Drives BOTH the ledger H-line (when rows exist) and the type-filtered empty-card cause (when M===0).
  const hiddenByType = useMemo(
    () => (index && selectOpts ? typeHiddenCount(index, selectOpts) : 0),
    [index, selectOpts],
  );
  // ── Honest spam-collapse (spritesheet-first design §5.1/§1) — PRESENTATION ONLY (invariant 3). `foldIds` is
  //    the set of finding ids that MAY fold (loose-fold ∪ redundant format-siblings), computed by
  //    foldableFindingIds over the FULL report BEFORE any selection — so it can never touch the tally
  //    (VerdictBar/announce read index.tally, built up-front). Nothing is deleted: folded rows stay in
  //    index.rows and the raw selected `rows`; they reappear inline in ONE click of the ledger's "show K"
  //    toggle. `foldOpen` defaults collapsed and RESETS to collapsed on every new analysis. `foldedCount` (K) is
  //    the count of foldable rows inside the CURRENT (post-search) selected rows — stated verbatim on the
  //    toggle. `visibleRows` drops them ONLY while collapsed AND only when there is something to fold; with
  //    nothing to fold it is the SAME array `rows` (===) ⇒ the results view is byte-identical to before.
  //    `totalRows` (M) stays countCandidates — untouched by the fold (search/fold-independent). ──
  const foldIds = useMemo<ReadonlySet<string>>(() => (report ? foldableFindingIds(report) : EMPTY_SET), [report]);
  const [foldOpen, setFoldOpen] = useState(false);
  // Reset the fold to collapsed at the START of every genuinely new analysis. Keyed on `report === null`
  // (run() sets the report null before analyzing — the ONLY null transition) rather than on report IDENTITY:
  // the async render-probe write-back installs a NEW report object for the SAME analysis (attachProbeReadings
  // returns { ...report, assets, totals } ⇒ probed !== rep, App.tsx:182), which — under a `[report]`-identity
  // reset — would re-fire this effect and collapse a fold the user had just expanded mid-probe. Gating on the
  // null transition fires exactly once per new run and NEVER on the probe re-set (mirrors the autoSelectedFor
  // guard that likewise protects the auto-selection from the probe write-back). PRESENTATION only (invariant 3).
  useEffect(() => {
    if (report === null) setFoldOpen(false);
  }, [report]);
  // The fold applies ONLY to the FINDING-axis sorts (severity/wastedDisk — one row per finding, where the
  // per-image format/npot spam actually lives). In an ASSET-axis sort (vram/occupancy) selectRows already
  // shows ONE row per asset (its worst-severity representative), so there is no per-finding spam to collapse;
  // worse, folding on the representative id could drop an asset whose representative is a foldable `format`
  // while it ALSO carries a NON-foldable warn (solid-fill/wasted-alpha) — hiding a first-class finding from
  // the default view. So K=0 on the asset axis ⇒ nothing folds, every asset stays visible (honest).
  const foldedCount = useMemo(
    () => (isAssetAxis(sort) ? 0 : rows.reduce((k, r) => k + (foldIds.has(r.id) ? 1 : 0), 0)),
    [rows, foldIds, sort],
  );
  const visibleRows = useMemo(
    () => (foldOpen || foldedCount === 0 ? rows : rows.filter((r) => !foldIds.has(r.id))),
    [rows, foldIds, foldOpen, foldedCount],
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

  // a11y: speak the settled "showing N of M" whenever a filter/search/sort/fold changes the visible count.
  // Keyed on the two integers [visibleRows.length, totalRows] — the SAME post-fold numbers the ledger prints
  // (design §1.4/§7: announce what is VISIBLE/navigable, never the pre-fold `rows.length`, which would overstate
  // the count by K while collapsed). They change AFTER the 150ms search debounce settles (debouncedSearch) or on
  // a deliberate fold toggle, so this is naturally debounced with zero new timers and no per-keystroke chatter
  // (PERF: no row iteration). HONEST: announces the EXACT ledger numbers (visibleRows.length / totalRows), never VRAM.
  // The FIRST settle for a fresh report is skipped (countAnnouncedFor guard) because emitLive already spoke
  // "Diagnosis ready. N problems." for that same moment — we only want the count on subsequent control changes.
  const countAnnouncedFor = useRef<AnalysisReport | null>(null);
  useEffect(() => {
    // view guard: the finding-type filter lives on #settings, so toggling it changes visibleRows/totalRows
    // while the ledger is display:none. Without this, "Showing N of M" would be spoken out of context on the
    // settings page (competing with the DiagnosisCard's own hidden-count status). In-ledger controls
    // (severity chips/search/sort/fold) still announce because they only run on the results view.
    if (!report || phase.t !== 'done' || view !== 'main') return;
    if (countAnnouncedFor.current !== report) {
      // Fresh report: the diagnosis-ready announcement already covered this settle; arm for the NEXT change.
      countAnnouncedFor.current = report;
      return;
    }
    emitLive(resultCountMessage(visibleRows.length, totalRows, t));
    // Deliberately keyed on the two settled integers (with report/phase as fresh-report guards). `t` and
    // `emitLive` are intentionally NOT deps: keying on `t` would re-announce the count on a mere relocale,
    // and `emitLive` is a per-render closure over the stable setLive — including it would add no signal.
  }, [visibleRows.length, totalRows, report, phase.t]);

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
  // The filtered empty-card's one-click escape (UX-4): restore the ONE canonical severity default (no reset
  // control existed before — chips had to be re-pressed one by one). Reuses DEFAULT_SEVERITIES, the single
  // source of truth (triage.ts) — a fresh mutable Set so toggling never aliases the constant.
  const resetSeverities = () => setSeverityFilter(new Set<Severity>(DEFAULT_SEVERITIES));
  // The skipped chip's jump (UX-4): open the (controlled) UnparsedNotice, anchor-scroll to it under the
  // sticky header (scroll-mt-20; reduced-motion-gated — the optimize-entry deep-link pattern), and move focus
  // to its <summary> (natively focusable) so a keyboard/SR user lands ON the disclosure it just opened.
  const jumpToUnparsed = () => {
    setUnparsedOpen(true);
    const el = typeof document !== 'undefined' ? document.getElementById(UNPARSED_DETAILS_ID) : null;
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
    document.getElementById(UNPARSED_SUMMARY_ID)?.focus({ preventScroll: true });
  };
  // Sprite count for the MEASURED draw-calls readout ("N sprites batched"). Same keying invariant as
  // the probe (assetRef === atlas.name === atlasFrames key). 0 for loose / un-probed assets. Keyed on the
  // debounced asset so it moves in lockstep with the film it annotates.
  const selectedFrameCount = debouncedSelected ? report?.atlasFrames?.[debouncedSelected]?.length ?? 0 : 0;

  // "Download the fix" (app-screen Phase 2): scroll to + focus the FixCard — resolves in EITHER gate state
  // (locked → the activation input; beta/unlocked → the preview button). No fake charge. Reduced-motion gated.
  const jumpToFix = () => {
    const el = typeof document !== 'undefined' ? document.getElementById(FIX_CARD_ID) : null;
    const reduce = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    el?.querySelector<HTMLElement>('button, a, input')?.focus({ preventScroll: true });
  };
  // Results-screen derived summary (app-screen Phase 2) — pure, from results-summary.ts. `bm` is null off the
  // results screen or when totals are absent (⇒ the budget strip does not render); the header still shows the
  // honest subject + counts. `resultsSubject` falls back to a generic label, NEVER a fabricated folder name.
  const bm: BudgetModel | null = totals && index ? budgetModel(totals, index.tally) : null;
  const counts = report ? assetCounts(report) : null;
  const resultsSubject = folderLabel(files.map((f) => f.path)) ?? t('results.subject.fallback');
  const countsSuffix = counts
    ? counts.atlases > 0
      ? [
          t('results.counts.atlases', { n: counts.atlases }),
          t('results.counts.sprites', { n: counts.sprites }),
          ...(counts.looseImages > 0 ? [t('results.counts.loose', { n: counts.looseImages })] : []),
        ].join(' · ')
      : counts.looseImages > 0
        ? t('results.counts.loose', { n: counts.looseImages })
        : ''
    : '';

  return (
    <BuildSettingsProvider>
    <div className="flex min-h-full flex-col bg-bg text-ink">
      {/* a11y: skip-to-content (WCAG 2.4.1) — the FIRST tab stop on every view/phase (inserted before the
          sticky <header>), visually hidden until keyboard focus (.ad-skip-link). preventDefault keeps
          location.hash untouched: the hash namespace belongs to the settings router (lib/route.ts,
          exact-match '#settings') — a native '#ad-main' jump would navigate settings→main and pollute
          history. Programmatic focus() replaces the native anchor jump; Enter fires click on an <a>, so it
          stays keyboard-complete. */}
      <a
        href="#ad-main"
        className="ad-skip-link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('ad-main')?.focus();
        }}
      >
        {t('a11y.skipToContent')}
      </a>
      {/* Persistent sidebar SHELL (redesign app-screen Phase 1). The sidebar is the single banner landmark
          (logo + primary nav + language switch); the header/metrics moved onto the results screen. Below lg
          the sidebar collapses to a sticky top bar (flex-wrap, no drawer/JS). */}
      <div className="flex-1 lg:flex">
        <Sidebar view={view} plan={plan} />
        {/* a11y: id/tabIndex make <main> the skip-link target + the focus landing when the skip link is used.
            ad-focus-anchor suppresses the focus ring on this programmatic (tabIndex=-1) target. Honest on BOTH
            views — SettingsPage renders inside this same <main>, so "skip to content" always lands on real
            content. */}
        <main id="ad-main" tabIndex={-1} className="ad-focus-anchor min-w-0 flex-1">
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
        {/* content column — the max-w-6xl padding the old <main> carried (now that <main> is the flex child). */}
        <div className="ad-main-pad mx-auto max-w-6xl px-6 py-8 lg:px-8">
        {/* The main Dropzone/results tree stays MOUNTED but `hidden` while the Settings page shows (design
            §5.1) — `hidden` ⇒ display:none ⇒ the whole subtree (incl. its h1) leaves the AOM, so exactly one
            h1 renders per view and no analysis/fix state is lost on navigation. The live region above stays
            OUTSIDE the wrapper (a display:none live region is not announced by SRs). */}
        <div hidden={view !== 'main'}>
        {phase.t !== 'done' && (
          <>
            <Dropzone
              phase={phase}
              onOpen={openFolder}
              onDrop={(dt) => void filesFromDataTransfer(dt).then(run)}
            />
            {/* The landing sections (nav + how-it-works + disk≠VRAM + capabilities + privacy + pricing +
                FAQ) render BELOW the Dropzone on the idle/analyzing/error screen, inside this same
                <main id="ad-main"> landmark and the settings `hidden` wrapper (auto-hidden on #settings).
                Unmounts at 'done' (the results tree takes over). phase.t is narrowed to exclude 'done' here. */}
            <Landing phaseT={phase.t} />
          </>
        )}

        {report && phase.t === 'done' && index && selectOpts && (
          <div className="space-y-5">
            {/* Results header (app-screen Phase 2): a VISIBLE document-level <h1> = the folder subject + real
                atlas/sprite/loose counts, with a green "diagnosis complete · in-browser" eyebrow (both true,
                NO fabricated timing) and a recoverable-% stat + "Download the fix" CTA. The id ad-results-h1 is
                PRESERVED so focus-move.ts + aria-labelledby keep working; the sr-only companion keeps the
                honest crit+warn+info problem-count for the SR rotor so the h1's accessible name still carries
                it. Heading outline stays h1 → h2(PrimaryRec) → h2(VerdictBar) → h2(findings.title). */}
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="mb-1.5 flex flex-wrap items-center gap-2 font-mono text-xs">
                  <span className="flex items-center gap-1.5 text-cta-text">
                    <span className="h-[7px] w-[7px] rounded-full bg-ok" aria-hidden="true" />
                    {t('results.eyebrow.complete')}
                  </span>
                  <span className="text-ink-soft">· {t('results.eyebrow.inBrowser')}</span>
                </div>
                <h1 id="ad-results-h1" tabIndex={-1} className="ad-focus-anchor font-display text-2xl font-semibold tracking-tight text-ink">
                  {resultsSubject}
                  {countsSuffix ? <span className="ml-1.5 font-mono text-sm font-normal text-ink-soft">· {countsSuffix}</span> : null}
                  <span className="ad-sr-only"> — {resultsHeading(index.tally, t)}</span>
                </h1>
              </div>
              {report.assets.length > 0 ? (
                <div className="flex items-center gap-3">
                  {bm && bm.disk.saved > 0 ? (
                    <div className="text-right">
                      <div className="ad-label text-ink-soft">{t('results.recoverable.label')}</div>
                      <div className="font-mono text-2xl font-semibold text-cta-text">−{bm.disk.savedPct}%</div>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={jumpToFix}
                    className="rounded-lg bg-cta px-4 py-2.5 font-sans text-sm font-semibold text-white shadow-[0_2px_6px_rgba(21,160,106,0.32)] transition hover:bg-cta-hover"
                  >
                    {t('results.download')}
                  </button>
                </div>
              ) : null}
            </div>
            {/* Budget strip — 4 REAL-metric cards (no user budgets / no over-budget bars this phase). Gated on
                having assets (like the header CTA) so an empty folder shows the empty-state below, not a zero strip. */}
            {bm && report.assets.length > 0 ? <BudgetStrip bm={bm} /> : null}
            {/* The PRIMARY "Build a spritesheet" recommendation (design §4.1) — rendered ONLY when the folder
                is loose-dominated (`rec`). Sits between the results h1 and the VerdictBar so the heading
                outline stays monotonic (h1 → this h2 → VerdictBar's h2). Absent when not dominated ⇒ the
                results view is DOM-identical to before. Invents nothing: `rec.n` is should-atlas's own count.
                [Build] flips packLoose + bumps buildNonce (the FixCard nonce effect previews a pack plan). */}
            {rec ? (
              <PrimaryRecommendation
                n={rec.n}
                onBuild={() => setBuildNonce((x) => x + 1)}
                configureHref={SETTINGS_HASH}
              />
            ) : null}
            <VerdictBar
              tally={index.tally}
              severityFilter={severityFilter}
              onToggle={toggleSeverity}
              skippedCount={report.unparsed?.length ?? 0}
              onSkippedJump={jumpToUnparsed}
            />
            {report.assets.length === 0 && index.rows.length === 0 ? (
              <p className="font-mono text-sm text-ink-soft">{t('report.noAssets')}</p>
            ) : (
              // Two-column x-ray triage board: the virtualized ledger (left, 1fr) drives the sticky film
              // detail (right, minmax(320px,420px) — the existing token). On <lg it stacks; the ledger's
              // own scroll container is the only long scroller.
              <section aria-labelledby="ad-results-h1" className="grid items-start gap-6 lg:grid-cols-[1fr_minmax(320px,420px)]">
                <TriageLedger
                  index={index}
                  rows={visibleRows}
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
                  resetSeverities={resetSeverities}
                  totalRows={totalRows}
                  hiddenByType={hiddenByType}
                  onClearHiddenRules={clearHiddenRules}
                  foldedCount={foldedCount}
                  foldOpen={foldOpen}
                  setFoldOpen={setFoldOpen}
                  onRowClick={onRowClick}
                />

                {/* a11y: the film-viewer HERO column is a NAMED region, not <aside> — <aside>=complementary
                    ("supporting, separable") is dishonest for the hero (CLAUDE.md: "Герой — film-viewer").
                    Classes verbatim ⇒ lg:sticky/top-20 + grid placement (by child order) untouched; the tag
                    swap is style-inert (no aside selector in index.css). */}
                <section aria-label={t('region.filmDetail')} className="space-y-3 lg:sticky lg:top-20">
                  {selectedBytes && debouncedSelected ? (
                    <FilmViewer bytes={selectedBytes} findings={assetFindings} highlightId={debouncedHighlight} name={debouncedSelected} metrics={selectedMetrics} frameCount={selectedFrameCount} />
                  ) : (
                    <p className="rounded-xl border border-line bg-panel p-4 font-mono text-sm text-ink-soft">{t('report.noImage')}</p>
                  )}
                  <h2 className="font-mono text-xs uppercase tracking-[0.06em] text-teal-text">{t('findings.title')}</h2>
                  <Findings findings={assetFindings} selectedId={selectedFinding} onSelect={setSelectedFinding} />
                  <FixCard files={files} buildNonce={buildNonce} unlocked={proUnlocked} onUnlockedChange={setProUnlocked} />
                  {/* AB-R2 → settings-page: first-class deep-link to the build config. Gated on having files
                      (inert otherwise). A real hash link to the Settings page; the Formats card ("Форматы
                      вывода") carries PROFILE_PANEL_ANCHOR as a stable target id. (The diagnosis view-filter
                      card now precedes Formats on the page, so the link lands at the settings top, not
                      directly on Formats — an accepted trade for surfacing the honest view filter first.) */}
                  {optimizeEntryEnabled(files.length, true) ? (
                    <a href={SETTINGS_HASH} className="block font-mono text-xs text-teal-text underline-offset-2 hover:underline">
                      {t(OPTIMIZE_ENTRY.anchorKey)}
                    </a>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setPhase({ t: 'idle' })}
                    className="font-mono text-xs text-teal-text underline-offset-2 hover:underline"
                  >
                    {t('action.analyzeAnother')}
                  </button>
                </section>
              </section>
            )}
            {report.unparsed?.length ? (
              <UnparsedNotice items={report.unparsed} open={unparsedOpen} onToggle={setUnparsedOpen} />
            ) : null}
          </div>
        )}
        </div>
        {view === 'settings' ? (
          <SettingsPage hasResults={!!report} hiddenRules={hiddenRules} onChangeHiddenRules={setHiddenRulesPersisted} />
        ) : null}
        {view === 'pro' ? <ProPage unlocked={proUnlocked} onUnlockedChange={setProUnlocked} /> : null}
        </div>
        </main>
      </div>

      {/* The landing footer — the app's first honest contentinfo landmark (a <footer> nested in <main>
          does NOT map to contentinfo, so it renders here as a top-level sibling). UX-4 reserved this slot
          for the landing (no pre-existing footer to reuse). Shown only while the landing itself shows:
          on the main view (not #settings) and pre-'done'. Reuses the shared LanguageSwitcher. */}
      {view === 'main' && phase.t !== 'done' && <LandingFooter switcher={<LanguageSwitcher />} />}

      <input ref={inputRef} type="file" multiple hidden onChange={(e) => {
        const list = e.target.files;
        if (list) void filesFromInput(list).then(run);
      }} />
    </div>
    </BuildSettingsProvider>
  );
}

function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <select
      aria-label={t('ui.language')}
      value={locale}
      onChange={(e) => setLocale(e.target.value as typeof locale)}
      className="rounded-lg border border-line bg-panel px-2 py-1.5 font-mono text-xs text-ink-soft transition hover:border-teal hover:text-teal-text focus:border-teal"
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {NATIVE_NAME[l]}
        </option>
      ))}
    </select>
  );
}

// ── The persistent sidebar SHELL (app-screen redesign Phase 1). Inline like Dropzone/LanguageSwitcher so
//    its t() literals are auto-scanned by i18n-app-keys. The <header> is the single banner landmark (brand +
//    primary <nav> + language switch); NO heading inside (the h1 lives on each screen). At lg+ it is a 236px
//    full-height STICKY column; below lg it collapses to a top bar that flex-wraps (no drawer/JS/focus-trap)
//    and is NOT sticky — a wrapped 2-3 row bar would be taller than the landing sections' scroll-mt-20 (80px)
//    anchor offset and hide headings behind it, so on mobile the bar scrolls away with the page instead. ──
function NavIcon({ d }: { d: 'scan' | 'settings' | 'pro' }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {d === 'scan' ? (
        <>
          <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.7" />
          <path d="M15.5 15.5L20 20" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </>
      ) : d === 'settings' ? (
        <>
          <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
          <path
            d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.7" />
          <path d="M3 10h18" stroke="currentColor" strokeWidth="1.7" />
        </>
      )}
    </svg>
  );
}

// Active fill = bg-teal-text + text-panel (AA-proven in BOTH themes — chipLabelPassesAABothThemes); inactive
// text-ink-soft (AA on panel) + hover:bg-bg (bg is one step below panel in the elevation order ⇒ a hover well).
function NavItem({ href, active, icon, label }: { href: string; active: boolean; icon: ReactNode; label: string }) {
  return (
    <a
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-2.5 rounded-lg px-3 py-2 font-sans text-sm font-medium transition ${
        active ? 'bg-teal-text text-panel' : 'text-ink-soft hover:bg-bg hover:text-ink'
      }`}
    >
      {icon}
      {label}
    </a>
  );
}

function Sidebar({ view, plan }: { view: View; plan: ProPanel }) {
  const { t } = useI18n();
  return (
    <header className="z-50 flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2.5 lg:sticky lg:top-0 lg:h-screen lg:w-[236px] lg:flex-col lg:flex-nowrap lg:items-stretch lg:gap-0 lg:border-b-0 lg:border-r lg:p-0">
      <a href="#" className="flex items-center gap-2.5 lg:w-full lg:border-b lg:border-line lg:px-5 lg:py-5">
        <Logo />
        <span className="font-display text-[16px] font-semibold tracking-tight text-ink">Asset Doctor</span>
      </a>
      <nav aria-label={t('nav.label')} className="flex flex-row gap-1 lg:mt-0 lg:w-full lg:flex-1 lg:flex-col lg:gap-0.5 lg:p-3">
        <NavItem href="#" active={view === 'main'} icon={<NavIcon d="scan" />} label={t('nav.scan')} />
        <NavItem href={SETTINGS_HASH} active={view === 'settings'} icon={<NavIcon d="settings" />} label={t('settings.nav')} />
        <NavItem href={PRO_HASH} active={view === 'pro'} icon={<NavIcon d="pro" />} label={t('nav.pro')} />
      </nav>
      {/* Current-plan card (lg only, no heading) — honest per gate/entitlement state via pro-view.ts; the
          action always routes to the Pro screen (#pro), never a checkout. */}
      <div className="hidden lg:block lg:w-full lg:border-t lg:border-line lg:p-3.5">
        <div className="rounded-xl border border-line bg-bg p-3">
          <div className="ad-label-sm text-ink-soft">{t('pro.plan.label')}</div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="font-display text-[15px] font-semibold text-ink">{t(planValueKey(plan))}</span>
            <a href={PRO_HASH} className="font-mono text-[11px] text-teal-text underline-offset-2 hover:underline">
              {t(planActionKey(plan))} →
            </a>
          </div>
        </div>
      </div>
      <div className="ml-auto lg:ml-0 lg:w-full lg:border-t lg:border-line lg:p-3.5">
        <LanguageSwitcher />
      </div>
    </header>
  );
}

// ── Budget strip (app-screen redesign Phase 2): 4 REAL-metric cards on the results screen — the invariant-5
//    disk≠VRAM honesty surface. NO user budgets / NO over-budget bars this phase (the disk bar is a recoverable
//    RATIO fill, not a budget bar). Big numbers are text-ink only (severity hues fail AA as text — the color
//    signal lives on the decorative aria-hidden dots/segments, redundant with the numbers + VerdictBar chips).
//    Probe-only metrics (measured VRAM, draw calls) degrade to an absent-metric placeholder, never fabricated. ──
function BudgetCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-panel p-4">
      <div className="ad-label text-ink-soft">{label}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function BudgetStrip({ bm }: { bm: BudgetModel }) {
  const { t } = useI18n();
  const m = bm.vram.measured;
  const f = bm.findings;
  const chip =
    f.problems === 0
      ? t('triage.allClear')
      : f.crit > 0
        ? t('triage.filter.crit', { n: f.crit })
        : f.warn > 0
          ? t('triage.filter.warn', { n: f.warn })
          : t('triage.filter.info', { n: f.info });
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {/* VRAM footprint — declared; a measured subline appears only when the render-probe ran (probe-gated). */}
      <BudgetCard label={t('budget.vram.label')}>
        <div className="font-mono text-2xl font-semibold text-ink">{fmtBytes(bm.vram.loaded)}</div>
        {m ? (
          <div
            className="mt-1 font-mono text-[10px] leading-tight text-ink-soft"
            title={t('readout.measuredAggregateTooltip', { n: m.atlasesProbed, declared: m.declared })}
          >
            {t('metric.vramMeasured')} {fmtBytes(m.vram)} · {t('readout.measuredScope', { n: m.atlasesProbed })}
          </div>
        ) : null}
      </BudgetCard>

      {/* Draw calls — the render-probe MEASURES the real draws; without a probe we show the STATIC floor
          (bm.draw.estimated = distinct loaded textures), honestly labelled "estimated" and never as measured. */}
      <BudgetCard label={t('budget.draw.label')}>
        <div className="font-mono text-2xl font-semibold text-ink">{bm.draw.calls != null ? bm.draw.calls : bm.draw.estimated}</div>
        {bm.draw.calls != null && bm.draw.atlasesProbed != null ? (
          <div className="mt-1 font-mono text-[10px] leading-tight text-ink-soft">
            {t('budget.measured')} · {t('readout.measuredScope', { n: bm.draw.atlasesProbed })}
          </div>
        ) : (
          <div className="mt-1 font-mono text-[10px] leading-tight text-ink-soft" title={t('budget.draw.estimatedTooltip', { n: bm.draw.estimated })}>
            {t('budget.draw.estimated')}
          </div>
        )}
      </BudgetCard>

      {/* Disk size — total → after fix; the bar is the recoverable RATIO (savedPct), an honest fraction fill. */}
      <BudgetCard label={t('budget.disk.label')}>
        <div className="flex flex-wrap items-baseline gap-x-1.5 font-mono">
          <span className="text-2xl font-semibold text-ink">{fmtBytes(bm.disk.total)}</span>
          {bm.disk.saved > 0 ? (
            <span className="text-[11px] text-ink-soft">
              → {fmtBytes(bm.disk.after)} {t('budget.disk.afterTag')}
            </span>
          ) : null}
        </div>
        {bm.disk.saved > 0 ? (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line" aria-hidden="true">
            <div className="h-full rounded-full bg-cta" style={{ width: `${bm.disk.savedPct}%` }} />
          </div>
        ) : null}
      </BudgetCard>

      {/* Findings — problem count + a top-severity/all-clear chip; the proportional segments are decorative. */}
      <BudgetCard label={t('budget.findings.label')}>
        <div className="flex flex-wrap items-baseline gap-x-1.5 font-mono">
          <span className="text-2xl font-semibold text-ink">{f.problems}</span>
          <span className="text-[11px] text-ink-soft">· {chip}</span>
        </div>
        {f.segments.length > 0 ? (
          <div className="mt-2 flex gap-0.5" aria-hidden="true">
            {f.segments.map((s) => (
              <span key={s.sev} className={`h-1.5 rounded-full ${DOT[s.sev]}`} style={{ flexGrow: s.count }} />
            ))}
          </div>
        ) : null}
      </BudgetCard>
    </div>
  );
}

// Honest "could not analyze" surface — symmetric with the fix receipt's skipped[] list. Reuses the
// fix.skipped <details> styling. Reasons stay English (parser strings, same precedent as fix.skipped).
// CONTROLLED (UX-4): the VerdictBar skipped chip opens it + anchor-scrolls here. `id` is the chip's scroll
// target (scroll-mt-20 clears the sticky header); the `<summary>` id is the focus target. `onToggle` keeps
// the parent state in sync when the user closes it natively (no preventDefault — native behavior preserved).
function UnparsedNotice({ items, open, onToggle }: { items: NonNullable<AnalysisReport['unparsed']>; open: boolean; onToggle: (open: boolean) => void }) {
  const { t } = useI18n();
  return (
    <details
      id={UNPARSED_DETAILS_ID}
      open={open}
      onToggle={(e) => onToggle(e.currentTarget.open)}
      className="scroll-mt-20 rounded-md border border-line bg-bg p-2 text-left open:pb-2.5"
    >
      <summary id={UNPARSED_SUMMARY_ID} className="cursor-pointer ad-label text-ink-soft">
        {t('report.unparsed.title', { n: items.length })}
      </summary>
      {/* Cap the 1000-entry case to one screen of scroll instead of a 9000px page append (each entry ~10px). */}
      <ul className="mt-1.5 max-h-72 space-y-1 overflow-y-auto">
        {items.map((u, i) => (
          <li key={i} className="font-mono text-[10px] leading-relaxed text-ink-soft">
            <span className="break-all">{u.ref}</span> — {u.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}

// Localized error card: a role=alert TITLE + the raw worker message demoted to a collapsed <details>. The
// title/label/passthrough split is decided by the PURE errorCard() (error-view.ts); this is a thin render of
// its output. role=alert (implicit aria-live=assertive) is on the TITLE ONLY, so a failure is announced
// immediately WITHOUT reading the raw English body assertively. `mt` lets each call site keep its spacing.
function ErrorNotice({ state, ctx, mt = 'mt-3' }: { state: ErrorState; ctx?: ErrorContext; mt?: string }) {
  const { t } = useI18n();
  const card = errorCard(state, t, ctx);
  return (
    <div className={`${mt} text-center`}>
      <p role="alert" className="font-mono text-xs text-crit-text">{card.title}</p>
      {card.detail && (
        <details className="mt-1.5 inline-block max-w-full text-left">
          <summary className="cursor-pointer ad-label text-ink-soft">
            {card.detail.label}
          </summary>
          {/* tabIndex=0 + aria-label so a keyboard-only (non-SR) user can focus and scroll an overlong raw
              message inside the max-h-40 clip (WCAG 2.1.1); an SR reads the full DOM text regardless. */}
          <p tabIndex={0} aria-label={card.detail.label} className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-ink-soft">
            {card.detail.body}
          </p>
        </details>
      )}
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
  // a11y: honest progress bar spec from the worker's REAL done/total (indeterminate when total unknown).
  const view = progressView(phase.t === 'analyzing' ? phase.progress : undefined);
  // Secondary CTA: smooth-scroll + focus the How-it-works section (mirrors Landing.onAnchorClick),
  // reduced-motion gated. '#how-it-works' never matches the exact-match settings router, so history stays clean.
  const reduce = (): boolean =>
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const scrollToHow = (): void => {
    document.getElementById(h2IdOf('how-it-works'))?.focus({ preventScroll: true });
    document.getElementById('how-it-works')?.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth' });
    history.replaceState(null, '', '#how-it-works');
  };
  return (
    // a11y: the Dropzone HERO is a NAMED region — aria-labelledby points at its own visible h1 (the ONE h1 on
    // the idle/analyzing/error view; the name can never drift from the copy). Two columns on lg+ (pitch + real
    // CTAs left, the signature demo viewer + drop target right); stacks below lg.
    <section aria-labelledby="ad-dropzone-h1" className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      {/* LEFT — pitch + the real conversion (Open folder) */}
      <div className="text-center lg:text-left">
        <div className="mb-5 inline-flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-[0.06em] text-teal-text">
          <span className="ad-pulse-dot inline-block h-[7px] w-[7px] rounded-full bg-cta" />
          {t('header.xray')}
        </div>
        <h1 id="ad-dropzone-h1" tabIndex={-1} className="ad-focus-anchor text-balance font-display text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl">{t('dropzone.title')}</h1>
        {/* tagline (full ink — the value prop) + the analysis-scoped subtitle. */}
        <p className="mx-auto mt-4 max-w-xl text-pretty text-[15px] leading-relaxed text-ink lg:mx-0">{t('landing.tagline')}</p>
        <p className="mx-auto mt-3 max-w-xl text-pretty text-[15px] leading-relaxed text-ink-soft lg:mx-0">{t('dropzone.subtitle')}</p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
          <button
            type="button"
            id={LANDING_OPEN_FOLDER_ID}
            onClick={onOpen}
            className="rounded-lg bg-cta px-5 py-2.5 font-sans text-sm font-semibold text-white shadow-[0_2px_6px_rgba(21,160,106,0.32)] transition hover:bg-cta-hover"
          >
            {t('dropzone.open')}
          </button>
          <a
            href="#how-it-works"
            onClick={(e) => {
              e.preventDefault();
              scrollToHow();
            }}
            className="rounded-lg border border-line bg-panel px-5 py-2.5 font-sans text-sm font-semibold text-ink transition hover:border-teal hover:text-teal-text"
          >
            {t('landing.scrollHint')}
          </a>
        </div>
        {/* privacy pin — shield in the ok token (invariant 1: nothing is uploaded for the diagnosis). */}
        <div className="mt-6 flex items-center justify-center gap-2 font-mono text-[12.5px] text-ink-soft lg:justify-start">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" stroke="var(--color-ok)" strokeWidth="1.7" strokeLinejoin="round" />
            <path d="M9 12l2.2 2.2L15.5 10" stroke="var(--color-ok)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t('dropzone.privacy')}
        </div>
        {phase.t === 'error' && <ErrorNotice state={phase.error} mt="mt-6" />}
        {/* Mobile honesty line (visible only < sm). Never promises mobile analysis (WebGL probe / FS Access
            limits) but doesn't say "impossible" either — file-input folder picking exists. */}
        <p className="mx-auto mt-4 max-w-xl text-center font-mono text-[11px] text-ink-soft sm:hidden lg:text-left">{t('landing.mobileNote')}</p>
      </div>

      {/* RIGHT — the signature viewer: BOTH the illustrative demo AND the real drop/click target (runs a real
          diagnosis). The decorative demo chrome (top bar, specimen, readout, drop prompt) is aria-hidden so a
          SR is not read a fabricated "symbols.png / VRAM —" ; the analyzing progress (role=status) stays
          announced, and the honesty caption below is read. The accessible open control is the left button;
          click/drag on the viewer is a mouse-only convenience. */}
      <div>
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
          onClick={onOpen}
          className={`ad-grid ad-clip ad-viewer-shadow relative cursor-copy rounded-2xl border p-3.5 transition-colors ${
            dragging ? 'border-teal' : 'border-film-border'
          }`}
        >
          {/* top bar — illustrative demo filename + format badge. */}
          <div aria-hidden="true" className="flex items-center gap-2 px-1 pb-3 pt-1 font-mono text-[12.5px] text-film-soft">
            symbols.png
            <span className="rounded bg-info px-1.5 py-0.5 text-[10px] font-semibold text-film">PNG</span>
          </div>
          {/* stage */}
          <div aria-busy={analyzing} className="relative aspect-square overflow-hidden rounded-lg">
            {analyzing ? (
              // a11y: the otherwise-silent progress text is a polite live region so a SR user who opened a
              // folder hears "analyzing… N/M · label". aria-atomic reads the whole phrase.
              <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
                <div className="ad-scanline" aria-hidden="true" />
                <Logo size={40} />
                <p role="status" aria-live="polite" aria-atomic="true" className="font-mono text-sm text-[#9be7e7]">
                  {t('dropzone.analyzing')}{' '}
                  {phase.progress ? t('dropzone.progress', { done: phase.progress.done, total: phase.progress.total, label: phase.progress.label }) : ''}
                </p>
                {/* machine-readable determinate progress (role=progressbar); indeterminate ⇒ static dashed track. */}
                <div
                  className={`ad-progress-track${view.determinate ? '' : ' ad-progress-indet'}`}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-label={t('dropzone.analyzing')}
                  {...(view.determinate ? { 'aria-valuenow': view.valueNow, 'aria-valuemax': view.valueMax } : {})}
                >
                  {view.determinate && <div className="ad-progress-fill" style={{ width: view.pct + '%' }} aria-hidden="true" />}
                </div>
              </div>
            ) : (
              // illustrative atlas specimen — SHIPPED static geometry + the real overlay palette (ZONE_STYLE),
              // so the demo can never drift from what the FilmViewer actually paints. Decorative ⇒ aria-hidden.
              // absolute inset-0 fills the aspect-square stage (so the svg h-full has a sized parent and the
              // scanline / drop prompt anchor to the stage).
              <div aria-hidden="true" className="absolute inset-0">
                <svg viewBox={`0 0 ${SPECIMEN_VIEWBOX.w} ${SPECIMEN_VIEWBOX.h}`} className="block h-full w-full">
                  {SPECIMEN_FRAMES.map((f, i) => (
                    <rect key={`f${i}`} x={f.x} y={f.y} width={f.w} height={f.h} rx={3} fill="rgba(255,255,255,0.05)" stroke="var(--color-film-border)" strokeWidth={1} />
                  ))}
                  {SPECIMEN_ZONES.map((z, i) => (
                    <rect key={`z${i}`} x={z.x} y={z.y} width={z.w} height={z.h} rx={2} fill={ZONE_STYLE[z.kind].fill} stroke={ZONE_STYLE[z.kind].stroke} strokeWidth={1.5} strokeDasharray={z.kind === 'empty' ? '4 3' : undefined} />
                  ))}
                </svg>
                <div className="ad-scanline" />
                {dragging && (
                  <div className="absolute inset-2 flex items-center justify-center rounded-lg border-2 border-dashed border-teal bg-teal/10 font-mono text-sm text-[#9be7e7]">
                    {t('dropzone.dropPrompt')}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* readout strip — every value '—' (illustrative, not a measurement; hero-readout.ts pins it). */}
          <div aria-hidden="true" className="mt-3 grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-film-border bg-film-border">
            {HERO_READOUT_CELLS.map((c) => (
              <div key={c.label} className="bg-film px-2 py-1.5 text-center">
                <div className="ad-label-sm text-film-soft">{c.label}</div>
                <div className="font-mono text-[11px] font-semibold text-film-soft">{c.value}</div>
              </div>
            ))}
          </div>
        </div>
        {/* honesty caption OUTSIDE the aria-hidden chrome (so SRs read it). */}
        <p className="mt-2 text-center font-mono text-[10px] text-ink-soft">{t('dropzone.demoCaption')}</p>
      </div>
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
  | { t: 'error'; error: ErrorState };

function downloadZip(zip: Blob): void {
  const url = URL.createObjectURL(zip);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'optimized-folder.zip';
  a.click();
  URL.revokeObjectURL(url);
}

// OPT-IN backend consent surface (round12 §4) — the CONSENT half of the old BackendKtx2Panel, kept on the
// run surface (the op TOGGLES moved to the Settings page). Rendered only once an op is enabled. Surfaces the
// three honest pre-upload costs (bigger zip / conditional VRAM / transcoder dependency for KTX2; smaller-
// download-only for pngquant; quality-only for resample), the EXACT upload-count upper bound + a short sample,
// and the explicit "these images are uploaded" consent checkbox — enabled ONLY when the healthz probe
// succeeded (reachable), DEFAULT OFF, reset every run (never sticky). Pure presentation of props.
function BackendConsentPanel({
  ktx2Enable,
  pngquantEnable,
  resampleEnable,
  ready,
  consent,
  setConsent,
  uploadPreview,
}: {
  ktx2Enable: boolean;
  pngquantEnable: boolean;
  resampleEnable: boolean;
  ready: boolean;
  consent: boolean;
  setConsent: (b: boolean) => void;
  uploadPreview: { count: number; sample: string[] };
}) {
  const { t } = useI18n();
  return (
    <div className="mt-2 rounded-md border border-line bg-bg p-2 text-left">
      {/* Reachability status from the healthz probe. */}
      <p className={`font-mono text-[10px] ${ready ? 'text-ok' : 'text-warn'}`}>
        {ready ? t('fix.backend.reachable') : t('fix.backend.unreachable')}
      </p>
      {/* Honest per-op costs — shown only for the op(s) actually enabled. */}
      <ul className="mt-2 list-disc space-y-1 pl-4 font-mono text-[10px] leading-relaxed text-ink-soft">
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
      {/* TRANSPARENCY: the EXACT upper-bound count + a short sample of which files would leave the device,
          shown BEFORE consent. The worker may upload fewer (compose/skip), never more. */}
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
              <li className="font-mono text-[9px] text-ink-soft">{t('fix.backend.uploadMore', { n: uploadPreview.count - uploadPreview.sample.length })}</li>
            ) : null}
          </ul>
        ) : null}
      </div>
      {/* CONSENT — the explicit "these images are uploaded to the server" acknowledgement. Enabled ONLY when
          the backend is reachable; DEFAULT OFF, reset every run (never sticky). */}
      <label className={`mt-2 flex items-start gap-1.5 font-mono text-[10px] ${ready ? 'text-ink' : 'text-ink-soft/50'}`}>
        <input type="checkbox" checked={consent} disabled={!ready} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 accent-cta" />
        <span className="font-semibold">{t('fix.backend.consent')}</span>
      </label>
    </div>
  );
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
      <summary className="cursor-pointer ad-label text-teal-text">{t('fix.bundles.title')}</summary>
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
        {rootLoose > 0 ? <p className="truncate font-mono text-[10px] text-ink-soft">{t('fix.bundles.root')} · {rootLoose}</p> : null}
      </div>
      <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.lazy.note')}</p>
    </details>
  );
}

// The Phase-2 fix: repack + transcode the loaded folder in a worker, then download a drop-in
// optimized .zip. Assets never leave the device. The Pro gate is OFF by default (free) and only
// engages when VITE_PRO_GATE === 'true' — then a valid offline-verified entitlement is required.
function FixCard({
  files,
  buildNonce,
  unlocked,
  onUnlockedChange,
}: {
  files: PickedFile[];
  buildNonce: number;
  /** Pro entitlement — a SINGLE source owned by App (also drives the sidebar plan card + ProPage), so
   *  activating/deactivating here keeps every entitlement surface in sync (review Phase 4 MINOR fix). */
  unlocked: boolean;
  onUnlockedChange: (v: boolean) => void;
}) {
  const { t } = useI18n();
  // The full build-config surface now lives in the shared BuildSettings context (edited on the Settings
  // page). FixCard only READS it — to build the run's FixOptions (buildFixOptions) and to gate two
  // run-surface UI decisions (aggressive → BundlesPanel; the manifest auto-pair note).
  const { settings } = useBuildSettings();
  const [phase, setPhase] = useState<FixPhase>({ t: 'idle' });
  // The card's root — the buildNonce effect scrolls it into view (behavior:'auto' — reduced-motion-safe).
  const cardRef = useRef<HTMLDivElement>(null);

  // Per-run state that STAYS in the FixCard (NOT a setting; never on the Settings page): marking defaults to
  // {} ⇒ every bundle is treated as 'isolated' by buildDedupGroups (same-bundle dedup only). skinGuard is a
  // const {} MVP (design §5b). Both ride only under `settings.aggressive` (the gate lives in buildFixOptions).
  const [marking, setMarking] = useState<LazyMarking>({});
  const skinGuard: SkinGuard = {};
  // Selective fix — the OpKinds the user DESELECTED in the Plan card. INTRA-PLAN (a per-row checkbox; default
  // = nothing excluded ⇒ full fix). Forwarded VERBATIM to BOTH plan and execute so a re-previewed plan and
  // its committed run share the mask byte-for-byte. DELIBERATELY ABSENT from the stale-plan reset deps below:
  // a row toggle re-previews IN PLACE via togglePlanKind. Reset on every fresh preview(). Empty ⇒ byte-identical.
  const [excludeKinds, setExcludeKinds] = useState<Set<OpKind>>(() => new Set());

  // ── OPT-IN backend native ops (round12 §4) — the op TOGGLES live in settings now (Settings page → Backend
  // card); the per-run CONSENT + healthz result stay HERE (invariant 1/2 — consent is never sticky, never a
  // setting). A backend is "configured" when an API base is set AND we hold a stored entitlement token.
  // `backendAnyEnable` opens the shared healthz-probe + consent path. When any precondition is unmet
  // buildFixOptions omits the `backend` field ⇒ the worker's whole backend path is dead ⇒ zip BYTE-IDENTICAL
  // to today. `backendConsent` = the per-run "these images are uploaded" acknowledgement (reset when the path
  // can't engage). `backendReady` = the gateway healthz probe succeeded (fired only after unlock + config + op).
  const backendConfigured = API_BASE !== '' && loadStoredEntitlement() != null;
  const backendAnyEnable = settings.ktx2Enable || settings.pngquantEnable || settings.resampleEnable;
  const [backendConsent, setBackendConsent] = useState(false);
  const [backendReady, setBackendReady] = useState(false);

  // round12 B-transparency: BEFORE consent, surface the EXACT count + a short sample of which files would
  // leave the device — an HONEST UPPER BOUND from the loaded folder (the worker may compose/skip fewer, never
  // more): KTX2 ⇒ any raster page; pngquant ⇒ PNG only; resample ⇒ any raster page a tier downscale could
  // emit. Union of the enabled ops' candidate sets — deterministic, dir-aware (the SAME keyOf the worker keys
  // by), pure presentation (no bytes read, no network).
  const uploadPreview = useMemo(() => {
    if (!backendAnyEnable) return { count: 0, sample: [] as string[] };
    const refs: string[] = [];
    for (const f of files) {
      const ref = keyOf(f);
      const isPng = /\.png$/i.test(ref);
      const isImage = /\.(png|webp|jpe?g|avif)$/i.test(ref);
      if ((settings.ktx2Enable && isImage) || (settings.pngquantEnable && isPng) || (settings.resampleEnable && isImage)) refs.push(ref);
    }
    refs.sort(cmp);
    return { count: refs.length, sample: refs.slice(0, 8) };
  }, [files, backendAnyEnable, settings.ktx2Enable, settings.pngquantEnable, settings.resampleEnable]);

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
  // (Pro entitlement is probed ONCE at the App level and passed in as `unlocked` — see the app-level effect;
  //  FixCard no longer probes independently, so every entitlement surface reads the same source.)

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
  // (mode:'execute') send — the EXTRACTED, Node-tested buildFixOptions(settings, perRun) (lib/build-settings).
  // The full build-config surface comes from `settings` (edited on the Settings page); the per-run inputs
  // (the deselection mask, marking/skinGuard, the consent-gated backend, whether the backend will upload)
  // come from the FixCard. The mutual exclusions (webpNearLossless / scaleTiers omitted when an export
  // profile is sent) are decided against ONE settings snapshot inside the helper — strictly stronger than the
  // old separate useStates; a default run is pinned byte-identical by build-settings.test.ts. `over` lets a
  // PlanCard toggle pass the NEXT exclude set explicitly (no async setState-batching dependency).
  function buildOptions(over?: Set<OpKind>) {
    return buildFixOptions(settings, {
      excludeKinds: over ?? excludeKinds,
      marking,
      skinGuard,
      // The SOLE place a consent-gated `backend` field is built (undefined unless every precondition holds ⇒
      // the worker's backend path stays dead ⇒ zip byte-identical to today).
      backend: buildBackendOptions(),
      // round12 auto-pair: a consented backend run forces the Pixi manifest ON inside the helper so the
      // .ktx2/re-compressed pages never ship without loader wiring.
      backendWillUpload,
    });
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
    if (settings.ktx2Enable) ops.push('ktx2');
    if (settings.pngquantEnable) ops.push('pngquant');
    if (settings.resampleEnable) ops.push('resample');
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
        setPhase({ t: 'error', error: { kind: 'noFiles' } });
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
      setPhase({ t: 'error', error: { kind: 'failed', detail: errDetail(e) } });
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
        setPhase({ t: 'error', error: { kind: 'noFiles' } });
        return;
      }
      const out = await runFix(sourced, buildOptions(), (p) => setPhase({ t: 'running', p }), ctrl.signal);
      downloadZip(out.zip);
      setPhase({ t: 'done', out });
    } catch (e) {
      // A superseded run rejects AbortError — a newer run/preview now owns the card; swallow it.
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setPhase({ t: 'error', error: { kind: 'failed', detail: errDetail(e) } });
    }
  }

  // Stale-plan invalidation: if any option changes after a preview, the shown plan no longer matches what
  // "Run fix" would commit — reset to the options view so the user re-previews. The whole build-config
  // surface now lives in ONE `settings` object whose identity changes on every edit (patchSettings spreads),
  // so keying on `[settings, marking]` invalidates a pending plan on ANY setting change — including edits made
  // on the Settings page while this card is hidden (this implements "settings apply to the NEXT run"). Skips
  // the first render. `excludeKinds` is DELIBERATELY ABSENT (selective fix): a Plan-card row toggle re-previews
  // IN PLACE via togglePlanKind — it does NOT invalidate the plan. Do NOT add it, or every toggle resets to idle.
  const sawPlan = useRef(false);
  useEffect(() => {
    if (sawPlan.current) setPhase({ t: 'idle' });
  }, [settings, marking]);
  // Consent is NEVER sticky: drop the per-run "uploaded to server" acknowledgement the moment BOTH backend
  // ops are disabled OR the backend becomes unreachable, so a fresh run can't inherit a prior tick. The user
  // must re-consent each time the upload path could engage.
  useEffect(() => {
    if (!(backendAnyEnable && backendReady)) setBackendConsent(false);
  }, [backendAnyEnable, backendReady]);
  useEffect(() => {
    sawPlan.current = phase.t === 'plan';
  }, [phase.t]);

  // [Build] bridge (spritesheet-first design §4.3): the primary recommendation card bumped `buildNonce` in
  // App (in the SAME commit that flipped packLoose via the context patch), so this effect — firing AFTER that
  // commit — previews a plan whose closure already reads packLoose:true, then scrolls the card into view. The
  // prev-value ref skips the initial mount (and any FixCard remount on a fresh report, where buildNonce may
  // still be >0) so a preview fires ONLY on a genuine increment — never spontaneously on a new analysis.
  const buildNonceSeen = useRef(buildNonce);
  useEffect(() => {
    if (buildNonce === buildNonceSeen.current) return; // mount / unrelated re-render — not a Build click
    buildNonceSeen.current = buildNonce;
    void preview();
    cardRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' });
  }, [buildNonce]); // fire ONLY on the nonce edge (prev-value ref guards mount); matches the file's other effects

  // Gated + not yet unlocked → show activation instead of the run button.
  if (PRO_GATE_ENABLED && !unlocked) {
    return (
      <div ref={cardRef} id={FIX_CARD_ID} className="rounded-2xl border-2 border-teal/70 bg-panel p-4 text-center">
        <p className="font-mono text-xs text-ink-soft">{t('pro.note')}</p>
        <ActivatePanel onUnlocked={() => onUnlockedChange(true)} />
      </div>
    );
  }

  return (
    <div ref={cardRef} id={FIX_CARD_ID} className="rounded-2xl border-2 border-teal/70 bg-panel p-4 text-center">
      {/* AB-R2: first-class "optimize this folder" header — names the capability the SAME Pro fix engine
          already has (convert / scale variants / repack, structure preserved). Honest copy, no new claim;
          pro.note is retained below as the small Phase-2 sub-note. Token-driven (font-display / font-mono /
          text-ink / text-ink-soft / teal — no new tokens). */}
      <h3 className="font-display text-base font-semibold text-ink">{t(OPTIMIZE_ENTRY.titleKey)}</h3>
      <p className="mx-auto mt-1 max-w-sm font-mono text-[11px] leading-relaxed text-ink-soft">{t(OPTIMIZE_ENTRY.subKey)}</p>
      <p className="mt-1 font-mono text-[10px] text-ink-soft">{t('pro.note')}</p>
      {phase.t === 'planning' ? (
        <p className="mt-2.5 font-mono text-xs text-teal-text">{t('dropzone.analyzing')}</p>
      ) : phase.t === 'running' ? (
        <p className="mt-2.5 font-mono text-xs text-teal-text">{t('fix.optimizing')} {phase.p.total > 1 ? `${phase.p.done}/${phase.p.total}` : ''} {phase.p.label}</p>
      ) : phase.t === 'plan' ? (
        <PlanCard summary={phase.summary} excluded={excludeKinds} pending={phase.pending ?? false} onToggle={togglePlanKind} onRun={run} onBack={() => setPhase({ t: 'idle' })} disabled={files.length === 0} />
      ) : phase.t === 'done' ? (
        <Receipt receipt={phase.out.receipt} onRedownload={() => downloadZip(phase.out.zip)} />
      ) : (
        <>
          {/* The build config lives on the dedicated Settings page now — a real hash link jumps there
              (design §5.2: FixCard points at the config, doesn't host it). */}
          <a href={SETTINGS_HASH} className="mt-2 inline-block font-mono text-[11px] text-teal-text underline-offset-2 hover:underline">
            {t('settings.open')}
          </a>

          {/* Per-bundle marking (aggressive dedup) needs the loaded folder, so it stays on the run surface —
              shown only when the aggressive/merge setting is on AND there are ≥2 multi-file folder bundles. */}
          {settings.aggressive && showBundles ? (
            <BundlesPanel folders={bundles.folders} rootLoose={bundles.rootLoose} marking={marking} setMarking={setMarking} />
          ) : null}

          {/* round12 auto-pair note: a consented backend run FORCES the Pixi manifest ON (the .ktx2/re-
              compressed pages need loader wiring). Shown HERE where the per-run backendWillUpload is known;
              the manifest checkbox itself lives on the Settings page. */}
          {backendWillUpload && !settings.emitPixiManifest ? (
            <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.backend.manifestAutoPaired')}</p>
          ) : null}

          {/* OPT-IN backend consent (round12) — the op TOGGLES live on the Settings page; the per-run CONSENT,
              reachability status, honest costs and upload preview stay HERE, next to Run (invariant 1/2 —
              consent is never sticky, never a setting). Shown only once an op is enabled. */}
          {backendAnyEnable ? (
            <BackendConsentPanel
              ktx2Enable={settings.ktx2Enable}
              pngquantEnable={settings.pngquantEnable}
              resampleEnable={settings.resampleEnable}
              ready={backendReady}
              consent={backendConsent}
              setConsent={setBackendConsent}
              uploadPreview={uploadPreview}
            />
          ) : null}

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
            className="mt-2 w-full rounded-lg border border-line px-3 py-1.5 font-mono text-[11px] text-teal-text transition hover:border-teal disabled:opacity-55"
          >
            {t('pro.cta')}
          </button>
        </>
      )}
      {phase.t === 'error' && <ErrorNotice state={phase.error} ctx="fix" mt="mt-2" />}
      {PRO_GATE_ENABLED && unlocked && <ProBadge onDeactivated={() => onUnlockedChange(false)} />}
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
          <span className="mt-0.5 block text-ink-soft">{t('fix.meshNote')}</span>
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
          <span className="mt-0.5 block text-ink-soft">{t('fix.profile.diskNote')}</span>
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
            <p className="font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.backend.receiptLoader')}</p>
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
            <p className="font-mono text-[10px] text-ink-soft">
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
        <p className="font-mono text-[10px] text-ink-soft">{t('fix.extrudeSkipped', { n: receipt.extrudeSkipped ?? 0 })}</p>
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
          <p className="font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.tier.diskNote')}</p>
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
        <p className="font-mono text-[10px] text-cta-text">{t('fix.dedup.diskSaved', { bytes: receipt.dedupDiskBytesSaved ?? 0 })}</p>
      ) : null}
      {(receipt.dedupVramBytesSavedUpperBound ?? 0) > 0 ? (
        <p className="font-mono text-[10px] text-ink-soft">{t('fix.dedup.vramUpperBound', { bytes: receipt.dedupVramBytesSavedUpperBound ?? 0 })}</p>
      ) : null}
      {/* Bare duplicate-drop VRAM upper bound (invariant 5): a near-duplicate was DELETED but its reference was
          left dangling (no auto-repoint), so this VRAM is realized ONLY if the user manually repoints to the kept
          copy — a SEPARATE upper bound, never folded into the hard VRAM row above (strictly weaker than the dedup
          upper bound). The DISK saving is already counted in the headline disk row. Gated > 0 (additive). */}
      {(receipt.droppedDuplicateVramBytesUpperBound ?? 0) > 0 ? (
        <p className="font-mono text-[10px] text-ink-soft">{t('fix.nearDup.vramUpperBound', { bytes: receipt.droppedDuplicateVramBytesUpperBound ?? 0 })}</p>
      ) : null}
      {/* Skipped → first-class list of the honest per-asset reason strings (was a bare count). Skips are
          informational (what the fix REFUSED to touch / couldn't do), not warnings → text-ink-soft. */}
      {receipt.skipped.length > 0 ? (
        <details className="rounded-md border border-line bg-bg p-2 text-left open:pb-2.5">
          <summary className="cursor-pointer ad-label text-ink-soft">
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
      <button type="button" onClick={onRedownload} className="w-full rounded-lg border border-line px-3 py-1.5 font-mono text-[11px] text-teal-text transition hover:border-teal">
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
            <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-ink-soft">{r.diagnosis}</p>
            <p className="mt-0.5 font-mono text-[10px] text-teal-text">→ {r.fix}</p>
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
      <summary className="cursor-pointer ad-label text-teal-text">
        {t('fix.sheetDiff.title', { n: sheetDiffs.length })}
      </summary>
      <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.sheetDiff.proofNote')}</p>
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
          <p className="px-1 ad-label-sm text-ink-soft">{t('fix.sheetDiff.before')}</p>
          <FilmViewer bytes={diff.beforeBytes} findings={[]} name={diff.name} metrics={beforeMetrics} />
        </div>
        <div className="space-y-1">
          <p className="px-1 ad-label-sm text-ink-soft">{t('fix.sheetDiff.after')}</p>
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
        <p className="break-all px-1 font-mono text-[10px] leading-relaxed text-teal-text">
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
      <div className="flex items-center justify-center gap-1.5 font-mono text-xs text-teal-text">
        <span className="h-2 w-2 rounded-full bg-teal" /> {t('fix.plan.title', { n: summary.totalOps })}
        {/* Re-preview in flight after a checkbox toggle: subtle hint, card stays mounted (no flicker). Reuses
            the existing dropzone.analyzing string so no new 9-catalog key is needed (design N3). */}
        {pending ? <span className="font-mono text-[10px] text-ink-soft">· {t('dropzone.analyzing')}</span> : null}
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
                  {off ? <span className="ad-label-sm text-warn">{t('fix.plan.deselected')}</span> : null}
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
            <span className="text-teal-text">{t('fix.plan.measuredNowVram', { vram: summary.footprint.vramBytesSaved })}</span>
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
          <summary className="cursor-pointer ad-label text-ink-soft">
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
      <p className="font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.plan.deferredNote')}</p>
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
      <button type="button" onClick={onBack} className="w-full rounded-lg border border-line px-3 py-1.5 font-mono text-[11px] text-teal-text transition hover:border-teal">
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
      <summary className="cursor-pointer ad-label text-teal-text">
        {t('fix.changes.title', { n: operations.length })}
      </summary>
      <div className="mt-1.5 space-y-2">
        {groups.map((g) => (
          <div key={g.kind ?? 'other'}>
            <p className="ad-label-sm text-ink-soft">
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
      <summary className="cursor-pointer ad-label text-warn">
        {t('fix.migrate.title')} · {changes.length}
      </summary>
      <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-ink-soft">{t('fix.migrate.note')}</p>
      {/* Engine toggle — product names are CODE (untranslated, design M5), not catalog entries. */}
      <div className="mt-1.5 flex gap-1">
        {(['pixi', 'phaser'] as const).map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => setEngine(e)}
            aria-pressed={engine === e}
            className={`rounded px-2 py-0.5 font-mono text-[10px] transition ${engine === e ? 'bg-teal-text text-panel' : 'border border-line text-ink-soft hover:border-teal'}`}
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
              className="rounded border border-line px-2 py-0.5 font-mono text-[10px] text-teal-text transition hover:border-teal"
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
        <span className="text-cta-text">{pct >= 0 ? `−${pct}%` : `+${-pct}%`}</span>
      </span>
    </div>
  );
}
