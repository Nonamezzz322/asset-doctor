import type { AnalysisReport } from '@asset-doctor/core';
import { DEFAULT_THRESHOLDS } from '@asset-doctor/analysis';

/** A hand-built report for pure gate tests (intentionally NOT sorted by ref, to exercise sorting). */
export const REPORT: AnalysisReport = {
  assets: [
    { assetRef: 'b.png', diskBytes: 100, vramBytes: 4_000_000 },
    { assetRef: 'a.png', diskBytes: 200, vramBytes: 2_000_000 },
    { assetRef: 'sheet.json', diskBytes: 50, vramBytes: 1_000_000, occupancy: 0.4 },
  ],
  findings: [
    { id: 'sheet.json:occupancy', rule: 'occupancy', severity: 'crit', assetRef: 'sheet.json', title: 'low', detail: '' },
    { id: 'folder:should-atlas', rule: 'should-atlas', severity: 'warn', scope: 'folder', assetRef: 'a.png', title: 'loose', detail: '' },
    { id: 'a.png:npot', rule: 'dimensions-npot', severity: 'info', assetRef: 'a.png', title: 'npot', detail: '' },
  ],
  totals: { diskBytes: 350, vramBytes: 7_000_000, loadedVramBytes: 5_000_000, potentialDiskSaved: 0 },
  thresholds: DEFAULT_THRESHOLDS,
};
