import { describe, expect, it } from 'vitest';
import { ConfigError, parseBudgetConfig, resolveThresholds } from '../src/index';

const ok = (budgets: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parseBudgetConfig({ version: 1, budgets, ...extra });

describe('parseBudgetConfig', () => {
  it('normalizes byte suffixes to raw bytes', () => {
    const c = ok({ 'totals.diskBytes': { error: { max: '8MB' } } });
    expect((c.budgets['totals.diskBytes'] as { error: { max: number } }).error.max).toBe(8 * 1024 * 1024);
  });

  it('rejects a bare number on a byte metric (the bytes-vs-KB footgun)', () => {
    expect(() => ok({ 'totals.diskBytes': { error: { max: 8_000_000 } } })).toThrow(ConfigError);
  });

  it('rejects an unknown metric key', () => {
    expect(() => ok({ 'totals.nope': { error: { max: '1MB' } } })).toThrow(/unknown metric/);
  });

  it('fails closed on a browser-only metric (format / duplicate-similar)', () => {
    expect(() => ok({ 'findings.format': { error: { max: 0 } } })).toThrow(/browser-only/);
    expect(() => ok({ 'findings.duplicate-similar': { error: { max: 0 } } })).toThrow(/browser-only/);
  });

  it('accepts headless finding-rule metrics', () => {
    expect(() => ok({ 'findings.should-atlas': { warn: { max: 0 } } })).not.toThrow();
  });

  it('rejects a wrong version and unknown top-level keys', () => {
    expect(() => parseBudgetConfig({ version: 2, budgets: {} })).toThrow(/version/);
    expect(() => parseBudgetConfig({ version: 1, budgets: {}, bogus: 1 })).toThrow(/unknown top-level/);
  });

  it('validates ratio range and threshold groups', () => {
    expect(() => ok({}, { assets: [{ match: '*', budgets: { occupancy: { warn: { min: 1.5 } } } }] })).toThrow(/0\.\.1/);
    expect(() => ok({}, { thresholds: { nope: { warn: 1 } } })).toThrow(/unknown threshold group/);
    expect(() => ok({}, { thresholds: { occupancy: { warn: 'x' } } })).toThrow(/must be a number/);
  });

  it('validates per-asset override shape and metric keys', () => {
    expect(() => ok({}, { assets: [{ budgets: {} }] })).toThrow(/match/);
    expect(() => ok({}, { assets: [{ match: '*.png', budgets: { nope: { error: { max: 1 } } } }] })).toThrow(/per-asset metric/);
  });
});

describe('resolveThresholds', () => {
  it('deep-merges a partial over DEFAULT_THRESHOLDS', () => {
    const t = resolveThresholds({ occupancy: { warn: 0.5 } as never });
    expect(t.occupancy.warn).toBe(0.5);
    expect(t.occupancy.crit).toBe(0.6); // default preserved
    expect(t.oversizePx.warn).toBe(2048); // untouched group preserved
  });
  it('returns DEFAULT_THRESHOLDS when no partial', () => {
    expect(resolveThresholds().oversizePx.crit).toBe(2730);
  });
});
