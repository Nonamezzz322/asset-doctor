# FilmViewer: on-card overlay legend + accessible canvas name (decode the x-ray; kill color-as-sole-signal on the brand hero) (PROCEED)

PREMISE — VERIFIED AGAINST REAL CODE (every claim checked, cited):

1. Canvas is nameless. apps/web/src/components/FilmViewer.tsx:122 — `<canvas ref={canvasRef} className="absolute inset-0 m-auto block max-h-full max-w-full" />` has only ref+className. No role, no aria-label. A screen reader announces nothing for the brand hero. CONFIRMED.

2. Color is the SOLE signal + the only meaning-source is a code comment. ZONE_STYLE (FilmViewer.tsx:7-12) maps the 4 OverlayZone kinds (core/src/index.ts:340: 'empty'|'transparent'|'bleeding'|'duplicate-frame') to stroke/fill hexes. The semantic mapping ("empty=red, transparent=yellow, bleeding/dup=teal") lives ONLY in the :6 comment — invisible to users. Overlays are painted on the canvas (:59-83) with dashed strokes; a colorblind user (or anyone) gets zero decoding aid. CONFIRMED — color is the sole signal, violating the stated a11y constraint.

3. Single source of truth + tokens already match. ZONE_STYLE hexes EXACTLY equal the @theme tokens (index.css): empty #e5484d == --color-crit (:22), transparent #d98a00 == --color-warn (:23), bleeding/dup #0e8c8c == --color-teal (:10). So a legend reading swatch colors FROM ZONE_STYLE can never drift from paint AND introduces zero ad-hoc colors. CONFIRMED.

