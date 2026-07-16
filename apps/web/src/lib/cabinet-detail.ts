// PURE resolver for the "cabinet issue" detail surface (the per-sprite drill-down for FOLDER findings).
// apps/web has NO React harness, so the load-bearing decision — WHICH finding, if any, the selected ledger
// row opens a folder-issue detail for — lives here and is Node-tested; CabinetIssueDetail.tsx is a thin
// renderer over it.
//
// WHY this surface exists: folder-scoped findings (premultiplied-alpha, gpu-compression-alignment,
// duplicate-similar, should-atlas, atlas-merge, format-aggregate, integrity…) are DELIBERATELY excluded from
// the per-asset Findings panel (App.tsx assetFindings filters `scope !== 'folder'`) because a folder finding
// spans many assets and is not one asset's footprint. Before this, they appeared ONLY as a compact ledger-row
// title — their `relatedRefs` (the concrete affected files the analysis measured) were never shown, so the
// user could see THAT a folder issue exists but never WHICH sprites it covers. This resolver + its card give
// them an honest, on-demand detail with the full affected-file list (collapsed by default — no wall of names).
//
// HONESTY (invariant 3): invents nothing. It only selects an existing Finding by id; the card renders that
// finding's real localized body + its real measured `relatedRefs`. No estimate, no total, is touched.

import type { Finding } from '@asset-doctor/core';

/** The folder-scoped ("cabinet") finding the currently-selected ledger row refers to, or null when the
 *  selection is an asset finding, a synthesized clean row (`ok:<ref>` — no backing finding), or nothing.
 *  `findings` is the report's full finding list (folder findings included, unlike the per-asset panel). */
export function cabinetDetailFinding(selectedId: string | undefined, findings: readonly Finding[]): Finding | null {
  if (!selectedId) return null;
  const f = findings.find((x) => x.id === selectedId);
  return f && f.scope === 'folder' ? f : null;
}

/** The concrete files a folder finding spans — the measured membership the analysis put on `relatedRefs`
 *  (already deterministically sorted by the rule). [] when a finding carries none (the card then omits the
 *  drill-down entirely rather than showing an empty "0 files" disclosure). */
export function affectedFiles(finding: Finding): string[] {
  return finding.relatedRefs ?? [];
}

/** One drill-down row: the ref + (when the rule measured one) its per-ref value, pre-formatted. */
export interface AffectedRow {
  ref: string;
  /** Locale-neutral short value text ('88%', '1.2 MB') — present ONLY when the finding carries a perRef
   *  breakdown AND the rule has a registered formatter. Absent ⇒ a name-only row (pre-P2 behavior). */
  valueText?: string;
}

/** Rules whose perRef VALUE the drill-down knows how to format + label. The i18n label key is
 *  `cabinet.value.<rule>` — asserted to exist in en for every entry (drift test), because the JSX reads it
 *  via a template over this map (the static app-keys scanner cannot expand an unregistered prefix). */
export const CABINET_VALUE_RULES = ['premultiplied-alpha', 'atlas-merge', 'format', 'strippable-metadata'] as const;

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const bytes = (v: number): string =>
  v < 1024 ? `${v} B` : v < 1024 * 1024 ? `${(v / 1024).toFixed(1)} KB` : `${(v / 1024 / 1024).toFixed(1)} MB`;

/** Format a perRef value for a rule — fraction rules render a percentage, byte rules render fmtBytes-style
 *  units (the SAME format the analysis copy uses). null for a rule with no registered value semantics
 *  (its rows render name-only; we never guess a unit — invariant 3). */
export function perRefValueText(rule: Finding['rule'], value: number): string | null {
  switch (rule) {
    case 'premultiplied-alpha': // fringe fraction 0..1 — highest = most premultiplied-shaped
    case 'atlas-merge': // occupancy 0..1 — lowest = emptiest sheet
      return pct(value);
    case 'format': // the folder format-aggregate carries rule 'format' — measured saved bytes per image
    case 'strippable-metadata': // aggregate — exact strippable bytes per image
      return bytes(value);
    default:
      return null;
  }
}

/** The drill-down rows for a folder finding: the rule's WORST-FIRST perRef breakdown (with formatted
 *  values) when it carries one, else the name-only relatedRefs (pre-P2 fallback, alphabetical). */
export function affectedRows(finding: Finding): AffectedRow[] {
  if (finding.perRef && finding.perRef.length > 0) {
    return finding.perRef.map((p) => {
      const valueText = perRefValueText(finding.rule, p.value);
      return valueText !== null ? { ref: p.ref, valueText } : { ref: p.ref };
    });
  }
  return affectedFiles(finding).map((ref) => ({ ref }));
}
