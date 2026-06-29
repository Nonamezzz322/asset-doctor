# Raise faded secondary-text opacity to meet WCAG AA contrast (PROCEED)


PREMISE — VERIFIED TRUE (independently recomputed, sRGB-linearized WCAG 2.1 §1.4.3, alpha-composited over the real @theme tokens; script in /tmp/wcag.mjs):

  fg = ink-soft #566472 (index.css:9), composited over bg #E7ECF1 (index.css:5) and panel #FFFFFF (index.css:6):
    /100 (full): bg 5.10 · panel 6.07   → PASSES 4.5:1  (matches PICK 5.10/6.07)
    /80        : bg 3.44 · panel 3.86   → FAILS         (matches PICK bg 3.44)
    /70        : bg 2.84 · panel 3.13   → FAILS         (matches PICK 2.84 / ~3.16)
    /50        : bg 2.03 · panel 2.14   → FAILS but EXEMPT (disabled control)  (matches PICK 2.03)
  All flagged text is text-[9px]/text-[10px] mono = WCAG "normal" size (well under 18.66px bold / 24px) ⇒ the 4.5:1 (not 3:1) minimum applies; the failure is unambiguous. Full ink-soft clears 4.5:1 on BOTH surfaces, so dropping the alpha is a sufficient and minimal fix — no new token, no hex.

ADVERSARIAL CORRECTION TO PICK SCOPE (load-bearing): the PICK enumerates ~9 instances as if exhaustive. They are NOT. `grep -nE "text-ink-soft/(70|80)"` over apps/web/src/App.tsx returns 36 instances; components/ returns 0. I inspected all 36 (lines 665,667,906,945,991,995,1028,1053,1120,1156,1161,1168,1272,1305,1324,1368,1382,1398,1399,1437,1438,1486,2029,2128,2237,2274,2342,2364,2388,2416,2475,2496,2619,2692,2776 + the ledger ul at 809): every one is readable prose — hints, honesty/disk≠VRAM notes, diagnoses, status, section labels, receipt lines. None decorative, none disabled. Shipping only the 9 named would leave 27 readable notes failing AA and the accessibility claim half-met (inconsistent contrast within the same panels). V1 therefore remaps ALL 36 readable instances. The ONLY exempt case is text-ink-soft/50 at App.tsx:1062 (the consent label, faded ONLY in its !ready disabled state — WCAG 1.4.3 exempts disabled controls) — left untouched, exactly as PICK says.

PROBLEM (cited): readable secondary text across the Pro/fix panels is rendered at ink-soft/70–/80, yielding 2.84–3.86:1 — below AA 4.5:1. This is the highest-traffic honesty copy in the app (disk≠VRAM notes at 2237/2274/2342/2416/2496, the upload-transparency note 1053, backend hints 991/995). Low contrast on the exact text that protects invariant 5 is the worst place to under-serve.

V1 SCOPE:
  1. Mechanical class remap in apps/web/src/App.tsx: every readable `text-ink-soft/70` → `text-ink-soft`, every readable `text-ink-soft/80` → `text-ink-soft` (full strength). 36 edits. The `/50` at line 1062 untouched. No layout/spacing/font/leading change — only the alpha suffix is dropped. (Note: lines 2237 & 2274 are `text-ink-soft/80` WITHOUT a font-mono prefix inside a parent that sets mono — same treatment, drop /80.)
  2. New pure module apps/web/src/lib/contrast.ts — the Node-testable proof that the chosen mapping clears AA (precedent: film-legend-style.ts as token SoT, totals-rows.ts as pure builder). Encodes the token hexes + the faded→accessible decision so a regression that re-introduces a faded readable class fails a unit test.
  No CSS/index.css change. No new @theme token (full ink-soft already exists and passes). No i18n change. No behavior change.

