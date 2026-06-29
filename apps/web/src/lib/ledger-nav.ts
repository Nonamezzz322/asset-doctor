// PURE keyboard-navigation math for the virtualized triage ledger (no React, no DOM, worker-safe). The
// TriageLedger only ever mounts ~25-35 rows (useWindow); without keyboard primitives a keyboard / screen-
// reader user can reach only those mounted rows — the other ~965 of a 1000-row report are absent from the
// DOM and unreachable (WCAG 2.1.1). These two functions are the testable arithmetic behind the listbox +
// aria-activedescendant pattern: nextActiveIndex moves the active OPTION; scrollToActive returns the single
// scrollTop the EXISTING windower consumes so the active row re-mounts. Both are split out (mirroring
// windowSlice) so they are unit-tested without a DOM. The React glue in TriageLedger is a thin pass-through.
//
// Two index spaces (load-bearing — see TriageLedger glue): NAV math (nextActiveIndex) runs over the OPTION
// space (rows only; group headers are role=presentation and are NOT options). SCROLL math (scrollToActive)
// runs over the ITEM space (rows AND headers, every item uniform ROW_H). The component bridges them with an
// option→item index map so the scroll target accounts for header height (no offset drift).

export type NavKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown';

/** PURE reducer over the OPTION space. Given the current active option index, a nav key, the total option
 *  count and how many rows fit a page, return the next active index clamped to [0, total). Arrow nav does
 *  NOT wrap (predictable + matches the APG listbox pattern) — it clamps at the ends.
 *
 *  Edges:
 *   - total <= 0 ⇒ -1 (no active option; the listbox is not even mounted at 0 rows, this is defensive).
 *   - current < 0 (nothing active yet): ArrowDown/Home ⇒ 0 (top/worst), ArrowUp/End ⇒ total-1 (bottom).
 *   - pageRows <= 0 is treated as 1 (a degenerate viewport still steps one row per Page key).
 */
export function nextActiveIndex(current: number, key: NavKey, total: number, pageRows: number): number {
  if (total <= 0) return -1;
  const last = total - 1;
  const clamp = (i: number): number => Math.max(0, Math.min(last, i));
  const page = Math.max(1, pageRows);
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : clamp(current + 1);
    case 'ArrowUp':
      return current < 0 ? last : clamp(current - 1);
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'PageDown':
      return clamp((current < 0 ? page - 1 : current + page));
    case 'PageUp':
      return clamp((current < 0 ? 0 : current - page));
  }
}

/** PURE. The scrollTop needed so ITEM `target` is inside the mounted window. Mirrors windowSlice math (no
 *  DOM): if the target is already within the visible band return the CURRENT scrollTop unchanged (no jump on
 *  in-window moves); else align the target to the top (scroll up) or bottom (scroll down) edge. The result is
 *  clamped to [0, max(0, total*rowH - viewH)]. The CALLER assigns this number to el.scrollTop INSTANTLY
 *  (never smooth) — so this is automatically reduced-motion safe.
 *
 *  Degrade-safe: rowH <= 0 || total <= 0 || target < 0 ⇒ return the (clamped) current scrollTop, no NaN.
 */
export function scrollToActive(
  target: number,
  rowH: number,
  viewH: number,
  currentScrollTop: number,
  total: number,
): number {
  const maxScroll = Math.max(0, total * rowH - viewH);
  const clamp = (n: number): number => Math.max(0, Math.min(maxScroll, n));
  if (rowH <= 0 || total <= 0 || target < 0) return clamp(currentScrollTop);
  const top = Math.max(0, currentScrollTop);
  const visTop = Math.floor(top / rowH);
  const visBottomExclusive = Math.ceil((top + Math.max(0, viewH)) / rowH);
  if (target >= visTop && target < visBottomExclusive) return clamp(currentScrollTop); // already visible, no jump
  if (target < visTop) return clamp(target * rowH); // align to top
  return clamp(target * rowH - viewH + rowH); // align to bottom
}
