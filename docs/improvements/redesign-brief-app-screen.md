# Redesign brief (part 2) — the APP SCREEN, mockup-aligned, real data only

User (2026-07-04, ~01:42): a second mockup was added, `docs/improvements/redesign-mockup-app-screen.html`
(also scratchpad `mockup-app-screen.html`). It shows how the working app screen should look. Verbatim
intent: **"сделай так же как в Asset Doctor App.dc.html только используй наши реальные настройки и
информацию, но стиль элементов и всего остального возьми оттуда"** — take the ELEMENT STYLE from the
mockup, but fill it with our REAL settings and information. **This is queued for the ~6am tick (the armed
06:14 tick, b8d2eb98).** Do it AFTER the current tick work (dark theme + idle hero) lands.

Read this together with `redesign-brief.md` §0 (the non-negotiable bar: 5 invariants, honesty, a11y, i18n,
no new deps/network/fonts, pure Node-tested lib modules). Everything there still applies.

## The mockup, decoded (element style to adopt)

A persistent **left sidebar** shell (236px, sticky, white, right border) + a scrollable **main** area with
three screens toggled by the sidebar nav:
- **Sidebar**: logo + wordmark (top, bordered); nav buttons with inline icons — "Scan & results",
  "Settings", "Billing" — active = teal fill (`#0E8C8C`) white text, inactive = ink-soft transparent; a
  bottom "Current plan / Free / Upgrade →" card.
- **Scan & results screen**: a header row (green-dot eyebrow "Diagnosis complete · 0.9s · in-browser",
  h1 = folder name + "· N atlases · M sprites", right = "Recoverable −X%" stat + green "Download the fix"
  button); a **budget strip** of 4 cards (VRAM footprint MB / budget + bar; Draw calls / budget + bar;
  Disk size MB → fixed + bar; Findings count · N crit + stacked severity bar); a 2-col board (left dark
  lightbox viewer with filename+format badge, x-ray stage, scanline, heat-zone label, legend row
  Empty/Transparent pad/Packed; right white findings-list card: header "Findings, ranked by impact" +
  rows [severity dot, sev label, file, title, detail, saving] + "Show all N findings" footer).
- **Settings screen**: h1 + subtitle; white cards — Analysis (Platform target segmented, Preferred output
  format segmented, Empty-space threshold slider+%, Max useful texture size select); Budgets (VRAM budget
  MB + Draw-call budget number inputs); Toggles (Auto-convert to WebP / Strip metadata / Report orphaned
  assets switches); a green in-browser privacy line.
- **Billing screen**: h1 "Upgrade your plan" + subtitle; Monthly/Annual cycle toggle; plan cards
  (Pro/Studio radio-select with prices/features); order summary + **card-number/expiry/CVC form** + pay
  button + "Encrypted · cancel anytime".

Element vocabulary to reuse across the app: white rounded-14 cards with `#DCE3EA` borders; mono uppercase
`#0E8C8C` section eyebrows; segmented pill toggles (`#F4F7FA` track, teal-fill active); iOS-style switch
(`#15A06A` on / `#CBD5DE` off, white knob); `#F4F7FA` input fields with teal focus border; the dark
`#0C1116` lightbox for the viewer; mono for every number/metric/filename.

## Honest mapping — illustrative mockup value → REAL app source (invariant 3/4)

