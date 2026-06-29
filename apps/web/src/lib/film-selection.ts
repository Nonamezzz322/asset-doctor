/** Decision for App.tsx's selected-film re-read effect (Round 21 #2). PURE so the load-bearing
 *  "never blank on a live re-selection" rule is Node-testable — apps/web has NO React test harness
 *  (vitest runs env=node, no jsdom/testing-library), the same discipline transcode-guard / sheet-diff rely
 *  on. The effect is a thin dispatcher over this. 'clear' ⇒ honest no-image (no selection, or no reader for
 *  the selection — folder moved/deleted or a legacy producer with no `file`); 'read' ⇒ keep the PRIOR film
 *  mounted and swap when the new bytes resolve (no flicker between two valid films). Round 24 reviewer-MINOR.
 *
 *  Total function over two booleans ⇒ no data determinism involved; mount-timing only. */
export function filmSelectionAction(hasSelection: boolean, hasReader: boolean): 'clear' | 'read' {
  if (!hasSelection) return 'clear'; // no selection → genuine empty state
  if (!hasReader) return 'clear'; // selection present but no reader → honest no-image, never a fabricated film
  return 'read'; // keep the prior film, swap on resolve — never blank between two valid selections
}
