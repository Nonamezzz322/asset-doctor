// P6 local audit history strip — a THIN renderer over the pure lib (audit-history.ts historyRows +
// @asset-doctor/budget diffAudits computed in App). Shows, for a re-audit of the same-NAMED folder, the
// measured metric deltas (non-flat headline metrics only) + the added/resolved/changed finding counts vs
// the stored previous snapshot. HONESTY: the folder NAME is the only cross-session identity a browser
// gives us, so the lead line says "previous audit of this folder name" — a hedge, never an asserted
// same-folder claim; every number is a measured delta from the CLI's own diff core, disk and VRAM stay
// separate rows (invariant 5), and a no-change re-audit says so instead of inventing movement.

import type { AuditDiff } from '@asset-doctor/budget';
import { useI18n } from '../lib/i18n';
import { fmtBytes } from '../lib/format';
import { historyRows } from '../lib/audit-history';

function deltaText(bytes: boolean, v: number): string {
  const sign = v > 0 ? '+' : '−';
  return sign + (bytes ? fmtBytes(Math.abs(v)) : `${Math.abs(v)}`);
}

export function HistoryStrip({ diff, at }: { diff: AuditDiff; at: number }) {
  const { t, locale } = useI18n();
  const rows = historyRows(diff);
  const { added, resolved, changed } = diff.counts;
  const noChange = rows.length === 0 && added === 0 && resolved === 0 && changed === 0;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  return (
    <section aria-label={t('history.title')} className="rounded-2xl border border-line bg-panel p-4">
      <p className="ad-label text-ink-soft">{t('history.title')}</p>
      <p className="mt-1 font-mono text-[11px] text-ink-soft">{t('history.vs', { date })}</p>
      {noChange ? (
        <p className="mt-2 font-mono text-sm text-ink">{t('history.noChange')}</p>
      ) : (
        <>
          {rows.length > 0 ? (
            <ul className="mt-2 space-y-0.5 font-mono text-[13px]">
              {rows.map((r) => (
                <li key={r.key} className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-ink-soft">{t(r.labelKey)}</span>
                  <span className="shrink-0 tabular-nums text-ink">
                    {r.bytes ? fmtBytes(r.before) : r.before} → {r.bytes ? fmtBytes(r.after) : r.after}
                  </span>
                  <span className="shrink-0 tabular-nums text-ink-soft">({deltaText(r.bytes, r.delta)})</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 font-mono text-[11px] text-ink-soft">
            {t('history.counts', { added, resolved, changed })}
          </p>
        </>
      )}
    </section>
  );
}
