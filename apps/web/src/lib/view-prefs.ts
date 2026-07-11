// PURE diagnosis-VIEW preferences (no React, no DOM beyond a guarded localStorage — Node-testable;
// precedent: i18n.tsx's `ad.locale` durable UI preference, license.ts's storage guards).
//
// This owns the "what to SHOW in the diagnosis" state: a set of finding TYPES (Rule values) the USER has
// chosen to hide from the ledger. It is an EXPLICIT, visible, one-click-reversible user filter — NEVER
// app-side suppression, NEVER a default-on hide (invariant 3). The MEASUREMENT is untouched: packages/
// analysis still emits every finding and buildIndex still tallies every one; this only narrows the VISIBLE
// row list, exactly like the severity filter. Default = empty ⇒ the filter is a no-op ⇒ an untouched run is
// byte-identical to today (pinned in triage.test.ts).
//
// WHY localStorage (not BuildSettings / build-config v2): the user asked for this "в настройках" — a durable,
// sticky preference ("I never want to see BMFont-page info"), which matches the LOCALE precedent (a durable
// browser-only view pref), NOT the build-config one (explicit file save/load that governs the NEXT fix run).
// Storing a list of RULE NAMES never puts asset bytes on disk or on a wire — invariant 1 intact.

import type { Rule } from '@asset-doctor/core';

/** The humane groups the 23 rules fall into, by WHY a user would hide them (design §3). UI-only. */
export type RuleGroupId = 'integrity' | 'savings' | 'packing' | 'vram';

/** Top→bottom display order of the groups on the settings card. Integrity first (rarely hidden, most
 *  load-bearing), info-only VRAM last. The SINGLE source of group order — ALL_RULES derives from it. */
export const GROUP_ORDER: readonly RuleGroupId[] = ['integrity', 'savings', 'packing', 'vram'];

/** EXHAUSTIVE Rule → group map — the drift guard. Because it is `Record<Rule, RuleGroupId>`, TS requires
 *  a key for EVERY member of core's `Rule` union: adding a 24th rule to core fails `pnpm typecheck` here
 *  until it is grouped, so this can never silently go stale (no packages/core edit needed). Keys are written
 *  grouped in GROUP_ORDER so the derived per-group order below is clean and stable. */
export const RULE_GROUP: Record<Rule, RuleGroupId> = {
  // 1. Integrity & correctness — things that break or risk breakage; rarely hidden.
  'integrity-missing-image': 'integrity',
  'dimension-mismatch': 'integrity',
  bleeding: 'integrity',
  'icc-non-srgb': 'integrity',
  'dimensions-npot': 'integrity',
  'dimensions-oversize': 'integrity',
  // 2. Disk weight — encoding & redundancy savings.
  format: 'savings',
  'strippable-metadata': 'savings',
  'solid-fill': 'savings',
  'upscaled-source': 'savings',
  'wasted-alpha': 'savings',
  'duplicate-exact': 'savings',
  'duplicate-similar': 'savings',
  'frame-redundancy': 'savings',
  'cross-atlas-redundancy': 'savings',
  // 3. Atlas packing & layout.
  occupancy: 'packing',
  'wasted-regions': 'packing',
  'trim-margin': 'packing',
  'should-atlas': 'packing',
  'atlas-merge': 'packing',
  // 4. VRAM & info.
  variants: 'vram',
  'mipmap-cost': 'vram',
  'font-glyph-page': 'vram',
};

/** Rules per group, derived deterministically from RULE_GROUP (insertion order within each bucket). Single
 *  source is RULE_GROUP — this can never disagree with it. */
export const RULES_IN_GROUP: Record<RuleGroupId, readonly Rule[]> = (() => {
  const out: Record<RuleGroupId, Rule[]> = { integrity: [], savings: [], packing: [], vram: [] };
  for (const r of Object.keys(RULE_GROUP) as Rule[]) out[RULE_GROUP[r]].push(r);
  return out;
})();

/** Every rule, in group-then-insertion order — the checkbox universe + the filter's known-value set. A
 *  permutation of the `Rule` union (asserted in view-prefs.test.ts). */
