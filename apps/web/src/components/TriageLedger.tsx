import { useCallback, useMemo, type KeyboardEvent } from 'react';
import type { Finding } from '@asset-doctor/core';
import { useI18n } from '../lib/i18n';
import { fmtBytes } from '../lib/format';
import { useWindow } from '../lib/useWindow';
import { nextActiveIndex, scrollToActive, type NavKey } from '../lib/ledger-nav';
import { DOT, TXT } from './Findings';
import {
  isAssetAxis,
  type LedgerRow,
  type SelectOpts,
  type SortKey,
  type TriageIndex,
} from '../lib/triage';

// The virtualized triage ledger — the scalable replacement for the old AssetSelector chip wall. Default
// unit is the PROBLEM (one row per finding), worst-first, driven by the pure buildIndex/selectRows index.
// Only the visible window (~25-35 items) is ever mounted (useWindow) so it stays responsive at 1000+ assets
// (invariant 4). Rows use STATIC dots (no ad-pulse-dot / ad-reveal) — those mount/unmount on every scroll
// tick and would thrash the compositor at scale; the pulse stays reserved for the film + detail card.
//
// EVERY item (row OR group header) is exactly ROW_H tall, so the windower's uniform-height slice math is
// exactly correct even in group-by-folder mode (no offset drift, deterministic).
//
// HONESTY (invariants 3 & 5): every figure shown here is an existing measured field, only ranked / filtered
// / formatted. Sparse metrics render "—", never a fake 0. Folder rows show no per-asset VRAM/OCC (a folder
// finding is not one asset's footprint); grouped rollups sum DECLARED vram only and show "—" when nothing is
// estimable. The dir-aware assetRef is middle-truncated for width but the FULL value rides in `title=` so the
// disambiguating folder is never hidden (the keyOf keying invariant).

const ROW_H = 52; // fixed item height (rows AND headers) — the windower's slice math depends on it.

const SORT_KEYS: SortKey[] = ['severity', 'wastedDisk', 'vram', 'occupancy'];

