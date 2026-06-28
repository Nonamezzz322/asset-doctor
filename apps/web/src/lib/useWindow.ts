// Zero-dep fixed-height list windowing — keeps ~25-35 DOM rows mounted regardless of total count, so the
// triage ledger stays responsive at 1000+ assets (invariant 4 — instant-wow). No virtualization library:
// fixed-height rows make the slice math trivially correct and house style is zero-dep (ResizeObserver is a
// Web API, not a dependency). The pure slice math is split out (windowSlice) so it is unit-tested without
// a DOM.

import { useEffect, useRef, useState, type RefObject, type UIEvent } from 'react';

export interface WindowSlice {
  /** First row index to render (inclusive). */
  start: number;
  /** One past the last row index to render (exclusive). */
  end: number;
  /** Top spacer height (px) so the rendered slice sits at its true scroll offset. */
  padTop: number;
  /** Full scrollable height (px) = total × rowH — the inner spacer's height. */
  totalH: number;
}

/** PURE windowing math. Given the scroll position, viewport height, row height and overscan, return the
 *  visible slice [start, end) plus the spacer heights. Clamped to [0, total]; safe for rowH ≤ 0 (degrades
 *  to rendering everything) and a zero-height viewport (renders only the overscan band). */
export function windowSlice(
  total: number,
  rowH: number,
  scrollTop: number,
  viewH: number,
  overscan = 6,
): WindowSlice {
  if (total <= 0) return { start: 0, end: 0, padTop: 0, totalH: 0 };
  if (rowH <= 0) return { start: 0, end: total, padTop: 0, totalH: 0 };
  const top = Math.max(0, scrollTop);
  const end = Math.min(total, Math.ceil((top + Math.max(0, viewH)) / rowH) + overscan);
  // Clamp start into [0, end] so an over-scroll (scrollTop past the list height) yields an empty slice,
  // never start > end. padTop tracks the clamped start so the spacer math stays consistent.
  const start = Math.min(end, Math.max(0, Math.floor(top / rowH) - overscan));
  return { start, end, padTop: start * rowH, totalH: total * rowH };
}

export interface WindowState extends WindowSlice {
  /** Attach to the scroll container (fixed height, overflow-auto). */
  ref: RefObject<HTMLDivElement | null>;
  /** Wire to the container's onScroll. */
  onScroll: (e: UIEvent<HTMLDivElement>) => void;
}

/** React windowing hook over a fixed-height list. Tracks scrollTop + the container's measured height
 *  (via ResizeObserver) and returns the current slice. Render: container(ref,onScroll, fixed height) →
 *  inner spacer of `totalH` → slice translated by `translateY(padTop)`. */
export function useWindow(total: number, rowH: number, overscan = 6): WindowState {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setViewH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const slice = windowSlice(total, rowH, scrollTop, viewH, overscan);
  return {
    ...slice,
    ref,
    onScroll: (e) => setScrollTop(e.currentTarget.scrollTop),
  };
}
