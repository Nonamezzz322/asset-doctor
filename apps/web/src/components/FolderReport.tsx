import type { Finding } from '@asset-doctor/core';
import { SEVERITY_RING, SEVERITY_TEXT } from '../lib/format';
import { useI18n } from '../lib/i18n';

// Whole-folder findings (duplicates, should-atlas, atlas-merge, integrity, format aggregate).
// Each lists the assets it spans; clicking one jumps the viewer to that asset.
export function FolderReport({
  findings,
  onPick,
}: {
  findings: Finding[];
  onPick: (assetRef: string) => void;
}) {
  const { t, renderFinding } = useI18n();
  if (findings.length === 0) return null;
  return (
    <section className="rounded-lg border border-line bg-panel p-4">
      <div className="flex items-baseline gap-2">
        <h2 className="font-display text-lg font-semibold">{t('folder.title')}</h2>
        <span className="font-mono text-xs text-ink-soft">{t('folder.issues', { n: findings.length })}</span>
      </div>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {findings.map((f) => {
          const r = renderFinding(f);
          return (
            <li key={f.id} className="rounded-md border border-line p-3">
              <div className="flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ring-1 ${SEVERITY_TEXT[f.severity]} ${SEVERITY_RING[f.severity]}`}
                >
                  {t(`severity.${f.severity}`)}
                </span>
                <span className="font-mono text-sm text-ink">{r.title}</span>
              </div>
              <p className="mt-1 text-xs text-ink-soft">{r.detail}</p>
              {r.fix ? <p className="mt-1 font-mono text-xs text-teal">→ {r.fix}</p> : null}
              {f.relatedRefs && f.relatedRefs.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {f.relatedRefs.map((ref) => (
                    <button
                      key={ref}
                      type="button"
                      onClick={() => onPick(ref)}
                      className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-soft hover:border-teal"
                    >
                      {ref}
                    </button>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