| Mockup element | Real source in the app (do NOT fabricate) |
| --- | --- |
| "slots_bundle/ · 7 atlases · 214 sprites" | Folder name from the picked files common-path prefix (add if not tracked); atlas count = `report.assets` of atlas kind; sprite count = Σ frames. All real. |
| "Diagnosis complete · 0.9s · in-browser" | Real: measure wall-clock of the analysis run (or drop the "0.9s" if not measured — never invent it). "in-browser" is true. |
| "Recoverable −43%" | `savedPct` (already computed) — the real potential-disk-saved percent. Never a fabricated number. |
| "Download the fix" | The real FixCard Pro path (gate-aware: free in beta). Keep the dry-run plan → execute flow. |
| Budget strip VRAM 210 / Draw 128 / Disk 84→48 / Findings 11·3crit | REAL: `totals.loadedVramBytes` (+ measured `probe.vramBytes` when probed), draw calls from the render-probe (probe-gated — omit when not probed, like the measured chip), `totals.diskBytes` → `potentialDiskSaved`, `index.tally` crit/warn/info. |
| "/ 160 budget", "/ 90 budget" + progress bars | Needs USER-SET budgets. The `packages/budget` core exists + the mockup Settings has VRAM/draw budget inputs. NEW FEATURE (phase it): (a) first ship the 4 metric cards WITHOUT the budget comparison (honest values only); (b) then add optional user budgets (persisted like view-prefs) + the "/ budget" bar. Never show a budget bar without a real user budget. |
| Findings list rows (file, title, detail, saving) | REAL findings from the analysis (localized via messageKey+params). Keep the app richer triage (severity filter, search, group, fold, type-hide) — adopt the mockup ROW STYLE, do not drop functionality. |
| Settings: Platform target / output format / empty-threshold / max-size / budgets / toggles | Map to REAL settings: output format + toggles already exist in BuildSettings/SettingsPage. Platform target + empty-space threshold slider + max-texture-size would make analysis thresholds user-tunable (aligns with the diagnosis-quality theme) — a real feature, phase it; do not fake a control that changes nothing. |
| Billing: Pro $19 / Studio $49, card-number/CVC form, "Pay" | **HONESTY BLOCKER.** The card form is non-functional theater and there is NO client-side charging (invariant 2: thin backend; gate OFF by default; not deployed). Do NOT build a fake credit-card capture. The honest "Billing"/Pro surface = the real `LicensePanel` (activate a license key, offline ed25519 entitlement) + gate-honest beta-free messaging (fix is free in beta). Pricing tiers may be shown as INFORMATION (matching the landing pricing, `PRO_GATE_ENABLED`-disciplined). Real Stripe checkout requires deployment (user-owned secrets) — link out only if/when deployed, otherwise omit the payment form. Prefer naming this nav item to reflect the real state (e.g. "Pro" / "License") rather than a checkout that cannot charge. |

## a11y that MUST survive the shell change (the sidebar is a big structural change)

- Skip-to-content stays the first tab stop; `<main id="ad-main">` stays the skip target + focus landing.
- Exactly ONE `<h1>` per screen; monotonic outline. NOTE: the mockup gives the results screen a VISIBLE h1
  (folder name + counts) — that is an improvement over today sr-only results h1, but re-check the heading
  order work (results-heading.ts) and the focus-move targets when you make it visible.
- The persistent `role=status` live region stays mounted as the first child of `<main>`.
- `focus-move` on screen swaps; reduced-motion gating on the scanline/reveal/animated bars/switch
  transitions; determinate progressbar unchanged.
- WCAG AA on every new surface in BOTH themes (the dark theme from this tick must cover the new sidebar +
  cards + segmented/switch controls — add their tokens to contrast.test.ts). The sidebar white/#F4F7FA
  surfaces must have dark-token equivalents.
- Sidebar nav = a real `<nav aria-label>` with the current screen marked `aria-current`. Segmented toggles
  and switches must be real accessible controls (radiogroup / switch role, keyboard-operable), not div soup
  (the mockup uses div+onClick — we must use proper semantics).

## Scope + phasing (this is multi-feature — do NOT try to land it in one commit)

1. **Shell**: sidebar-nav layout replacing the top-header nav (Scan/Settings/Pro), preserving all a11y +
   the header metrics moving into the results header. Dark-theme aware.
2. **Results header + viewer/findings re-skin**: the real header (folder/counts/recoverable/download) +
   the mockup card treatment over the existing TriageLedger + FilmViewer + Findings (keep functionality).
3. **Budget strip**: the 4 real-metric cards (phase 1 no budgets; phase 2 optional user budgets + bars).
4. **Settings re-skin**: the mockup card/segmented/switch STYLE over the existing SettingsPage knobs (+
   the theme switcher from this tick). Optionally surface analysis-threshold tuning as a real feature.
5. **Pro/Billing**: the honest LicensePanel-based surface (NO fake card form). Gate-honest.

Each is its own reviewed commit (design-skeptic → impl → adversarial-review → fix → gate → ff main). Keep
the current-tick dark-theme tokens as the foundation so every new surface is dark-ready from the start.