// Keyboard nav (WCAG 2.1.1): the ledger virtualizes (~25-35 mounted rows), so without keyboard primitives a
// keyboard / screen-reader user can reach only the mounted slice. We use the aria-activedescendant LISTBOX
// pattern (NOT roving tabindex): DOM focus stays on the stable container so it is never orphaned when a row
// unmounts on scroll; the "active option" is a pure ARIA pointer (an id string). nextActiveIndex moves the
// active OPTION; scrollToActive feeds the SAME single scrollTop the existing windower consumes so the target
// re-mounts (useWindow untouched). Both are pure, unit-tested in ledger-nav.test.ts.
const NAV_KEYS: ReadonlySet<string> = new Set<NavKey>([
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/** Stable DOM id for a row's option element, derived from the row id (Finding.id — unique per finding). Used
 *  by aria-activedescendant on the container and `id` on each option so they resolve when a row re-mounts. */
function optionId(rowId: string): string {
  return `ledger-opt-${rowId}`;
}

/** Middle-truncate a long ref ("ui/.../play.png") keeping both ends so the folder + basename stay legible;
 *  the full value is always exposed via the row's title attribute. */
function midTruncate(ref: string, head = 16, tail = 22): string {
  if (ref.length <= head + tail + 1) return ref;
  return `${ref.slice(0, head)}…${ref.slice(-tail)}`;
}

/** A scope/metric badge for a row. Labelled (DISK/VRAM/OCC) so disk≠VRAM stays explicit; sparse ⇒ "—". */
function metricBadge(row: LedgerRow, sort: SortKey): { label: string; value: string } | null {
  // Under an asset-axis sort, surface that asset metric; otherwise prefer the row's measured wasted-disk.
  if (sort === 'vram') return { label: 'VRAM', value: row.metric.vram === undefined ? '—' : fmtBytes(row.metric.vram) };
  if (sort === 'occupancy')
    return { label: 'OCC', value: row.metric.occupancy === undefined ? '—' : `${Math.round(row.metric.occupancy * 100)}%` };
  if (row.metric.wastedDisk !== undefined) return { label: 'DISK', value: fmtBytes(row.metric.wastedDisk) };
  return null;
}

function LedgerRowView({
  row,
  finding,
  selected,
  active,
  onClick,
  sort,
}: {
  row: LedgerRow;
  finding: Finding | undefined;
  selected: boolean;
  /** True for the SINGLE active option (one per listbox). Drives aria-selected so single-select semantics
   *  are exact even on finding-axis sorts where N findings of one asset share one assetRef (and thus one
   *  visual `selected` highlight). The active option is resolved by aria-activedescendant on the container. */
  active: boolean;
  onClick: () => void;
  sort: SortKey;
}) {
  const { t, renderFinding } = useI18n();
  // Synthesized clean rows have no backing finding (findingById misses by design) — render a localized
  // "no issues found" title and NO metric badge (a clean asset has no problem footprint to claim).
  const title = row.clean ? t('triage.cleanAsset') : finding ? renderFinding(finding).title : row.id;
  const badge = row.clean ? null : metricBadge(row, sort);
  return (
    <button
      type="button"
      id={optionId(row.id)}
      role="option"
      // Single-active listbox: aria-selected marks EXACTLY ONE option (the active one) — strict listbox
      // semantics. On finding-axis sorts an asset with N findings yields N rows sharing one assetRef, so the
      // visual `selected` (bg-teal/10) lights all of them (mouse-selection parity, unchanged), but only the
      // active option reports aria-selected=true. The active row also resolves via aria-activedescendant.
      aria-selected={active}
      // A role=option must NOT be a tab stop (buttons default to tabIndex 0); the container is the SOLE tab
      // stop. -1 keeps it clickable + focusable-by-script but out of the Tab order (the listbox pattern).
      tabIndex={-1}
      onClick={onClick}
      title={row.assetRef}
      style={{ height: ROW_H }}
      className={`flex w-full items-center gap-3 border-b border-line px-3 text-left transition ${
        selected ? 'bg-teal/10' : 'bg-panel hover:bg-bg'
      }`}
    >
      {/* STATIC dot — no pulse animation (perf at 1000+ rows). */}
      <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[row.severity]}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-[13px] font-semibold leading-tight text-ink">{title}</div>
        <div className="truncate font-mono text-[10px] leading-tight text-ink-soft">{midTruncate(row.assetRef)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {row.scope === 'folder' && row.relatedRefs.length > 0 ? (
          <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[9px] text-ink-soft">
            {t('triage.relatedRefs', { n: row.relatedRefs.length })}
          </span>
        ) : null}
        <span className={`font-mono text-[9px] uppercase tracking-[0.06em] ${TXT[row.severity]}`}>
          {t(`triage.scope.${row.scope}`)}
        </span>
        {badge ? (
          <span className="w-[68px] text-right">
            <span className="block font-mono text-[8.5px] uppercase tracking-[0.06em] text-ink-soft">{badge.label}</span>
            <span className="block font-mono text-[11px] font-semibold text-ink">{badge.value}</span>
          </span>
        ) : null}
      </div>
    </button>
  );
}

// A flat list of either a real ledger row or a (group-by-folder) header marker — both are ROW_H tall, so the
// windower treats them uniformly. Header items carry their DECLARED-VRAM rollup (sum of member rows' declared
// vram; "—" when none is estimable — invariant 5; folder rows have no per-asset vram so never contribute).
type Item =
  | { kind: 'row'; row: LedgerRow }
  | { kind: 'header'; folder: string; isCabinet: boolean; count: number; declaredVram?: number };

function buildItems(rows: LedgerRow[], grouped: boolean): Item[] {
  if (!grouped) return rows.map((row) => ({ kind: 'row', row }));
  // selectRows already emitted rows group-by-group (Cabinet pinned first, then folders by localeCompare, each
  // internally sorted). Walk it and inject a header item at each folder boundary; backfill its rollup.
  const items: Item[] = [];
  let curFolder: string | null = null;
  let headerIdx = -1;
  let count = 0;
  let vramSum = 0;
  let vramSeen = false;
  const flush = () => {
    if (headerIdx >= 0) {
      const h = items[headerIdx] as Extract<Item, { kind: 'header' }>;
      h.count = count;
      h.declaredVram = vramSeen ? vramSum : undefined;
    }
  };
  for (const row of rows) {
    const isCabinet = row.scope === 'folder';
    const folderKey = isCabinet ? ' cabinet' : row.folder;
    if (folderKey !== curFolder) {
      flush();
      curFolder = folderKey;
      count = 0;
      vramSum = 0;
      vramSeen = false;
      headerIdx = items.length;
      items.push({ kind: 'header', folder: row.folder, isCabinet, count: 0, declaredVram: undefined });
    }
    count += 1;
    if (row.metric.vram !== undefined) {
      vramSum += row.metric.vram;
      vramSeen = true;
    }
    items.push({ kind: 'row', row });
  }
  flush();
  return items;
}

export function TriageLedger({
  index,
  rows,
  findingById,
  selectedAsset,
  opts,
  setSort,
  search,
  setSearch,
  setProblemsOnly,
  setGroupByFolder,
  showClean,
  setShowClean,
  totalRows,
  foldedCount,
  foldOpen,
  setFoldOpen,
  onRowClick,
}: {
  index: TriageIndex;
  /** The already-selected (filtered + sorted + grouped) rows from selectRows. */
  rows: LedgerRow[];
  /** id → Finding, for renderFinding titles. */
  findingById: Map<string, Finding>;
  selectedAsset: string | undefined;
  opts: SelectOpts;
  setSort: (s: SortKey) => void;
  /** Raw (un-debounced) search box value — the box is controlled here; debounce happens in App. */
  search: string;
  setSearch: (s: string) => void;
  setProblemsOnly: (b: boolean) => void;
  setGroupByFolder: (b: boolean) => void;
  /** When true, problemsOnly is forced off so `ok` rows surface (the honest "show clean" path). */
  showClean: boolean;
  setShowClean: (b: boolean) => void;
  /** Total candidate rows under the current severity/clean policy (for "showing N of M"). */
  totalRows: number;
  /** Count of foldable rows (K) within the current post-search `rows` — stated verbatim on the toggle. The
   *  `rows` prop already has them removed while collapsed (App's visibleRows); this K is how many. 0 ⇒ no
   *  toggle (design §5.2). PRESENTATION only — the honest tally lives in the VerdictBar (index.tally). */
  foldedCount: number;
  /** True ⇒ the K folded rows are shown inline (expanded); false ⇒ collapsed. Drives aria-pressed. */
  foldOpen: boolean;
  setFoldOpen: (b: boolean) => void;
  onRowClick: (row: LedgerRow) => void;
}) {
  const { t } = useI18n();
  const grouped = opts.groupByFolder;
  const items = useMemo(() => buildItems(rows, grouped), [rows, grouped]);

  const win = useWindow(items.length, ROW_H, 8);
  const slice = items.slice(win.start, win.end);

  // === Keyboard nav bridge (two index spaces) ===
  // NAV runs over the OPTION space (rows only; headers are role=presentation and never active). SCROLL runs
  // over the ITEM space (rows AND headers, every item uniform ROW_H). optionItemIndexes[optionIdx] = itemIdx
  // bridges them so the scroll target accounts for header rows' ROW_H (no offset drift). Memoized on [items]
  // (same cadence as buildItems) — O(items), never per-keystroke; we NEVER mount extra rows.
  const optionItemIndexes = useMemo(() => {
    const map: number[] = [];
    for (let i = 0; i < items.length; i++) if (items[i]!.kind === 'row') map.push(i);
    return map;
  }, [items]);

  // Active option is DERIVED from selectedAsset (the assetRef string), NOT a separate index state — so the
  // worst-offender auto-select and the orphan-reselect (both key on selectedAsset) already land the active
  // option, and a probe re-set (which changes only metric numbers, never selectedAsset) never yanks it. The
  // FIRST option matching the ref is chosen (deterministic, worst-first); -1 when nothing is selected.
  const activeOption = useMemo(() => {
    if (selectedAsset === undefined) return -1;
    for (let o = 0; o < optionItemIndexes.length; o++) {
      const it = items[optionItemIndexes[o]!] as Extract<Item, { kind: 'row' }>;
      if (it.row.assetRef === selectedAsset) return o;
    }
    return -1;
  }, [items, optionItemIndexes, selectedAsset]);

  const activeId =
    activeOption >= 0
      ? optionId((items[optionItemIndexes[activeOption]!] as Extract<Item, { kind: 'row' }>).row.id)
      : undefined;

  const onListKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const total = optionItemIndexes.length;
      if (total === 0) return;
      // Enter / Space confirm: re-fire onRowClick on the active row (idempotent — arrows already selected it).
      if (e.key === 'Enter' || e.key === ' ') {
        if (activeOption >= 0) {
          e.preventDefault();
          onRowClick((items[optionItemIndexes[activeOption]!] as Extract<Item, { kind: 'row' }>).row);
        }
        return;
      }
      if (!NAV_KEYS.has(e.key)) return; // let everything else bubble (Escape belongs to the search box)
      e.preventDefault(); // handled key ⇒ stop the page from scrolling
      const el = win.ref.current;
      const viewH = el ? el.clientHeight : 0;
      const pageRows = Math.max(1, Math.floor(viewH / ROW_H));
      const nextOpt = nextActiveIndex(activeOption, e.key as NavKey, total, pageRows);
      if (nextOpt < 0) return;
      const nextItem = optionItemIndexes[nextOpt]!;
      // Drive selection + film move through the SAME path the mouse uses (selection follows arrows).
      onRowClick((items[nextItem] as Extract<Item, { kind: 'row' }>).row);
      // If the target is outside the mounted window, set the SAME single scrollTop the windower consumes so
      // it re-slices and mounts it. We assign el.scrollTop directly (INSTANT — never smooth ⇒ reduced-motion
      // safe); that fires onScroll → useWindow's setScrollTop, so we stay consistent without touching useWindow.
      if (el && (nextItem < win.start || nextItem >= win.end)) {
        const top = scrollToActive(nextItem, ROW_H, viewH, el.scrollTop, items.length);
        if (top !== el.scrollTop) el.scrollTop = top;
      }
    },
    [activeOption, items, optionItemIndexes, onRowClick, win.ref, win.start, win.end],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setSearch('');
          }}
          placeholder={t('triage.search')}
          aria-label={t('triage.search')}
          className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-3 py-1.5 font-mono text-xs text-ink placeholder:text-ink-soft focus:border-teal focus:outline-none"
        />
        <select
          aria-label={t('triage.sort.label')}
          value={opts.sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded-lg border border-line bg-panel px-2 py-1.5 font-mono text-xs text-ink-soft transition hover:border-teal focus:border-teal focus:outline-none"
        >
          {SORT_KEYS.map((k) => (
            <option key={k} value={k}>
              {t(`triage.sort.${k}`)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 font-mono text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={grouped}
            onChange={(e) => setGroupByFolder(e.target.checked)}
            className="accent-teal"
          />
          {t('triage.group')}
        </label>
        <label className="flex items-center gap-1.5 font-mono text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={opts.problemsOnly}
            onChange={(e) => {
              setProblemsOnly(e.target.checked);
              if (e.target.checked) setShowClean(false);
            }}
            className="accent-teal"
          />
          {t('triage.problemsOnly')}
        </label>
        {index.cleanAssetCount > 0 ? (
          <button
            type="button"
            aria-pressed={showClean}
            onClick={() => {
              const next = !showClean;
              setShowClean(next);
              if (next) setProblemsOnly(false);
            }}
            className={`rounded-lg border px-2.5 py-1 font-mono text-xs transition ${
              showClean ? 'border-teal text-ink' : 'border-line text-ink-soft hover:border-ink-soft'
            }`}
          >
            {t('triage.showClean', { n: index.cleanAssetCount })}
          </button>
        ) : null}
        {/* Honest spam-collapse toggle (design §5.2 / invariant 3) — sits OUTSIDE the role=listbox below, so the
            listbox's sole-tab-stop + single-active aria-activedescendant model is untouched (mirrors showClean).
            The K folded rows are never deleted: they stay in index.rows and reappear inline in ONE click here.
            aria-pressed announces the collapsed/expanded state; K (foldedCount) is stated verbatim. Hidden when
            nothing folds (foldedCount===0) ⇒ zero visible effect ⇒ byte-identical to before. */}
        {foldedCount > 0 ? (
          <button
            type="button"
            aria-pressed={foldOpen}
            onClick={() => setFoldOpen(!foldOpen)}
            className={`rounded-lg border px-2.5 py-1 font-mono text-xs transition ${
              foldOpen ? 'border-teal text-ink' : 'border-line text-ink-soft hover:border-ink-soft'
            }`}
          >
            {foldOpen ? t('triage.foldHide', { n: foldedCount }) : t('triage.foldShow', { n: foldedCount })}
          </button>
        ) : null}
      </div>

      <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-soft">
        {t('triage.showing', { n: rows.length, m: totalRows })}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-line bg-panel p-4 font-mono text-sm text-ink-soft">{t('triage.noMatch')}</p>
      ) : (
        <div
          ref={win.ref}
          onScroll={win.onScroll}
          role="listbox"
          aria-label={t('triage.listLabel')}
          tabIndex={0}
          aria-activedescendant={activeId}
          onKeyDown={onListKeyDown}
          className="overflow-auto rounded-xl border border-line bg-panel"
          style={{ maxHeight: '70vh' }}
        >
          {/* Inner spacer of the full virtual height; the visible slice is offset by padTop. */}
          <div style={{ height: win.totalH }}>
            <div style={{ transform: `translateY(${win.padTop}px)` }}>
              {slice.map((it) =>
                it.kind === 'header' ? (
                  <div
                    key={`h:${it.isCabinet ? ' cab' : it.folder}`}
                    role="presentation"
                    style={{ height: ROW_H }}
                    className="flex items-center justify-between gap-2 border-b border-line bg-bg px-3"
                  >
                    <span className="truncate font-mono text-[10px] uppercase tracking-[0.06em] text-teal">
                      {it.isCabinet ? t('triage.cabinetIssues') : it.folder === '' ? '/' : `${it.folder}/`} · {it.count}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-ink-soft">
                      VRAM {it.declaredVram === undefined ? '—' : fmtBytes(it.declaredVram)}
                    </span>
                  </div>
                ) : (
                  <LedgerRowView
                    key={it.row.id}
                    row={it.row}
                    finding={findingById.get(it.row.id)}
                    selected={it.row.assetRef === selectedAsset}
                    // aria-selected rides the SINGLE active option (activeId resolves exactly one), not the
                    // assetRef match — so N same-ref rows no longer all report aria-selected=true.
                    active={activeId !== undefined && optionId(it.row.id) === activeId}
                    onClick={() => onRowClick(it.row)}
                    sort={opts.sort}
                  />
                ),
              )}
            </div>
          </div>
        </div>
      )}
      {isAssetAxis(opts.sort) ? (
        <p className="font-mono text-[10px] leading-relaxed text-ink-soft/80">
          {t('triage.sort.label')}: {t(`triage.sort.${opts.sort}`)}
        </p>
      ) : null}
    </div>
  );
}