OUT OF SCOPE:
  - The film palette (film-soft #9fb0bd, film-mute #8593a0) over dark film bg — a SEPARATE contrast calc on a different surface; not part of this premise.
  - components/ (FilmViewer, TriageLedger, VerdictBar, etc.) — 0 faded-ink-soft instances; nothing to do.
  - The /50 disabled consent label (1062) and any genuinely-disabled/decorative state.
  - Re-theming, restructuring, font sizes, or "make text bigger" — that is a different change.
  - severity colors (crit/warn/ok/info) and the `ready ? text-ok : text-warn` line at 1021 — those are status colors, not ink-soft, untouched.

EXACT FILES / TOKENS:
  - apps/web/src/App.tsx — 36 class-string edits (suffix drop). No token added. Reuses existing `text-ink-soft` Tailwind class (maps to --color-ink-soft, index.css:9).
  - apps/web/src/lib/contrast.ts — NEW pure module (below).
  - apps/web/test/contrast.test.ts — NEW Vitest unit test (test dir is apps/web/test/, per totals-rows.test.ts).
  - No @theme token change. Justification for "no new token": full ink-soft passes 4.5:1 on both surfaces, so the accessible target already exists; adding a token would be dead weight.

PURE NODE-TESTABLE LOGIC (apps/web/src/lib/contrast.ts):
  // Token hexes mirrored from index.css @theme — the single SoT for the contrast proof.
  export const SURFACE = { bg: '#E7ECF1', panel: '#FFFFFF' } as const;
  export const INK_SOFT = '#566472';
  export function relLuminance(hex: string): number            // sRGB → linear → 0.2126/0.7152/0.0722
  export function contrastRatio(fg: string, bg: string): number // (Lmax+0.05)/(Lmin+0.05)
  export function compositeAlpha(fg: string, bg: string, a: number): string // straight-alpha over → hex
  export const AA_NORMAL = 4.5;
  // The decision the remap encodes: a readable ink-soft note must use FULL strength (alpha 1).
  export function accessibleInkSoftAlpha(): 1 { return 1; }
  // Convenience used by the test (and self-documenting): proves a given alpha passes on a surface.
  export function inkSoftPassesAA(alpha: number, surface: keyof typeof SURFACE): boolean {
    return contrastRatio(compositeAlpha(INK_SOFT, SURFACE[surface], alpha), SURFACE[surface]) >= AA_NORMAL;
  }
  All functions are deterministic, dependency-free, O(1). This is the same "lift the load-bearing arithmetic out of un-testable JSX" pattern as ledger-nav.ts / totals-rows.ts / film-legend-style.ts.

ARIA / KEYBOARD / REDUCED-MOTION / CONTRAST / COLOR-NOT-SOLE-SIGNAL:
  - Contrast: the whole change; readable notes go 2.84–3.86 → 5.10/6.07, clearing AA on both surfaces.
  - ARIA/keyboard: zero DOM/role/tabindex/aria change — no regression to the shipped focus-ring, ledger listbox nav, or aria-live regions (the role="status" note at 1308 stays text-ink, untouched).
  - Reduced-motion: no animation touched.
  - Color-not-sole-signal: unaffected; severity colors and the ok/warn status line keep their existing roles; this only raises luminance of neutral secondary text.

HONESTY / INSTANT-WOW / PERF-AT-SCALE / DETERMINISM:
  - Honesty: strictly improves — the disk≠VRAM and upload-transparency notes (the invariant-5/round12 copy) become legible. No values, labels, or claims change.
  - Instant-wow: zero impact on the analysis path; CSS-class-only, no JS on the hot path, no probe/worker touch.
  - Perf-at-scale: the edited nodes are all in the Pro/fix/receipt panels (NOT inside the virtualized TriageLedger rows); useWindow virtualization is not touched. Dropping an alpha suffix is free at any asset count.
  - Determinism: contrast.ts is pure float math on fixed hex literals → identical output every run; the test asserts exact threshold crossings.

EDGE CASES:
  - 0/1/1000+ assets: these panels are gated by Pro/fix state, independent of asset count; rendering identical, just higher-contrast text.
  - No-selection: unaffected (no ledger-selection-dependent ink-soft in scope).
  - Long i18n strings (9 langs): no width/height/leading/clamp change — same flow; longer DE/RU/HI strings wrap exactly as today, now more legible. No truncation added/removed (the `truncate` at 665/1048 stays).
  - The /50 disabled consent label: confirmed exempt, untouched — if it ever becomes ready it already flips to text-ink (line 1062 ternary), which passes.
  - Surface ambiguity: a couple of notes sit on bg-panel/60 or bg-bg; full ink-soft passes on BOTH pure surfaces (5.10 / 6.07), and any partial-panel tint only moves the effective bg toward white (higher contrast), so full strength is safe on every surface in scope.

TEST PLAN:
  PURE (apps/web/test/contrast.test.ts — Vitest/Node, the only harness available):
    1. relLuminance/contrastRatio sanity: ratio(#000,#fff) ≈ 21; ratio(x,x)=1.
    2. Pin the premise numbers (guards the math itself): contrastRatio(compositeAlpha(INK_SOFT,bg,0.7),bg) ≈ 2.84; (…,0.8,bg) ≈ 3.44; full ink-soft over bg ≈ 5.10, over panel ≈ 6.07 (toBeCloseTo, 2dp).
    3. The decision proof: inkSoftPassesAA(0.7,'bg')===false, inkSoftPassesAA(0.8,'bg')===false, inkSoftPassesAA(accessibleInkSoftAlpha(),'bg')===true AND ('panel')===true. This is the regression guard: it FAILS if anyone claims a <1 alpha is AA-safe for readable ink-soft.
    4. AA_NORMAL===4.5 (locks the correct threshold; not the 3:1 large-text one).
  WIRING / VISUAL (NOT Node-testable — apps/web has no React harness; explicit reasoning instead):
    - The 36 class edits are mechanical suffix-drops with no structural change; correctness is verified by `grep -nE "text-ink-soft/(70|80)" App.tsx` returning ONLY line 1062-adjacent /50 afterward (i.e. zero /70 or /80 remaining) — add this grep to the commit description as the manual gate. Mis-edits would surface as a TS/lint/build failure (`pnpm build` / `pnpm lint`).
    - Visual confirmation: `pnpm dev`, open a Pro panel, eyeball the notes darker; optionally spot-check one node in browser DevTools' contrast picker. Documented as the manual step since no component test harness exists (same limitation noted in totals-rows precedent).

ORDERED SMALL-COMMIT BREAKDOWN:
  1. feat(a11y): add pure contrast.ts (token hexes + WCAG ratio/composite + accessibleInkSoftAlpha/inkSoftPassesAA) — no UI wired yet.
  2. test(a11y): contrast.test.ts pinning the premise ratios + the pass/fail decision (4 cases above). Run `pnpm --filter web test` green.
  3. fix(a11y): remap all 36 readable text-ink-soft/{70,80} → text-ink-soft in App.tsx (suffix drop only); leave /50 at line 1062. Verify `grep -nE "text-ink-soft/(70|80)" App.tsx` is empty; `pnpm lint && pnpm build` clean.
  (Kept to 3 commits, one meaning each, per repo convention. contrast.ts lands before its consumer/test so each commit builds.)
