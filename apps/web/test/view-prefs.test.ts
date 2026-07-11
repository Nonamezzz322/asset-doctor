// PURE tests for the diagnosis-VIEW preferences (the finding-type visibility filter's STATE). apps/web has
// NO React harness (vitest env=node), so the load-bearing decisions — the exhaustive Rule→group partition
// (drift guard), the FAIL-CLOSED parse, the deterministic serialize, the localStorage-guarded load/save, and
// the pure toggle/group helpers — are exercised here. localStorage is stubbed exactly like license.test.ts.

import { afterEach, describe, expect, it } from 'vitest';
import type { Rule } from '@asset-doctor/core';
import {
  ALL_RULES,
  GROUP_ORDER,
  HIDDEN_RULES_STORAGE_KEY,
  isRuleHidden,
  loadHiddenRules,
  parseHiddenRules,
  RULE_GROUP,
  RULES_IN_GROUP,
  saveHiddenRules,
  serializeHiddenRules,
  setGroupHidden,
  groupState,
  toggleRule,
  type RuleGroupId,
} from '../src/lib/view-prefs';

// A stubbed localStorage backed by an in-memory Map (precedent: license.test.ts:26). Returned so a test can
// inspect what was persisted.
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

// A localStorage whose every access throws (disabled / quota / privacy mode) — the guard must swallow it.
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

// ── the exhaustive Rule→group partition (the drift guard) ────────────────────────────────────────────
describe('RULE_GROUP / RULES_IN_GROUP / ALL_RULES — an exhaustive, disjoint partition of the Rule union', () => {
  // 27: gpu-compression-alignment (4px-block alignment disclosure) joined vram; earlier interior-transparency + binary-alpha joined the
  // Rule union (round: shared alphaShape scan). Was 24 (premultiplied-alpha round).
  it('maps EXACTLY the 27 rules, each to exactly one group (a partition — no gaps, no overlaps)', () => {
    const keys = Object.keys(RULE_GROUP) as Rule[];
    expect(keys).toHaveLength(27);
    expect(ALL_RULES).toHaveLength(27);
    // ALL_RULES is a permutation of the RULE_GROUP keys (no rule dropped or duplicated in the derivation).
    expect([...ALL_RULES].sort()).toEqual([...keys].sort());
    // No duplicates anywhere.
    expect(new Set(ALL_RULES).size).toBe(27);
  });

  it('RULES_IN_GROUP is derived from RULE_GROUP with no drift (union == ALL_RULES, groups disjoint)', () => {
    const seen = new Set<Rule>();
    let total = 0;
    for (const g of GROUP_ORDER) {
      for (const r of RULES_IN_GROUP[g]) {
        expect(RULE_GROUP[r]).toBe(g); // every rule listed under g really maps to g
        expect(seen.has(r)).toBe(false); // disjoint — no rule in two groups
        seen.add(r);
        total++;
      }
    }
    expect(total).toBe(27);
    expect([...seen].sort()).toEqual([...ALL_RULES].sort());
  });

  it('ALL_RULES is group-contiguous in GROUP_ORDER (drives the settings-card section order)', () => {
    const rebuilt = GROUP_ORDER.flatMap((g) => RULES_IN_GROUP[g]);
    expect(ALL_RULES).toEqual(rebuilt);
  });

  // 7/10/6/4: gpu-compression-alignment (a GPU-format-path disclosure) joined 'vram'; binary-alpha joined 'savings';
  // interior-transparency (a packing/fill-rate disclosure, beside trim-margin) joined 'packing'.
  // Was 7/9/5/3 (premultiplied-alpha round).
  it('the humane grouping is the agreed 7/10/6/4 split (locks accidental re-homing)', () => {
    expect(GROUP_ORDER).toEqual(['integrity', 'savings', 'packing', 'vram']);
    expect(RULES_IN_GROUP.integrity).toHaveLength(7);
    expect(RULES_IN_GROUP.savings).toHaveLength(10);
    expect(RULES_IN_GROUP.packing).toHaveLength(6);
    expect(RULES_IN_GROUP.vram).toHaveLength(4);
    // A few canonical anchors so a silent re-group is caught.
    expect(RULE_GROUP['integrity-missing-image']).toBe('integrity');
    expect(RULE_GROUP['premultiplied-alpha']).toBe('integrity');
    expect(RULE_GROUP['duplicate-exact']).toBe('savings');
    expect(RULE_GROUP['binary-alpha']).toBe('savings');
    expect(RULE_GROUP.occupancy).toBe('packing');
    expect(RULE_GROUP['interior-transparency']).toBe('packing');
    expect(RULE_GROUP['mipmap-cost']).toBe('vram');
  });
});

