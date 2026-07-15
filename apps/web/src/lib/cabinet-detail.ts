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
