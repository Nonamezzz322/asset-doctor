import { describe, expect, it } from 'vitest';
import { ASSET_METRICS, CLI_CAPABILITIES, GLOBAL_METRICS } from '../src/index';
import { REPORT } from './fixture';

const get = (key: string) => GLOBAL_METRICS.get(key)!.get(REPORT);

describe('metric registry', () => {
  it('maps totals keys to report.totals', () => {
    expect(get('totals.diskBytes')).toBe(350);
    expect(get('totals.vramBytes')).toBe(7_000_000);
    expect(get('totals.loadedVramBytes')).toBe(5_000_000);
  });

  it('counts findings by severity, by rule, and total', () => {
    expect(get('findings.crit')).toBe(1);
    expect(get('findings.warn')).toBe(1);
    expect(get('findings.info')).toBe(1);
    expect(get('findings.total')).toBe(3);
    expect(get('findings.occupancy')).toBe(1);
    expect(get('findings.should-atlas')).toBe(1);
    expect(get('findings.duplicate-exact')).toBe(0);
  });

  it('drawCallsLowerBound = distinct textures (assets.length)', () => {
    expect(get('drawCallsLowerBound')).toBe(3);
  });

  it('marks browser-only rules unavailable under the CLI capabilities', () => {
    expect(GLOBAL_METRICS.get('findings.format')!.available(CLI_CAPABILITIES)).toBe(false);
    expect(GLOBAL_METRICS.get('findings.duplicate-similar')!.available(CLI_CAPABILITIES)).toBe(false);
    expect(GLOBAL_METRICS.get('findings.should-atlas')!.available(CLI_CAPABILITIES)).toBe(true);
    expect(GLOBAL_METRICS.get('totals.vramBytes')!.available(CLI_CAPABILITIES)).toBe(true);
  });

  it('per-asset metrics read off AssetMetrics + size', () => {
    const m = REPORT.assets.find((a) => a.assetRef === 'sheet.json')!;
    expect(ASSET_METRICS.get('vramBytes')!.get(m)).toBe(1_000_000);
    expect(ASSET_METRICS.get('occupancy')!.get(m)).toBe(0.4);
    expect(ASSET_METRICS.get('occupancy')!.get(REPORT.assets[0]!)).toBeUndefined(); // loose image: no occupancy
    expect(ASSET_METRICS.get('oversizePx')!.get(m, { w: 2050, h: 1024 })).toBe(2050);
    expect(ASSET_METRICS.get('oversizePx')!.get(m)).toBeUndefined(); // no size → N/A
  });
});
