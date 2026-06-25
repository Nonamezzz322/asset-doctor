import type { Severity } from '@asset-doctor/core';

/** Human byte sizes for the readout. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
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
