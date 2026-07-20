// PURE test for the ledger metric badge. Locks the honest label/role decision: only wasted-disk is a green
// SAVING; VRAM/OCC are neutral MEASUREMENTS; sparse values degrade to '—' (invariant 5 — disk is not VRAM,
// nothing fabricated).

import { describe, expect, it } from 'vitest';
import type { LedgerRow, SortKey } from '../src/lib/triage';
import { metricBadge } from '../src/lib/ledger-badge';
import { fmtBytes } from '../src/lib/format';

const row = (metric: Partial<LedgerRow['metric']>): LedgerRow => ({ metric } as unknown as LedgerRow);

describe('metricBadge — labelled, role-tagged, sparse ⇒ dash', () => {
  it("vram sort ⇒ VRAM measurement", () => {
    expect(metricBadge(row({ vram: 16 * 1024 * 1024 }), 'vram' as SortKey)).toEqual({ label: 'VRAM', value: fmtBytes(16 * 1024 * 1024), role: 'measure' });
  });
  it("vram sort, absent ⇒ '—' (never invented), still a measurement", () => {
    expect(metricBadge(row({ vram: undefined }), 'vram' as SortKey)).toEqual({ label: 'VRAM', value: '—', role: 'measure' });
  });
  it('occupancy sort ⇒ OCC percent measurement', () => {
    expect(metricBadge(row({ occupancy: 0.42 }), 'occupancy' as SortKey)).toEqual({ label: 'OCC', value: '42%', role: 'measure' });
  });
  it("occupancy sort, absent ⇒ '—'", () => {
    expect(metricBadge(row({ occupancy: undefined }), 'occupancy' as SortKey)).toEqual({ label: 'OCC', value: '—', role: 'measure' });
  });
  it('severity sort with wasted-disk ⇒ DISK saving (the ONLY green role)', () => {
    const b = metricBadge(row({ wastedDisk: 2 * 1024 * 1024 }), 'severity' as SortKey);
    expect(b).toEqual({ label: 'DISK', value: fmtBytes(2 * 1024 * 1024), role: 'saving' });
  });
  it('severity sort, no wasted-disk ⇒ null (no badge)', () => {
    expect(metricBadge(row({}), 'severity' as SortKey)).toBeNull();
  });
  it('vramWin sort ⇒ VRAM RECLAIM saving (green, like DISK — the measured win, not the footprint)', () => {
    const b = metricBadge(row({ vramWin: 3 * 1024 * 1024 }), 'vramWin' as SortKey);
    expect(b).toEqual({ label: 'VRAM', value: fmtBytes(3 * 1024 * 1024), role: 'saving' });
  });
  it("vramWin sort, absent ⇒ '—' (never invented); still a saving role", () => {
    expect(metricBadge(row({ vramWin: undefined }), 'vramWin' as SortKey)).toEqual({ label: 'VRAM', value: '—', role: 'saving' });
  });
  it('FOOTPRINT metrics (VRAM declared / OCC) are measurements; RECLAIMS (DISK / VRAM-win) are savings', () => {
    expect(metricBadge(row({ vram: 1 }), 'vram' as SortKey)!.role).toBe('measure'); // declared footprint
    expect(metricBadge(row({ occupancy: 0.5 }), 'occupancy' as SortKey)!.role).toBe('measure');
    expect(metricBadge(row({ wastedDisk: 1 }), 'severity' as SortKey)!.role).toBe('saving');
    expect(metricBadge(row({ vramWin: 1 }), 'vramWin' as SortKey)!.role).toBe('saving'); // measured reclaim
  });
});
