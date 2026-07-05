// PURE tests for the user-budget preference (budget-prefs.ts). apps/web has NO React harness (vitest env=node),
// so the load-bearing decisions — the fail-closed per-field parse, the mb↔bytes convention, the input parse, and
// the localStorage-guarded load/save — are exercised here. localStorage is stubbed exactly like theme.test.ts /
// view-prefs.test.ts.

import { afterEach, describe, expect, it } from 'vitest';
import {
  BUDGETS_STORAGE_KEY,
  bytesToMb,
  loadBudgets,
  mbToBytes,
  parseBudgetInput,
  parseBudgets,
  saveBudgets,
  setBudgetField,
  type Budgets,
} from './budget-prefs';

// A stubbed localStorage backed by an in-memory Map (precedent: theme.test.ts). Returned so a test can inspect
// what was persisted.
function installLocalStorage(): Map<string, string> {
  const m = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  return m;
}

function installThrowingStorage(): void {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => {
      throw new Error('storage blocked');
    },
    setItem: () => {
      throw new Error('storage blocked');
    },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  } as Storage;
}

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('budget-prefs — storage-key contract', () => {
  it('BUDGETS_STORAGE_KEY is ad.budgets (namespaced ad.*, no collision)', () => {
    expect(BUDGETS_STORAGE_KEY).toBe('ad.budgets');
  });
});

describe('budget-prefs — parseBudgets (fail-closed, per-field)', () => {
  it('keeps a full valid object', () => {
    expect(parseBudgets({ vramBytes: 100, drawCalls: 30, diskBytes: 2048 })).toEqual({ vramBytes: 100, drawCalls: 30, diskBytes: 2048 });
  });
  it('keeps each field individually', () => {
    expect(parseBudgets({ vramBytes: 1 })).toEqual({ vramBytes: 1 });
    expect(parseBudgets({ drawCalls: 1 })).toEqual({ drawCalls: 1 });
    expect(parseBudgets({ diskBytes: 1 })).toEqual({ diskBytes: 1 });
  });
  it('a non-object / null / array / string / number ⇒ {}', () => {
    for (const bad of [null, undefined, 42, 'x', true, [1, 2], [], NaN]) {
      expect(parseBudgets(bad as unknown)).toEqual({});
    }
  });
  it('drops each invalid field value (0 / negative / NaN / Infinity / float / string / missing)', () => {
    // per-field drop: an object with ONE bad field keeps only the good fields.
    expect(parseBudgets({ vramBytes: 0 })).toEqual({});
    expect(parseBudgets({ vramBytes: -5 })).toEqual({});
    expect(parseBudgets({ vramBytes: NaN })).toEqual({});
    expect(parseBudgets({ vramBytes: Infinity })).toEqual({});
    expect(parseBudgets({ vramBytes: 1.5 })).toEqual({});
    expect(parseBudgets({ vramBytes: '5' })).toEqual({});
    expect(parseBudgets({ drawCalls: 10, diskBytes: -1 })).toEqual({ drawCalls: 10 }); // partial: bad field dropped
  });
  it('a valid positive integer is kept', () => {
    expect(parseBudgets({ vramBytes: 67108864 })).toEqual({ vramBytes: 67108864 });
  });
  it('ignores unknown extra fields', () => {
    expect(parseBudgets({ vramBytes: 1, bogus: 99 } as unknown)).toEqual({ vramBytes: 1 });
  });
});

describe('budget-prefs — parseBudgetInput (nullable "off")', () => {
  it('empty / whitespace / non-numeric / <=0 ⇒ null', () => {
    for (const raw of ['', '   ', 'abc', '0', '-5', 'NaN', '  -1 ']) {
      expect(parseBudgetInput(raw)).toBeNull();
    }
  });
  it('a positive number (int or float) parses', () => {
    expect(parseBudgetInput('64')).toBe(64);
    expect(parseBudgetInput('0.5')).toBe(0.5);
    expect(parseBudgetInput('  12 ')).toBe(12);
  });
});

