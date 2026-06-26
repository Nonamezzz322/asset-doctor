import type { Finding } from '@asset-doctor/core';
import { useI18n } from '../lib/i18n';
import { DOT, TXT } from './Findings';

// Whole-folder findings (duplicates, should-atlas, atlas-merge, integrity, format aggregate) — shown
// as a hairline grid of cards. Each lists the assets it spans; clicking one jumps the viewer there.
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
    <section className="ad-reveal rounded-2xl border border-line bg-panel p-6">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="font-display text-lg font-semibold text-ink">{t('folder.title')}</h2>
        <span className="font-mono text-xs text-ink-soft">{t('folder.issues', { n: findings.length })}</span>
      </div>
      <ul className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
        {findings.map((f) => {
          const r = renderFinding(f);
          return (
            <li key={f.id} className="bg-panel p-5">
              <div className="mb-2.5 flex items-center gap-2">
                <span className={`ad-pulse-dot h-[9px] w-[9px] rounded-full ${DOT[f.severity]}`} />
                <span className={`font-mono text-[10px] uppercase tracking-[0.06em] ${TXT[f.severity]}`}>{t(`severity.${f.severity}`)}</span>
              </div>
              <h3 className="font-display text-[17px] font-semibold leading-tight text-ink">{r.title}</h3>
              <p className="mt-1.5 text-[13.5px] leading-snug text-ink-soft">{r.detail}</p>
              {r.fix ? <p className="mt-2 font-mono text-xs text-teal">→ {r.fix}</p> : null}
              {f.relatedRefs && f.relatedRefs.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1">
                  {f.relatedRefs.map((ref) => (
                    <button
                      key={ref}
                      type="button"
                      onClick={() => onPick(ref)}
                      className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-soft transition hover:border-teal hover:text-teal"
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
