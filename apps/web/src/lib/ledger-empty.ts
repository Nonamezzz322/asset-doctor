// PURE empty-ledger classification + card model (no React, no DOM — Node-testable; precedent:
// results-heading.ts / announce.ts). HONESTY: problems = crit+warn+info — IDENTICAL to
// VerdictBar.tsx / announce.ts / results-heading.ts — never tally.ok / cleanAssetCount, so an ok/clean
// asset is never double-claimed as a problem. Every number surfaced here is already on screen elsewhere
// (index.tally / index.cleanAssetCount / totalRows), only ranked into the honest cause of an empty ledger.

import type { Severity } from '@asset-doctor/core';
import type { T } from '@asset-doctor/i18n';
import type { TriageIndex } from './triage';

export type EmptyLedgerReason =
  | { kind: 'clean'; cleanCount: number } // zero problems in the report
  | { kind: 'filtered'; hiddenCount: number } // problems exist; severity filter hides all
  | { kind: 'type-filtered'; hiddenCount: number } // problems exist; the user's finding-TYPE filter hides all
  | { kind: 'search'; query: string }; // candidates exist; search hides all

/** Classify WHY the ledger is empty. Total (callable every render): returns null when rows exist, so the
 *  component can render it unconditionally. `search` MUST be opts.search (the DEBOUNCED value that produced
 *  `rowCount`), never the raw box value — §1.4. Classification is fully determined by (problems, totalRows,
 *  rowCount): totalRows===0 with problems>0 can ONLY be the severity filter (problemsOnly hides only `ok`
 *  rows, which exist solely under includeClean, forced off whenever showClean is on), so no Set is needed. */
export function emptyLedgerReason(
  tally: TriageIndex['tally'],
  rowCount: number,
  totalRows: number,
  cleanAssetCount: number,
  search: string,
  hiddenByType = 0,
): EmptyLedgerReason | null {
  if (rowCount > 0) return null;
  const problems = tally.crit + tally.warn + tally.info; // same formula as VerdictBar/announce
  if (totalRows === 0) {
    // totalRows===0 ⇒ ALL problems are hidden. Attribute the cause the user can ACT on: if clearing the
    // finding-type filter would reveal rows (hiddenByType>0) it is the type filter (an off-screen #settings
    // control ⇒ the card must name it); otherwise it is the severity filter (today's behavior). hiddenByType
    // is >0 only when the type set is non-empty, so an untouched run never reaches this branch (byte-identity).
    if (problems === 0) return { kind: 'clean', cleanCount: cleanAssetCount };
    if (hiddenByType > 0) return { kind: 'type-filtered', hiddenCount: hiddenByType };
    return { kind: 'filtered', hiddenCount: problems };
  }
  // rowCount===0 && totalRows>0 ⇒ search non-empty BY CONSTRUCTION: countCandidates ≡
  // selectRows(...,{search:''}).length (triage.ts), and selectRows trims the needle — a blank search cannot
  // produce this state. No defensive branch. (The spritesheet fold is handled by the caller, not here — a
  // fold-emptied list is neither clean/filtered/search, so the component suppresses the card there.)
  return { kind: 'search', query: search.trim() };
}

/** i18n key+params chosen PURELY so the choice is Node-testable with a fake translator. Literal key strings
 *  (a switch, no template interpolation) so i18n-app-keys' staticKeys regex scans them. */
export interface EmptyLedgerCard {
  kind: EmptyLedgerReason['kind'];
  title: string;
  body?: string;
  /** Label for the single action button; undefined ⇒ no button (clean card with 0 clean assets). */
  action?: string;
  /** true ⇒ suppress the "showing N of M" line (totalRows===0 ⇒ "showing 0 of 0" is pure noise). */
  hideCounts: boolean;
}

export function emptyLedgerCard(r: EmptyLedgerReason, t: T): EmptyLedgerCard {
  switch (r.kind) {
    case 'clean':
      return {
        kind: 'clean',
        title: t('triage.empty.clean.title'),
        body: t('triage.empty.clean.body', { n: r.cleanCount }),
        // Reuses the toolbar toggle's EXACT label — same action, same accessible name (consistency, not
        // duplication). No button when cleanCount===0 (defensive; unreachable via App's noAssets branch).
        ...(r.cleanCount > 0 ? { action: t('triage.showClean', { n: r.cleanCount }) } : {}),
        hideCounts: true,
      };
    case 'filtered':
      return {
        kind: 'filtered',
        title: t('triage.empty.filtered.title'),
        body: t('triage.empty.filtered.body', { n: r.hiddenCount }),
        action: t('triage.empty.filtered.action'),
        hideCounts: true,
      };
    case 'type-filtered':
      return {
        kind: 'type-filtered',
        title: t('triage.empty.typeFiltered.title'),
        body: t('triage.empty.typeFiltered.body', { n: r.hiddenCount }),
        // Reuses the ledger H-line's EXACT "show all types" label — same one-click reset, same accessible
        // name (consistency, not duplication).
        action: t('triage.typeHidden.clear'),
        hideCounts: true,
      };
    case 'search':
      return {
        kind: 'search',
        title: t('triage.empty.search.title', { q: r.query }),
        action: t('triage.empty.search.action'),
        hideCounts: false, // "showing 0 of M" is INFORMATIVE here — keep it
      };
  }
}

/** The showClean wiring fix (§1.3): the severity set selectRows actually receives. Never mutates the input;
 *  adds 'ok' ONLY while showClean is on, so the synthesized clean rows survive the severity filter. Returns a
 *  fresh Set (never aliases the state Set) so toggling can never mutate the stored severityFilter. */
export function effectiveSeverityFilter(severityFilter: ReadonlySet<Severity>, showClean: boolean): Set<Severity> {
  const s = new Set(severityFilter);
  if (showClean) s.add('ok');
  return s;
}