// ── parseHiddenRules — FAIL-CLOSED ─────────────────────────────────────────────────────────────────
describe('parseHiddenRules — fail-closed: a corrupt/foreign value can only degrade to "show all"', () => {
  it('keeps a valid subset (order preserved)', () => {
    expect(parseHiddenRules(['occupancy', 'format'])).toEqual(['occupancy', 'format']);
  });

  it('drops UNKNOWN rule strings, keeps the known ones', () => {
    expect(parseHiddenRules(['occupancy', 'not-a-rule', 'format', ''])).toEqual(['occupancy', 'format']);
  });

  it('drops non-string elements', () => {
    expect(parseHiddenRules([1, true, null, {}, 'format'])).toEqual(['format']);
  });

  it('dedupes', () => {
    expect(parseHiddenRules(['format', 'format', 'occupancy', 'occupancy'])).toEqual(['format', 'occupancy']);
  });

  it('anything that is not an array ⇒ [] (string / number / null / undefined / object)', () => {
    expect(parseHiddenRules('occupancy')).toEqual([]);
    expect(parseHiddenRules(42)).toEqual([]);
    expect(parseHiddenRules(null)).toEqual([]);
    expect(parseHiddenRules(undefined)).toEqual([]);
    expect(parseHiddenRules({ occupancy: true })).toEqual([]);
  });

  it('an all-garbage array ⇒ []', () => {
    expect(parseHiddenRules(['nope', 123, {}, 'also-not'])).toEqual([]);
  });
});

// ── serializeHiddenRules — deterministic round-trip ──────────────────────────────────────────────────
describe('serializeHiddenRules — deterministic (sorted + deduped), round-trips through parse', () => {
  it('emits a sorted JSON array regardless of input order', () => {
    const a = serializeHiddenRules(['occupancy', 'format', 'bleeding']);
    const b = serializeHiddenRules(new Set<Rule>(['bleeding', 'occupancy', 'format']));
    expect(a).toBe(b); // stable across toggle order
    expect(JSON.parse(a)).toEqual(['bleeding', 'format', 'occupancy']); // sorted
  });

  it('dedupes on the way out', () => {
    expect(JSON.parse(serializeHiddenRules(['format', 'format']))).toEqual(['format']);
  });

  it('round-trips: parse(serialize(set)) == sorted rules', () => {
    const rules: Rule[] = ['wasted-alpha', 'occupancy', 'duplicate-exact'];
    expect(parseHiddenRules(JSON.parse(serializeHiddenRules(rules)))).toEqual([...rules].sort());
  });
});

