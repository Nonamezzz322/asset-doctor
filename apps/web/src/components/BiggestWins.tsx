import { useI18n } from '../lib/i18n';
import { fmtBytes } from '../lib/format';
import { DOT } from './Findings';
import type { BiggestWins as Wins, WinRow } from '../lib/biggest-wins';

// The impact-first "biggest wins" panel — a glanceable "start here" for the results view. Sits after the
// VerdictBar; rendered ONLY when at least one axis has a rankable win (hasWins), so a report with no
// estimate-bearing finding leaves the results DOM byte-identical to before.
//
// HONESTY (invariants 3 & 5): every number is `fmtBytes(row.bytes)` where `row.bytes` came straight off a
// finding's measured `estimate` (see biggest-wins.ts) — nothing derived. Disk and VRAM are TWO SEPARATE
// single-unit lists (never a combined score). There is NO total in this panel: the per-item wins may overlap
// (two findings on related assets each claim their own reclaim), so they must not be read as a sum — the
// honest dedup-aware disk total lives in the budget strip's `potentialDiskSaved`. Clicking a row selects that
// finding (same state onRowClick sets), jumping the film + detail column to it.

function WinList({
  label,
  rows,
  onSelect,
}: {
  label: string;
  rows: WinRow[];
  onSelect: (assetRef: string, id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-soft">{label}</p>
      <ul className="mt-1.5 space-y-1">
        {rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onSelect(r.assetRef, r.id)}
              className="flex w-full items-center gap-2 rounded-lg border border-line bg-bg px-2.5 py-1.5 text-left transition hover:border-teal focus-visible:border-teal"
            >
              <span className={`ad-pulse-dot h-2 w-2 shrink-0 rounded-full ${DOT[r.severity]}`} />
              <span className="truncate font-mono text-[12px] text-ink">{r.assetRef}</span>
              {r.relatedCount > 0 ? (
                <span className="shrink-0 font-mono text-[11px] text-ink-soft">
                  {t('wins.span', { n: r.relatedCount })}
                </span>
              ) : null}
              <span className="ml-auto shrink-0 font-mono text-[12px] font-semibold text-teal-text">
                {fmtBytes(r.bytes)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BiggestWins({
  wins,
  onSelect,
}: {
  wins: Wins;
  onSelect: (assetRef: string, id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <section aria-labelledby="ad-wins-h" className="rounded-2xl border border-line bg-panel p-4">
      <h2 id="ad-wins-h" className="font-display text-base font-semibold text-ink">
        {t('wins.title')}
      </h2>
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        {wins.disk.length > 0 ? (
          <WinList label={t('wins.disk')} rows={wins.disk} onSelect={onSelect} />
        ) : null}
        {wins.vram.length > 0 ? (
          <WinList label={t('wins.vram')} rows={wins.vram} onSelect={onSelect} />
        ) : null}
      </div>
    </section>
  );
}