describe('budget-prefs — mb↔bytes convention (1024-based, clean whole-MB round-trip)', () => {
  it('mbToBytes rounds to a positive integer', () => {
    expect(mbToBytes(64)).toBe(67108864);
    expect(mbToBytes(0.5)).toBe(524288);
  });
  it('bytesToMb → mbToBytes round-trips whole MB exactly', () => {
    expect(bytesToMb(mbToBytes(64))).toBe(64);
    expect(bytesToMb(mbToBytes(0.5))).toBe(0.5);
  });
  it('bytesToMb is 3-dp', () => {
    expect(bytesToMb(1782579)).toBe(1.7);
  });
});

describe('budget-prefs — setBudgetField (immutable, re-validated)', () => {
  it('does not mutate the input and returns a fresh object', () => {
    const b: Budgets = { vramBytes: 10 };
    const next = setBudgetField(b, 'drawCalls', 5);
    expect(b).toEqual({ vramBytes: 10 }); // unchanged
    expect(next).toEqual({ vramBytes: 10, drawCalls: 5 });
    expect(next).not.toBe(b);
  });
  it('undefined ⇒ drops the field', () => {
    expect(setBudgetField({ vramBytes: 10, drawCalls: 5 }, 'drawCalls', undefined)).toEqual({ vramBytes: 10 });
  });
  it('a valid positive integer ⇒ set', () => {
    expect(setBudgetField({}, 'diskBytes', 2048)).toEqual({ diskBytes: 2048 });
  });
  it('an invalid value (0 / negative / float) ⇒ dropped, NEVER stored', () => {
    // re-validated via the same predicate — a bad value clears (never persists) the field.
    expect(setBudgetField({ vramBytes: 10 }, 'vramBytes', 0)).toEqual({});
    expect(setBudgetField({ vramBytes: 10 }, 'vramBytes', -1)).toEqual({});
    expect(setBudgetField({ vramBytes: 10 }, 'vramBytes', 1.5)).toEqual({});
  });
});

describe('budget-prefs — load/save (localStorage-guarded)', () => {
  it('save then load round-trips and persists the parsed object under ad.budgets', () => {
    const m = installLocalStorage();
    saveBudgets({ vramBytes: 67108864, drawCalls: 30 });
    expect(JSON.parse(m.get(BUDGETS_STORAGE_KEY)!)).toEqual({ vramBytes: 67108864, drawCalls: 30 });
    expect(loadBudgets()).toEqual({ vramBytes: 67108864, drawCalls: 30 });
  });
  it('nothing stored ⇒ {} (the ONLY default is empty — no baked-in budget)', () => {
    installLocalStorage();
    expect(loadBudgets()).toEqual({});
  });
  it('corrupt stored JSON ⇒ {} (fail-closed)', () => {
    const m = installLocalStorage();
    m.set(BUDGETS_STORAGE_KEY, '{not json');
    expect(loadBudgets()).toEqual({});
  });
  it('a stored object with junk fields ⇒ only the valid fields survive load', () => {
    const m = installLocalStorage();
    m.set(BUDGETS_STORAGE_KEY, JSON.stringify({ vramBytes: 10, drawCalls: 0, diskBytes: 'x' }));
    expect(loadBudgets()).toEqual({ vramBytes: 10 });
  });
  it('save re-validates: a caller passing junk never writes it', () => {
    const m = installLocalStorage();
    saveBudgets({ vramBytes: 0, drawCalls: 5 } as Budgets);
    expect(JSON.parse(m.get(BUDGETS_STORAGE_KEY)!)).toEqual({ drawCalls: 5 });
  });
  it('throwing storage ⇒ load is {} and save does not throw', () => {
    installThrowingStorage();
    expect(loadBudgets()).toEqual({});
    expect(() => saveBudgets({ vramBytes: 1 })).not.toThrow();
  });
  it('missing localStorage ⇒ {} and save does not throw', () => {
    expect(loadBudgets()).toEqual({});
    expect(() => saveBudgets({ vramBytes: 1 })).not.toThrow();
  });
});
