// PURE, durable USER-BUDGET preferences for the results budget strip (user-settable budgets round). apps/web
// has NO React harness (vitest env=node), so the load-bearing decisions — the fail-closed parse, the mb↔bytes
// convention, the input parse, and the localStorage-guarded load/save — live here and are Node-unit-tested; the
// SettingsPage BudgetsCard + BudgetStrip are thin renderers over these outputs (precedent: view-prefs.ts /
// theme.ts — durable, browser-only, localStorage-guarded, fail-closed).
//
// HONESTY (invariant 3): there is NO default / suggested / baked-in budget ANYWHERE — the ONLY default is an
// EMPTY object. A budget threshold is a user's verdict line, never ours; so a metric gets a bar + over-budget
// verdict ONLY once the user typed a number. loadBudgets() with nothing stored ⇒ {} ⇒ the strip is byte-
// identical to today (pinned in budget-verdicts.test.ts: budgetVerdicts(bm, {}) === []).
//
// WHY localStorage (not BuildSettings / build-config v2): a budget is a durable, sticky VIEW preference on the
// diagnosis strip — the locale / hiddenRules / theme precedent — NOT part of the fix/export config that governs
// the NEXT run. It is therefore absent from the build-config export and never invalidates a pending fix plan.
// Storing three NUMBERS never puts asset bytes on disk or on a wire — invariant 1 (nothing leaves the device).
//
// packages/budget KEY VOCABULARY (documented, NOT imported — §A.4/A.5 of the design). The CLI/GH-Action budget
// gate (packages/budget) uses a metric registry; a FUTURE "import a .budgets.json" path would map:
//   • vramBytes ↔ its `vramBytes` metric (get: totals.loadedVramBytes) — BYTE-IDENTICAL to bm.vram.loaded here.
//   • diskBytes ↔ its `diskBytes` metric (get: totals.diskBytes)       — BYTE-IDENTICAL to bm.disk.total here.
//   • drawCalls ↔ its `drawCallsLowerBound` metric — SEMANTIC CAVEAT: the CLI compares assets.length, whereas
//     the web strip compares the TIGHTER loaded-textures floor (bm.draw.estimated = totals.loadedTextures), and
//     the CLI's max-check emits a `pass` for value ≤ max (the forbidden floor≤budget green pass — see the floor
//     asymmetry in budget-verdicts.ts). So the gate is NOT reused at runtime; this web-local module owns the
//     honest floor semantics. No import, no dependency added to apps/web/package.json.

/** The three user budgets. Units are explicit in the field names: bytes for vram/disk, a raw count for draw.
 *  An ABSENT field means "no budget for this metric" (off) — never a zero, never a sentinel. */
export interface Budgets {
  /** bytes; compared vs bm.vram.loaded (declared) [+ bm.vram.measured.vram when the probe ran]. */
  vramBytes?: number;
  /** count; compared vs bm.draw.calls (measured) OR bm.draw.estimated (floor, no probe). */
  drawCalls?: number;
  /** bytes; compared vs bm.disk.total (the MEASURED total on disk, never bm.disk.after — an estimate). */
  diskBytes?: number;
}

/** localStorage key for the durable budgets. Namespaced `ad.*` like `ad.hiddenRules` / `ad.theme` / `ad.locale`
 *  (verified no collision). */
export const BUDGETS_STORAGE_KEY = 'ad.budgets';

const FIELDS: readonly (keyof Budgets)[] = ['vramBytes', 'drawCalls', 'diskBytes'];

/** The per-field validity predicate — a stored/settable budget must be a finite POSITIVE INTEGER. A float, a
 *  zero (would read as "everything over budget"), a negative, NaN/Infinity, or a non-number is never a budget. */
function isValidBudget(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}

/** FAIL-CLOSED parse: keep only the KNOWN fields that pass isValidBudget; drop everything else per-field. A
 *  non-object / null / array / string / number ⇒ {}. A corrupt or hostile stored value can therefore only ever
 *  degrade to "no budgets set" — it can NEVER fabricate a verdict threshold or crash. */
export function parseBudgets(raw: unknown): Budgets {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: Budgets = {};
  for (const k of FIELDS) {
    const v = obj[k];
    if (isValidBudget(v)) out[k] = v;
  }
  return out;
}

/** Read the durable budgets. localStorage-guarded (SSR / disabled storage / quota) AND JSON-guarded (throw)
 *  AND fail-closed (parseBudgets). Worst case ⇒ {} ⇒ no budgets ⇒ byte-identical strip. */
export function loadBudgets(): Budgets {
  try {
    const raw = localStorage.getItem(BUDGETS_STORAGE_KEY);
    if (raw === null) return {};
    return parseBudgets(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Persist the durable budgets. Re-validated through parseBudgets so a bad value can never be written, then
 *  localStorage-guarded (a throwing/absent storage is swallowed — the in-memory state still updates, only
 *  persistence is skipped, exactly like saveHiddenRules / saveTheme). */
export function saveBudgets(b: Budgets): void {
  try {
    localStorage.setItem(BUDGETS_STORAGE_KEY, JSON.stringify(parseBudgets(b)));
  } catch {
    /* ignore — persistence is best-effort; the session state is the source of truth */
  }
}

/** Set (or clear) one budget field, returning a FRESH object (never mutates the input — so React state and the
 *  stored value are never aliased). `undefined` OR an invalid value ⇒ the field is DROPPED (re-validated via the
 *  same predicate, so a bad value can never be stored — a caller passing 0/negative/float clears the field). */
export function setBudgetField(b: Budgets, k: keyof Budgets, v: number | undefined): Budgets {
  const next: Budgets = { ...b };
  if (v === undefined || !isValidBudget(v)) delete next[k];
  else next[k] = v;
  return next;
}

/** MB → bytes at the UI boundary (VRAM/disk are entered in MB). 1024-based so a value entered in MB renders
 *  identically by the strip's fmtBytes (format.ts is 1024-based) and matches the i18n :bytes hint + the CLI
 *  parseBytes MB=1024². Always a positive integer. */
export function mbToBytes(mb: number): number {
  return Math.round(mb * 1024 * 1024);
}

/** bytes → MB for display in the settings field, 3-dp so a whole-MB round-trip is clean (64 ⇒ 67108864 ⇒ 64). */
export function bytesToMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 1000) / 1000;
}

/** Parse a raw number-input string into a positive budget number, or null for "off". '' / whitespace / NaN /
 *  <= 0 ⇒ null (the field is cleared); otherwise the positive number (a float is allowed here — the caller
 *  rounds/converts before storing, and setBudgetField re-validates to an integer). */
export function parseBudgetInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
