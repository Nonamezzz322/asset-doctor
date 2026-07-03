import type { Severity } from '@asset-doctor/core';

// The AA-safe class for any severity/state WORD (the severity label OR the "all clear" text) that sits
// beside a colored dot on a LIGHT surface (bg / bg-panel). The dot carries the hue (WCAG 1.4.1); the
// WORD must be ink — the severity/state is ALSO named in literal text, so ink loses no information.
// text-ink #16202A = 16.48:1 panel / 13.87:1 bg (AAA). The failing hues (text-crit/warn/ok/info,
// 2.77–3.91:1) must NEVER carry this text. Precedent: the skipped chip (VerdictBar.tsx:81-89).
export const SEVERITY_LABEL_CLASS = 'text-ink' as const;

// Optional `sev` is accepted so call sites read naturally and a future per-severity divergence has a
// home; it is intentionally ignored today — the hue lives on the dot, never the word. (`void sev`
// documents the deliberate no-op and keeps it lint-clean under the repo's after-used unused-args rule.)
export function severityLabelClass(sev?: Severity): typeof SEVERITY_LABEL_CLASS {
  void sev;
  return SEVERITY_LABEL_CLASS;
}
