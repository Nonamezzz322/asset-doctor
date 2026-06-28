// Trailing-edge debounce hook. Used to coalesce rapid changes (search keystrokes, row-scrubbing
// selection) into ONE downstream update after the input settles — so the film decode and the
// filter/sort memos don't run on every keystroke or arrow-key tick (invariant 4 — stay responsive at
// 1000+ assets). Returns the latest `value` only after `ms` of quiet; ms ≤ 0 passes through unchanged.

import { useEffect, useState } from 'react';

export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (ms <= 0) {
      setDebounced(value);
      return;
    }
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}