// ── loadHiddenRules / saveHiddenRules — localStorage-guarded ─────────────────────────────────────────
describe('loadHiddenRules / saveHiddenRules — durable, guarded, fail-closed', () => {
  it('save then load returns the SAME set (durable round-trip)', () => {
    installLocalStorage();
    const src = new Set<Rule>(['format', 'occupancy']);
    saveHiddenRules(src);
    expect([...loadHiddenRules()].sort()).toEqual(['format', 'occupancy']);
  });

  it('persists under the ad.hiddenRules key as a deterministic sorted JSON array', () => {
    const store = installLocalStorage();
    saveHiddenRules(new Set<Rule>(['occupancy', 'format']));
    expect(store.get(HIDDEN_RULES_STORAGE_KEY)).toBe('["format","occupancy"]');
  });

  it('no stored value ⇒ empty set (show everything)', () => {
    installLocalStorage();
    expect(loadHiddenRules().size).toBe(0);
  });

  it('corrupt stored JSON ⇒ empty set (JSON.parse throw is swallowed)', () => {
    const store = installLocalStorage();
    store.set(HIDDEN_RULES_STORAGE_KEY, '{not valid json');
    expect(loadHiddenRules().size).toBe(0);
  });

  it('stored foreign/unknown strings ⇒ dropped (fail-closed through parseHiddenRules)', () => {
    const store = installLocalStorage();
    store.set(HIDDEN_RULES_STORAGE_KEY, JSON.stringify(['format', 'evil-injected-rule', 42]));
    expect([...loadHiddenRules()]).toEqual(['format']);
  });

  it('a THROWING storage is swallowed: load ⇒ empty set, save ⇒ no throw', () => {
    installThrowingStorage();
    expect(loadHiddenRules().size).toBe(0);
    expect(() => saveHiddenRules(new Set<Rule>(['format']))).not.toThrow();
  });

  it('a MISSING localStorage (node, no stub) is swallowed too (ReferenceError guarded)', () => {
    // no install ⇒ globalThis.localStorage is undefined ⇒ the try/catch degrades to empty.
    expect(loadHiddenRules().size).toBe(0);
    expect(() => saveHiddenRules(new Set<Rule>(['format']))).not.toThrow();
  });
});

// ── toggleRule / setGroupHidden / groupState — pure, fresh-set helpers ───────────────────────────────
describe('toggleRule — adds/removes one rule, returns a FRESH set, never mutates the input', () => {
  it('adds when absent', () => {
    const src = new Set<Rule>();
    const next = toggleRule(src, 'format');
    expect(next.has('format')).toBe(true);
    expect(next).not.toBe(src);
    expect(src.has('format')).toBe(false); // input untouched
  });

  it('removes when present', () => {
    const src = new Set<Rule>(['format', 'occupancy']);
    const next = toggleRule(src, 'format');
    expect(next.has('format')).toBe(false);
    expect(next.has('occupancy')).toBe(true);
    expect(src.has('format')).toBe(true); // input untouched
  });

  it('isRuleHidden reads membership', () => {
    expect(isRuleHidden(new Set<Rule>(['format']), 'format')).toBe(true);
    expect(isRuleHidden(new Set<Rule>(['format']), 'occupancy')).toBe(false);
  });
});

describe('setGroupHidden — flips a whole group without touching other groups, fresh set', () => {
  it('hide=true adds every rule in the group', () => {
    const next = setGroupHidden(new Set<Rule>(), 'vram', true);
    for (const r of RULES_IN_GROUP.vram) expect(next.has(r)).toBe(true);
    // Other groups untouched.
    for (const r of RULES_IN_GROUP.integrity) expect(next.has(r)).toBe(false);
  });

  it('hide=false removes every rule in the group, preserving unrelated hidden rules', () => {
    const start = new Set<Rule>([...RULES_IN_GROUP.vram, 'occupancy']); // occupancy is in "packing"
    const next = setGroupHidden(start, 'vram', false);
    for (const r of RULES_IN_GROUP.vram) expect(next.has(r)).toBe(false);
    expect(next.has('occupancy')).toBe(true); // unrelated hidden rule preserved
    expect(start.size).toBe(RULES_IN_GROUP.vram.length + 1); // input untouched
  });

  it('returns a fresh set', () => {
    const src = new Set<Rule>();
    expect(setGroupHidden(src, 'packing', true)).not.toBe(src);
  });
});

describe('groupState — tri-state (checked = shown)', () => {
  const g: RuleGroupId = 'vram';
  it('no rule hidden ⇒ all (every box checked)', () => {
    expect(groupState(new Set<Rule>(), g)).toBe('all');
  });
  it('every rule in the group hidden ⇒ none', () => {
    expect(groupState(new Set<Rule>(RULES_IN_GROUP.vram), g)).toBe('none');
  });
  it('some hidden ⇒ some (indeterminate)', () => {
    expect(groupState(new Set<Rule>([RULES_IN_GROUP.vram[0]!]), g)).toBe('some');
  });
  it('a hidden rule from ANOTHER group does not change this group state', () => {
    expect(groupState(new Set<Rule>(['occupancy']), 'vram')).toBe('all'); // occupancy is packing
  });
});