export const ALL_RULES: readonly Rule[] = GROUP_ORDER.flatMap((g) => RULES_IN_GROUP[g]);

/** O(1) validity check for parseHiddenRules — the set of every KNOWN rule string. */
const RULE_SET: ReadonlySet<string> = new Set<string>(ALL_RULES);

/** localStorage key for the durable hidden-rules set. Namespaced `ad.*` like `ad.locale`. */
export const HIDDEN_RULES_STORAGE_KEY = 'ad.hiddenRules';

/** FAIL-CLOSED parse: keep only KNOWN rule strings from an array, deduped; anything else (non-array,
 *  garbage, unknown/foreign strings, null) ⇒ []. A corrupt or hostile stored value can therefore only ever
 *  degrade to "show everything" — it can NEVER hide an unknown thing or crash. */
export function parseHiddenRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) return [];
  const out: Rule[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v === 'string' && RULE_SET.has(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v as Rule);
    }
  }
  return out;
}

/** Serialize to a deterministic JSON array (deduped + sorted) so the stored value is stable regardless of
 *  toggle order. Round-trips through parseHiddenRules. */
export function serializeHiddenRules(rules: Iterable<Rule>): string {
  return JSON.stringify([...new Set(rules)].sort());
}

/** Read the durable hidden set. localStorage-guarded (SSR / disabled storage / quota) AND JSON-guarded
 *  (JSON.parse throw) AND fail-closed (parseHiddenRules). Worst case ⇒ empty set ⇒ show everything. */
export function loadHiddenRules(): Set<Rule> {
  try {
    const raw = localStorage.getItem(HIDDEN_RULES_STORAGE_KEY);
    if (raw === null) return new Set();
    return new Set(parseHiddenRules(JSON.parse(raw)));
  } catch {
    return new Set();
  }
}

/** Persist the durable hidden set. localStorage-guarded (a throwing/absent storage is swallowed — the
 *  in-memory state still updates, only persistence is skipped, exactly like i18n.tsx's setLocale). */
export function saveHiddenRules(rules: ReadonlySet<Rule>): void {
  try {
    localStorage.setItem(HIDDEN_RULES_STORAGE_KEY, serializeHiddenRules(rules));
  } catch {
    /* ignore — persistence is best-effort; the session state is the source of truth */
  }
}

export function isRuleHidden(hidden: ReadonlySet<Rule>, r: Rule): boolean {
  return hidden.has(r);
}

/** Toggle one rule's visibility, returning a FRESH set (never mutates the input — so React state updates
 *  and the stored set are never aliased). */
export function toggleRule(hidden: ReadonlySet<Rule>, r: Rule): Set<Rule> {
  const next = new Set(hidden);
  if (next.has(r)) next.delete(r);
  else next.add(r);
  return next;
}

/** Show/hide an ENTIRE group at once (the per-group header toggle), returning a FRESH set. Touches only the
 *  rules in group `g`; every other group's state is preserved. */
export function setGroupHidden(hidden: ReadonlySet<Rule>, g: RuleGroupId, hide: boolean): Set<Rule> {
  const next = new Set(hidden);
  for (const r of RULES_IN_GROUP[g]) {
    if (hide) next.add(r);
    else next.delete(r);
  }
  return next;
}

/** Tri-state for a group header checkbox, framed as "checked = SHOWN" (the checkbox semantics):
 *   'all'  ⇒ no rule in the group is hidden (every box checked),
 *   'none' ⇒ every rule in the group is hidden (every box unchecked),
 *   'some' ⇒ mixed (indeterminate). */
export function groupState(hidden: ReadonlySet<Rule>, g: RuleGroupId): 'all' | 'none' | 'some' {
  const rules = RULES_IN_GROUP[g];
  let hiddenCount = 0;
  for (const r of rules) if (hidden.has(r)) hiddenCount++;
  if (hiddenCount === 0) return 'all';
  if (hiddenCount === rules.length) return 'none';
  return 'some';
}
