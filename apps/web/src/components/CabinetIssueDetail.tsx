// Detail card for a selected FOLDER ("cabinet") finding — the per-sprite drill-down. Folder findings span
// many assets and are excluded from the per-asset Findings panel, so this is the ONLY place their body +
// the concrete affected files show. A THIN renderer over the Node-tested lib/cabinet-detail resolver:
// severity + localized title/detail/fix (renderFinding — same as Findings.tsx) plus a COLLAPSED-by-default
// disclosure listing every measured `relatedRefs` file (anti-spam: the count summarizes, the list expands on
// demand — never a wall of names). HONESTY (invariant 3): renders the real finding + its real membership;
// invents nothing, touches no estimate/total.

import type { Finding } from '@asset-doctor/core';
import { useI18n } from '../lib/i18n';
import { severityLabelClass } from '../lib/severity-style';
import { DOT } from './Findings';
import { affectedRows } from '../lib/cabinet-detail';

export function CabinetIssueDetail({ finding, onSelectFile }: { finding: Finding; onSelectFile?: (ref: string) => void }) {
  const { t, renderFinding } = useI18n();
  const r = renderFinding(finding);
  // Rows come WORST-FIRST when the rule measured a per-ref value (Finding.perRef, P2) — each row then
  // carries its formatted measured value; otherwise the name-only alphabetical fallback.
  const files = affectedRows(finding);
  const hasValues = files.some((f) => f.valueText !== undefined);
  return (
    <div className="ad-reveal rounded-2xl border border-line bg-panel p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${DOT[finding.severity]}`} />
        <span className={`ad-label ${severityLabelClass(finding.severity)}`}>{t(`severity.${finding.severity}`)}</span>
      </div>
      <h3 className="font-display text-[15px] font-semibold leading-snug text-ink">{r.title}</h3>
      <p className="mt-1 text-[13px] leading-snug text-ink-soft">{r.detail}</p>
      {r.fix ? <p className="mt-2 font-mono text-xs text-teal-text">→ {r.fix}</p> : null}
      {files.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer select-none font-mono text-xs text-ink-soft hover:text-ink">
            {t('cabinet.affectedFiles', { n: files.length })}
          </summary>
          {/* Value-meaning line (P2): names what the per-row number IS for this rule (fringe share /
              occupancy / measured bytes) — shown only when rows actually carry values. The dynamic key is
              drift-guarded against CABINET_VALUE_RULES in cabinet-detail.test.ts. */}
          {hasValues ? (
            <p className="mt-1.5 font-mono text-[10px] text-ink-soft">{t(`cabinet.value.${finding.rule}`)}</p>
          ) : null}
          {/* Each affected file jumps the film to THAT sprite (setSelectedAsset) so the user can inspect
              every member in place; the folder-issue card persists (selectedFinding stays this finding).
              Real <button>s (keyboard-accessible); the folder detail is unaffected. Plain <li> when no
              handler is wired (e.g. a non-interactive/test context). */}
          <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto font-mono text-[11px] text-ink-soft">
            {files.map(({ ref, valueText }) => {
              const row = (
                <span className="flex w-full items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate">{ref}</span>
                  {valueText !== undefined ? <span className="shrink-0 tabular-nums text-ink">{valueText}</span> : null}
                </span>
              );
              return onSelectFile ? (
                <li key={ref}>
                  <button
                    type="button"
                    onClick={() => onSelectFile(ref)}
                    title={ref}
                    className="block w-full text-left hover:text-teal-text"
                  >
                    {row}
                  </button>
                </li>
              ) : (
                <li key={ref} title={ref}>
                  {row}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
