import type { Severity } from '@asset-doctor/core';

/** Human byte sizes for the readout. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Signed byte delta for the declared-vs-measured line: "+1.2 MB" / "−0.4 MB" / "0 B".
 *  Sign is explicit so the reader sees a directional gap between two measurement methods,
 *  not a magnitude saving (Invariant 5 — never present the delta as a saving). Reuses fmtBytes
 *  for the magnitude; uses U+2212 (true minus) for negatives. */
export function fmtSignedBytes(delta: number): string {
  if (!Number.isFinite(delta)) return '—';
  if (delta === 0) return fmtBytes(0);
  return `${delta > 0 ? '+' : '−'}${fmtBytes(Math.abs(delta))}`;
}

export const SEVERITY_TEXT: Record<Severity, string> = {
  crit: 'text-crit',
  warn: 'text-warn',
  ok: 'text-ok',
  info: 'text-info',
};

export const SEVERITY_RING: Record<Severity, string> = {
  crit: 'ring-crit/50',
  warn: 'ring-warn/50',
  ok: 'ring-ok/50',
  info: 'ring-info/50',
};