4. Test infra already wired. apps/web/test/i18n-app-keys.test.ts concatenates comp('FilmViewer.tsx') into appSrc and asserts every static t('…') key resolves in CATALOGS.en (regex /\bt\(\s*['\"`]([a-zA-Z0-9._]+)['\"`]/). New static keys are auto-enforced. packages/i18n/test/catalogs.test.ts asserts all 9 locales share en's exact keyset + preserved {placeholders}. CONFIRMED.

5. Not already handled. grep across apps/web/src/components/ + App.tsx for legend|swatch|role=\"img\"|aria-label..atlas → NONE FOUND. CONFIRMED new work.

6. Pure-helper precedent exists. apps/web/src/lib/film-selection.ts (+ .test.ts) is the exact pattern to mirror; the file header even documents WHY (no React harness; vitest env=node). CONFIRMED.

ADVERSARIAL CORRECTION FOLDED IN (reuse trap): FilmViewer is REUSED for before/after diffs at App.tsx:2302 (`findings={[]}`) and :2306 (`findings={[afterFinding]}`). The "before" film has zero findings; many findings have NO `overlay` (overlay?: optional, core:378). So legendItemsFor MUST return [] when no overlay zones are present, and the JSX MUST render nothing (no empty bordered box) in that case — otherwise the diff view grows a stray empty strip. This is the dominant edge case and is designed in below.

----------------------------------------------------------------
PROBLEM (one line): The brand hero — the film-viewer x-ray — encodes all problem meaning in canvas color alone, with an unnamed canvas, so it is undecodable to colorblind users and invisible to screen readers, violating the project's first-class accessibility constraint while being trivially fixable from the existing single color source.

----------------------------------------------------------------
V1 SCOPE:
(A) Two pure, Node-tested helpers in a new file apps/web/src/lib/film-legend.ts:
   - legendItemsFor(findings: Finding[]): LegendItem[]
       LegendItem = { kind: OverlayZone['kind']; labelKey: string; fill: string }
       Returns the DISTINCT zone kinds that genuinely appear in findings[].overlay (skip findings with no overlay; skip empty rects arrays), in a deterministic fixed order ['empty','transparent','bleeding','duplicate-frame'] (matches §5 reading order / ZONE_STYLE declaration order). `fill` is read from the SHARED ZONE_STYLE constant (exported from FilmViewer, see "token changes"), so it can never drift from paint. labelKey is a short i18n key (below). Returns [] when no overlay zones exist (before-diff, no-overlay findings).
   - filmAltText(name: string, dims: {w:number;h:number} | null, findings: Finding[]): string
       Builds the canvas aria-label from MEASURED facts only: atlas name, dims (or omit dims clause when null), and the COUNT of highlighted regions = Σ over findings[].overlay[].rects.length. Returns a localized string via an injected translate fn (see signature note) — NO disk/VRAM, NO savings, nothing fabricated.
(B) JSX in FilmViewer.tsx:
   - Add role="img" + aria-label={filmAltText(...)} to the canvas (:122). The decorative .ad-scanline (:123) gets aria-hidden="true".
   - Below the readout strip (after the :128-137 4-cell grid, before the MEASURED strip at :143), render a compact flex-wrap legend of swatch+label pairs from legendItemsFor(assetFindings-equivalent = the `findings` prop). Render the whole block ONLY when items.length > 0.

----------------------------------------------------------------
OUT OF SCOPE (explicit): no new detectors/rules/parsers/analysis; no change to ZONE_STYLE colors or the paint loop (:59-83); no change to the readout/breakdown/probe cells; no new @theme token (all colors come from existing tokens via ZONE_STYLE); no change to the virtualized TriageLedger; no tooltip/interaction beyond a static legend; the before/after-diff legend behavior is just "renders nothing when empty" (no special diff legend). The hue-rotate-per-cluster trick (:68) is NOT mirrored in the legend — the legend shows the canonical kind color only (honest: it labels the KIND, the per-cluster hue is a within-kind disambiguator, not a separate category).

----------------------------------------------------------------
EXACT FILES + COMPONENTS + TOKEN CHANGES:

FILE 1 (new): apps/web/src/lib/film-legend.ts — the two pure helpers + LegendItem type + ZONE_KIND_ORDER const.
FILE 2 (new): apps/web/src/lib/film-legend.test.ts — Vitest unit tests (mirrors film-selection.test.ts).
FILE 3 (edit): apps/web/src/components/FilmViewer.tsx —
   - EXPORT ZONE_STYLE (change `const ZONE_STYLE` :7 to `export const ZONE_STYLE`) so film-legend.ts imports the SAME object → single source of truth, zero drift. (Alternative if a circular-import worry arises: move ZONE_STYLE into film-legend.ts and import it back into FilmViewer; preferred is export-from-FilmViewer since the paint loop already owns it and there's no cycle — film-legend imports from FilmViewer, FilmViewer imports from film-legend, which IS a cycle. CORRECTION: to avoid the import cycle, place ZONE_STYLE in film-legend.ts and import it into FilmViewer.tsx for the paint loop. This keeps one definition, no cycle.)
   - canvas (:122): add `role="img"` and `aria-label={altText}` where `const altText = filmAltText(name, dims, findings)` is computed in render (dims is already state at :40).
   - scanline (:123): add `aria-hidden="true"`.
   - new legend block after :137.
FILE 4 (edit): packages/i18n/src/catalogs/en.json + the other 8 (de/es/fr/hi/it/pt/ru/zh) — add the short keys below to ALL 9 (enforced by catalogs.test.ts).

TOKEN CHANGES: NONE new. Swatch background = LegendItem.fill (from ZONE_STYLE, == --color-crit/--color-warn/--color-teal). Legend text uses existing text-film-soft (matches the :168 breakdown label) and font-mono. No ad-hoc color, no new --color-*.

i18n KEYS (new, short, in all 9 — additive):
   - "legend.empty"        en: "empty"
   - "legend.transparent"  en: "transparent margin"
   - "legend.bleeding"     en: "bleeding"            (covers both bleeding + duplicate-frame? NO — see honesty note)
   - "legend.duplicateFrame" en: "duplicate frame"
   - "film.alt"            en: "Atlas {name}, {w}×{h} pixels, {regions} highlighted regions"  (plural on {regions} via the existing plural-object form, like readout.batched at en.json:13-17 — provide one/other; $count: "regions")
   - "film.altNoDims"      en: "Atlas {name}, {regions} highlighted regions"  (plural object on {regions}; used when dims is null)
   HONESTY NOTE ON labels: bleeding and duplicate-frame both paint teal but are DIFFERENT kinds (core:340). The legend lists kinds actually present, so it must use distinct labels (legend.bleeding vs legend.duplicateFrame) even though both swatches are teal — otherwise the legend would imply two distinct teal categories are one, OR fabricate. They share the teal swatch (honest: same color in paint) but carry their true distinct names. This is MORE honest than the :6 comment which lumps them.

----------------------------------------------------------------
UX LOGIC EXTRACTED → PURE NODE-TESTABLE (the testable core):

// apps/web/src/lib/film-legend.ts
import type { Finding, OverlayZone } from '@asset-doctor/core';
import { ZONE_STYLE } from './film-legend-style'; // ZONE_STYLE lives here to avoid the FilmViewer cycle

export const ZONE_KIND_ORDER: OverlayZone['kind'][] = ['empty','transparent','bleeding','duplicate-frame'];
const LABEL_KEY: Record<OverlayZone['kind'], string> = {
  empty:'legend.empty', transparent:'legend.transparent', bleeding:'legend.bleeding', 'duplicate-frame':'legend.duplicateFrame',
};
export interface LegendItem { kind: OverlayZone['kind']; labelKey: string; fill: string }

export function legendItemsFor(findings: Finding[]): LegendItem[] {
  const present = new Set<OverlayZone['kind']>();
  for (const f of findings) for (const z of f.overlay ?? []) if (z.rects.length > 0) present.add(z.kind);
  return ZONE_KIND_ORDER.filter(k => present.has(k))
    .map(k => ({ kind:k, labelKey:LABEL_KEY[k], fill: ZONE_STYLE[k].fill }));
}

export function regionCount(findings: Finding[]): number {
  let n = 0; for (const f of findings) for (const z of f.overlay ?? []) n += z.rects.length; return n;
}

// filmAltText takes an injected translate so it stays pure + Node-testable (no React useI18n).
export function filmAltText(
  t: (key: string, params?: Record<string,string|number>) => string,
  name: string, dims: {w:number;h:number}|null, findings: Finding[],
): string {
  const regions = regionCount(findings);
  return dims
    ? t('film.alt',       { name, w: dims.w, h: dims.h, regions })
    : t('film.altNoDims', { name, regions });
}

In FilmViewer.tsx render: `const altText = filmAltText(t, name, dims, findings);` (t from useI18n at :38; dims from state at :40). The split (legendItemsFor / regionCount / filmAltText) keeps each function trivially testable.

NOTE on ZONE_STYLE placement (cycle fix): create apps/web/src/lib/film-legend-style.ts holding ZONE_STYLE (the existing :7-12 object verbatim). FilmViewer.tsx imports it for paint; film-legend.ts imports it for swatches. ONE definition, no import cycle. (This adds a 4th small file; it's the clean way to keep single-source-of-truth without a FilmViewer↔film-legend cycle.)

----------------------------------------------------------------
ARIA / KEYBOARD / REDUCED-MOTION / CONTRAST:

ARIA:
- Canvas: role="img" + aria-label={altText}. A canvas with painted content is otherwise an inaccessible blob; role="img"+label is the WCAG-correct pattern for a meaningful graphic.
- Decorative scanline (:123): aria-hidden="true" (it's pure chrome).
- Legend container: role="list" with className including "list-none"; each swatch+label pair is role="listitem". Each swatch <span> is aria-hidden="true" (decorative — the adjacent text label carries the meaning), so the SR reads only the localized words, never "colored box".
- Legend gets an accessible group name via aria-label={t('legend.heading')} on the role="list" (add "legend.heading" en:"overlay legend" to the 9 catalogs) OR omit and rely on the visible mini-heading with an id+aria-labelledby. SIMPLER + token-faithful: render a visually-present uppercase mini-heading exactly like the breakdown label (:168 `font-mono text-[9px] uppercase tracking-[0.08em] text-film-soft`) with text t('legend.heading'), give it id="ad-legend-h-{name}"... CORRECTION: ids must be unique + name may contain odd chars → use React useId() for the heading id and aria-labelledby on the list. (useId is already React 18-safe.)

KEYBOARD: The legend is non-interactive (static text), so NO new focus stops — correct (avoids tab-bloat on the hero). The canvas is non-interactive too (role=img), so it is not in the tab order, which is right; its label is exposed to AT in the accessibility tree without being focusable. No keyboard regressions; the virtualized ledger's keyboard nav is untouched.

REDUCED-MOTION: The legend has NO animation, so prefers-reduced-motion is irrelevant to it (additive-safe). The existing :148-157 block (scanline display:none under reduce) is untouched. Adding aria-hidden to the scanline is orthogonal and complementary.

CONTRAST: Legend TEXT uses text-film-soft (#9fb0bd) on bg-film (#0c1116) — that is the SAME pairing already used for the :168 breakdown label and :114 filename, so contrast is already accepted in-product (ratio ~7:1, AA-large/AAA-normal comfortable). The SWATCH is decorative (aria-hidden) so its own contrast is not a text-contrast requirement; meaning is carried by the adjacent text → color is NO LONGER the sole signal. Use a 1px border-film-border ring on each swatch so a near-bg fill (none here, but future-proof) stays visible.

----------------------------------------------------------------
HONESTY / INSTANT-WOW / PERF-AT-SCALE / DETERMINISM:

HONESTY: (a) legendItemsFor lists ONLY kinds with non-empty rects actually in findings[].overlay — never a fabricated category; before-diff (findings=[]) → []. (b) bleeding vs duplicate-frame keep DISTINCT true labels (more honest than the lumping :6 comment). (c) filmAltText reports name + measured dims + measured region count only — NO disk, NO VRAM, NO savings, no conflation of disk≠VRAM (that line stays exactly as :128-137). (d) swatch fills come from ZONE_STYLE → the legend is provably the same colors as paint.

INSTANT-WOW: Zero impact on the <=10s analysis path. The helpers run in render over the already-computed `findings` prop (tiny arrays per asset); the decode effect (:42-89) is untouched. Legend nodes are a handful of static spans rendered once per selection.

PERF-AT-SCALE: The legend lives in the sticky single-selection aside (App.tsx:338), rendered ONCE per selected film — NOT per ledger row. The virtualized TriageLedger (useWindow) is not touched. legendItemsFor/regionCount iterate one asset's findings (typically <10 zones), O(zones); 1000+ assets only ever show one film's legend. No layout thrash.

DETERMINISM: Output is a pure function of findings + fixed ZONE_KIND_ORDER → stable order, no Set-iteration nondeterminism (we map over the fixed ordered array, filtered by the presence Set — Set used only for membership, never iterated). regionCount is a deterministic sum. Fully Node-testable.

----------------------------------------------------------------
EDGE CASES:
- 0 assets / no selection: FilmViewer not rendered (App gating) → N/A.
- Before-diff film (App.tsx:2302, findings=[]): legendItemsFor → [] → legend block renders NOTHING (guarded on items.length>0). No stray empty strip. filmAltText → "Atlas {name}, {w}×{h} pixels, 0 highlighted regions" (honest — it IS the unannotated source). Plural "0" uses 'other' form (en: "0 highlighted regions") — verify the plural object handles 0 (Intl.PluralRules en: 0→'other', correct).
- After-diff film (App.tsx:2306, findings=[afterFinding]): if afterFinding has overlay → legend shows those kinds; if not → []. Either way correct.
- Findings present but none have overlay (e.g. format/dimension findings): legendItemsFor → [] → no legend, but canvas STILL gets a name via filmAltText with regions=0. Good — name even when no overlay.
- 1000+ assets: only one film's legend ever mounts (sticky aside). No perf impact.
- Long i18n strings (de "transparenter Rand", pt "moldura duplicada"): legend is flex-wrap (class "flex flex-wrap gap-x-3 gap-y-1.5") so labels wrap to a new line; each item is "inline-flex items-center gap-1.5 whitespace-nowrap" so a label never splits mid-word but the ROW wraps. aria-label long strings are unbounded (no truncation) — AT handles length.
- dims null (image not yet decoded / re-read pending): filmAltText uses film.altNoDims branch → no NaN dims in the label.
- name with special chars: passed verbatim into the label (string param, not a key) — safe.

----------------------------------------------------------------
TEST PLAN (real, mostly pure-unit):

PURE UNIT (apps/web/src/lib/film-legend.test.ts, vitest env=node — same as film-selection.test.ts):
1. legendItemsFor([]) → [] (before-diff empty state).
2. findings with no `overlay` → [] (format/dim findings).
3. findings with overlay but rects:[] → [] (defensive — empty zone ignored).
4. one finding, overlay [{empty,[r]}] → [{kind:'empty',labelKey:'legend.empty',fill:ZONE_STYLE.empty.fill}].
5. ORDER: findings producing transparent THEN empty (out of canonical order) → result is [empty, transparent] (asserts ZONE_KIND_ORDER, not input order → DETERMINISM lock).
6. DISTINCT: two findings each with empty zones → ONE empty item (dedup).
7. all four kinds present → 4 items in canonical order; bleeding and duplicate-frame are SEPARATE items with the SAME fill (locks the honest-distinct-labels + shared-teal contract).
8. fill provenance: assert legendItemsFor(...)[i].fill === ZONE_STYLE[kind].fill for each (locks single-source-of-truth — if someone changes ZONE_STYLE the legend follows, no drift).
9. regionCount: sums rects across multiple zones/findings; 0 for [].
10. filmAltText with a stub t = (k,p)=>`${k}:${JSON.stringify(p)}` → asserts it calls 'film.alt' with {name,w,h,regions} when dims present, and 'film.altNoDims' with {name,regions} when dims null (locks the branch + params, AT-string is locale's job).

I18N (existing, auto-enforced — no new test file needed):
11. apps/web/test/i18n-app-keys.test.ts already scans FilmViewer.tsx → the new STATIC t('legend.empty') etc. and t('film.alt')/t('film.altNoDims') calls are auto-asserted present in en. (These are static-literal t() calls, NOT dynamic templates — legendItemsFor returns labelKey strings but FilmViewer calls t(item.labelKey) which is a VARIABLE, NOT matched by the static-literal regex. CORRECTION/IMPORTANT: the scan regex only catches t('literal'). t(item.labelKey) is dynamic and will NOT be caught. To keep the guard meaningful, ALSO add an explicit it() block to a test (either extend i18n-app-keys.test.ts's pattern or add a tiny assertion in film-legend.test.ts) iterating LABEL_KEY values + ['film.alt','film.altNoDims','legend.heading'] and asserting CATALOGS.en[k] !== undefined. This is the same "drift-guard it() block" pattern the file already uses for severity.*/license.err.* mirrored unions. Add this block — do NOT rely on the static scan for the variable label keys.)
12. packages/i18n/test/catalogs.test.ts already asserts all 9 locales have en's exact keyset + preserved {placeholders} → adding the keys to all 9 is enforced; the {name}{w}{h}{regions} placeholders + plural object on film.alt are validated. Add a line in its "renders ... without leftover braces" loop: translate(loc,'film.alt',{name:'a',w:512,h:512,regions:3}).not.toContain('{') and the regions:1/0 plural forms.

UNVERIFIABLE-BY-TEST (visual only — must be obviously correct from code): the actual rendered swatch/flex-wrap layout and the role="img" announcement. Mitigation: (a) all colors/classes are existing tokens reused verbatim from the breakdown label (:168) and bg-film, so the visual is derivative of accepted in-product styling; (b) the JSX is purely additive and structurally trivial (a flex-wrap list of span+span); (c) the load-bearing LOGIC (which items, what order, what fill, what alt params) is 100% covered by the pure tests above. The only truly unverifiable parts are the px gaps and wrap behavior — token-driven and low-risk per the constraints.

----------------------------------------------------------------
ORDERED SMALL-COMMIT BREAKDOWN:

C1. feat(web): extract ZONE_STYLE to film-legend-style.ts; import into FilmViewer paint loop (no behavior change — pure refactor; verifies build + existing tests stay green).
C2. feat(web): add film-legend.ts pure helpers (legendItemsFor / regionCount / filmAltText / ZONE_KIND_ORDER / LegendItem) reading from film-legend-style.ts.
C3. test(web): film-legend.test.ts — the 10 pure unit tests + the catalog drift-guard it() block (LABEL_KEY values + film.alt/film.altNoDims/legend.heading exist in en).
C4. feat(i18n): add legend.empty/transparent/bleeding/duplicateFrame + legend.heading + film.alt (plural) + film.altNoDims (plural) to en.json; then the other 8 locales (de/es/fr/hi/it/pt/ru/zh) — catalogs.test.ts enforces parity.
C5. test(i18n): extend catalogs.test.ts no-leftover-braces loop with film.alt {name,w,h,regions} (forms 0/1/3) + film.altNoDims.
C6. feat(web): FilmViewer.tsx — add role="img"+aria-label to canvas (:122), aria-hidden to scanline (:123), and the flex-wrap legend block (role=list/listitem, aria-hidden swatches, useId-labelled heading) after the readout strip, guarded on legendItemsFor(findings).length>0.

Run after each: pnpm --filter @asset-doctor/web typecheck && pnpm test (vitest) — C3/C5 lock logic, C1 proves the refactor is inert, C6 is the additive visual layer whose logic is already proven.