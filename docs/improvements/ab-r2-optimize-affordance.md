# R2 First-class "optimize this folder" affordance on the results screen (no new engine) (PROCEED)

VERDICT: PROCEED. The premise is real and unaddressed (not churn). Evidence below is cited; the capability exists but is undiscoverable as a first-class "optimize/build the whole folder" path.

== PROBLEM (verified, cited) ==
The app is framed end-to-end as DIAGNOSIS, and the whole-folder optimize/build capability — which the engine already fully does (structure-preserving ExportProfile fan-out per AB gap analysis) — is reachable ONLY as a buried side-effect of the triage view:

1. Dropzone (the only pre-results surface) says nothing about optimizing/building/converting. apps/web/src/App.tsx:511-512 → dropzone.title = "Drop an asset folder to diagnose", dropzone.subtitle = "...Analysis runs locally — nothing leaves your device." Single CTA dropzone.open = "Open folder" (App.tsx:547-553). header.xray = "x-ray room" (App.tsx:509). No optimize/build/convert/export string exists anywhere pre-results (grep of en.json confirmed).
2. The ExportProfile config + every build knob live ONLY inside <FixCard>, which renders ONLY in the results <aside>, BELOW the FilmViewer + Findings list, after a full diagnosis (App.tsx:408; ExportProfilePanel at App.tsx:1994; it is the SOLE host of profileEnable — App.tsx:1505/1591). There is no pre-/during-diagnosis path to it.
3. FixCard self-framing reads as per-problem remediation, not "build my folder": pro.note = "Pro fix (repack + transcode) — Phase 2"; primary CTA fix.plan.cta = "Preview plan"; profile summary fix.profile.title = "Custom export variants". A user who wants "convert my whole folder to WebP/AVIF + _720p/_540p variants, same structure" gets zero signal this is possible.
This is the SINGLE pure-UX gap the AB analysis flagged. It is genuine: ~85% of plumbing exists; the missing 15% is discoverability/framing, not engine work.

== V1 SCOPE (one shippable slice) ==
A discoverable, honest "Optimize this folder" affordance on the RESULTS screen that:
(a) adds a clear entry label/anchor that names the capability as a first-class action (convert formats + scale variants + repack, same folder structure), and
(b) deep-links to / auto-expands the existing FixCard's ExportProfilePanel so the config + download path is one click from the diagnosis.
Concretely:
- A new "Optimize / build this folder" card-header strip ABOVE the existing FixCard controls (inside FixCard, replacing the bare pro.note line at App.tsx:1928 with a titled header), with a one-line honest sub-label: "Convert formats, emit scale variants, and repack — output mirrors your folder structure." This reuses the SAME fix engine; no over-claim.
- A small "Optimize whole folder →" anchor button in the results aside near analyzeAnother (App.tsx:409-415) that scrolls FixCard into view AND requests the profile section open. Implemented by lifting a tiny "intent" flag (see modules) so it does not couple to FixCard internals beyond an open-on-mount prop.
- The ExportProfilePanel <details> gains a controlled `open` prop driven by that intent so the deep-link actually reveals the config (today every panel is a default-collapsed <details>, so a deep-link that doesn't open it would dead-end).
- New i18n keys (x9 catalogs) for the header title, sub-label, and the anchor button.

== OUT OF SCOPE (explicit) ==
- NO new engine, mode, worker message, or fix.worker.ts change. Engine, plan/execute, zip, structure-preservation all untouched.
- NO pre-results / dropzone-time configuration. Instant-wow holds: diagnosis stays the unconfigured ≤10s default; config remains post-diagnosis (you still need the analysis to know what's in the folder). The dropzone copy MAY gain a single honest secondary line ("then optimize the whole folder") but NOT a config UI and NOT a second CTA that delays the ≤10s payoff — keep it to a subtitle clause only (low-risk, optional task T6, can be dropped if it muddies the hero).
- NO change to which ops run, defaults, or byte-output. Absent the new intent flag, behavior is byte-identical (the flag only controls a <details open> and a scroll).
- NO new ExportProfile semantics; no "build everything" auto-enable. The user still opts into the profile (invariant 3: we never silently reorganize/transcode).
- NO ProfileOverride / tier / pack logic changes.

== ADDITIVE CONTRACT / TYPE CHANGES ==
None to packages/core or any cross-package contract. This is a pure apps/web presentation slice. The only new "type" is a local prop:
- ExportProfilePanel gains `open?: boolean` + `onToggleOpen?: () => void` (controlled <details>). Absent ⇒ uncontrolled default-collapsed (today's behavior, byte-identical render).
- FixCard gains internal state `profilePanelOpen` (default false) and an imperative ref/anchor id. No new exported types.

== PURE MODULES + SIGNATURES (Node-testable; apps/web has no React harness) ==
Create apps/web/src/lib/optimize-entry.ts (pure, zero-React, zero-DOM):
- export interface OptimizeEntryCopy { titleKey: string; subKey: string; anchorKey: string }
- export const OPTIMIZE_ENTRY: OptimizeEntryCopy = { titleKey: 'optimize.title', subKey: 'optimize.sub', anchorKey: 'optimize.anchor' } — single source of truth for the three keys, so a test can assert they exist in all 9 catalogs (mirrors the existing FORMAT_KEYS/OVERRIDE_MODE_KEYS pattern in App.tsx).
- export function optimizeEntryEnabled(fileCount: number, profileSupported: boolean): boolean — returns fileCount > 0 (the anchor/deep-link is inert with no files). profileSupported reserved for a future capability check; pass true today. Pure ⇒ Node-testable; encodes the only decision logic so the "show the anchor?" rule is not embedded in JSX.
- export const PROFILE_PANEL_ANCHOR = 'ad-export-profile' — the DOM id the anchor scrolls to (constant shared by the button's scrollIntoView and the panel's id attribute, so they can't drift).

== WORKER / UI / BACKEND CHANGES ==
- Worker: NONE.
- Backend: NONE (invariants 1-2 untouched; this is browser-only presentation).
- UI (apps/web/src/App.tsx, additive only):
  1. FixCard: replace the bare pro.note <p> at App.tsx:1928 with a titled header block (optimize.title + optimize.sub) above the existing controls; keep pro.note as the small Phase-2 sub-note. (CSS additive, token-driven: font-display title, font-mono sub-label, text-ink/text-ink-soft, teal accent — reuse existing token classes; no new tokens.)
  2. FixCard: add `const [profilePanelOpen, setProfilePanelOpen] = useState(false)`; pass open={profilePanelOpen} onToggleOpen={() => setProfilePanelOpen(v=>!v)} to ExportProfilePanel; give the panel's root <details> id={PROFILE_PANEL_ANCHOR} and a controlled open.
  3. Results aside (App.tsx ~409): add an "Optimize whole folder →" button (gated by optimizeEntryEnabled(files.length, true)) that setProfilePanelOpen(true) via a lifted callback AND document.getElementById(PROFILE_PANEL_ANCHOR)?.scrollIntoView({behavior:'smooth'}). Because FixCard owns profilePanelOpen, either (a) lift profilePanelOpen to App and thread a setter into both FixCard and the aside button, or (b) keep it in FixCard and expose an imperative handle/forwardRef. Prefer (a) — a single boolean lifted to App is simplest and keeps FixCard a pure consumer; the button lives in the same aside that already renders <FixCard files={files}/>.
  4. ExportProfilePanel signature (App.tsx:1194): make the outer <details> controlled — <details open={open ?? undefined} onToggle handler calling onToggleOpen> with id from PROFILE_PANEL_ANCHOR. Guard: only switch to controlled when open!==undefined so the default (uncontrolled) render stays byte-identical.

== HONESTY + INVARIANT COMPLIANCE ==
- Invariant 3 (objectivity, no over-claim): copy says EXACTLY what the engine does — "convert formats, emit scale variants, repack; output mirrors your folder structure." No "builds your game", no implied analysis/generation. The header explicitly remains the SAME Pro fix engine (pro.note Phase-2 sub-note retained). No new claim about VRAM/savings.
- Invariant 4 (instant-wow): the diagnosis path is UNTOUCHED — no config gate added before the ≤10s result. The affordance appears only AFTER diagnosis, exactly where FixCard already lives. The optional dropzone subtitle clause adds no CTA and no delay.
- Invariants 1-2 (privacy/thin backend): no network, no backend, no asset movement. Pure local DOM affordance.
- Invariant 5 (disk≠VRAM): no new metric/number is introduced; existing honest receipt copy is unchanged.

== DETERMINISM ==
optimizeEntryEnabled is a pure boolean of (fileCount, profileSupported). The copy keys are a frozen constant. scrollIntoView/open are idempotent UI effects with no data dependence. No randomness, no ordering concerns.

== EDGE CASES ==
- files.length === 0 (folder moved/empty): optimizeEntryEnabled false ⇒ anchor hidden; FixCard run/preview already disabled (App.tsx:2072,2081). Consistent.
- Deep-link with profile panel already open: onToggleOpen no-ops to open (idempotent set true). No flicker (controlled value already true).
- User manually collapses the panel after deep-link: onToggleOpen keeps state in sync (controlled <details onToggle>). Must wire onToggle so native disclosure clicks update the lifted state, else it desyncs (test the handler contract).
- Pro gate ON + locked (PRO_GATE_ENABLED && !unlocked, App.tsx:1917): FixCard returns the ActivatePanel early — the optimize header must render in BOTH branches (or the aside anchor should still scroll to the card, which shows activation). Put the titled header inside the returned card in both branches, OR keep header in the always-rendered card shell. Decision: render the header in the unlocked branch only; the aside anchor still scrolls to the locked card (activation) honestly — no false promise.
- Stale-plan reset (App.tsx:1903-1905): profilePanelOpen is presentation-only and is NOT in that deps array, so toggling it must NOT invalidate a shown plan. Verify it's excluded (it is, since it's new state not added to the dep list).
- i18n: a missing key in any of the 8 non-en catalogs fails catalogs.test.ts:21 (key-set equality). All 3 new keys MUST land in all 9 files with no placeholder tokens (these are static strings ⇒ no {tokens} ⇒ trivially placeholder-parity).

== TEST PLAN (real; pure Node where possible) ==
Pure (vitest, no React):
1. apps/web/src/lib/optimize-entry.test.ts: optimizeEntryEnabled(0,true)===false; (3,true)===true; (3,false)===true (profileSupported reserved, doesn't gate today) — pin the contract so a future capability gate is a deliberate change.
2. i18n presence test (extend packages/i18n/test/catalogs.test.ts OR a new apps/web test importing OPTIMIZE_ENTRY): for each of LOCALES, assert CATALOGS[loc] has optimize.title/optimize.sub/optimize.anchor as non-empty strings, and translate(loc, key) contains no '{' (static ⇒ guaranteed, but pin it). This rides the existing drift-guard pattern (catalogs.test.ts:133-139 precedent for "key exists in all 9").
3. Constant-wiring test: assert PROFILE_PANEL_ANCHOR is the SAME constant referenced by both the scroll target and the panel id (import the constant in both sites; a test can assert OPTIMIZE_ENTRY keys match the catalog and that PROFILE_PANEL_ANCHOR is a stable non-empty string).
Unverifiable-visual (explicit reasoning, manual via /run or Playwright-later):
4. The <details open> controlled behavior + scrollIntoView are DOM/visual; apps/web has no React harness (confirmed) so these are NOT unit-tested. Mitigation: the DECISION logic (when to show, which keys, which anchor) is fully extracted into the pure module above and IS tested; the residual is a thin, low-risk JSX wiring of a boolean to a native <details open> + a one-line scrollIntoView, verifiable by `pnpm dev` smoke (click anchor → panel opens + scrolls). State this in the PR as the one visual-only seam.
5. Build/typecheck gate: pnpm typecheck + pnpm build must pass (the controlled-details prop change is the only type surface).

== ORDERED SMALL-COMMIT TASK BREAKDOWN ==
T1 (pure core): add apps/web/src/lib/optimize-entry.ts (OPTIMIZE_ENTRY, optimizeEntryEnabled, PROFILE_PANEL_ANCHOR) + optimize-entry.test.ts. Commit: "feat(web): pure optimize-entry decision module + copy keys".
T2 (i18n): add optimize.title/optimize.sub/optimize.anchor to all 9 catalogs (en source first; honest copy: title "Optimize this folder", sub "Convert formats, emit scale variants, and repack — output keeps your folder structure.", anchor "Optimize whole folder →"); run catalogs.test.ts green. Commit: "i18n(x9): optimize-entry strings".
T3 (panel deep-link): make ExportProfilePanel <details> controllable (open?/onToggleOpen?, id=PROFILE_PANEL_ANCHOR) — default-undefined keeps today's render. Commit: "feat(web): controllable export-profile panel for deep-link".
T4 (FixCard header + lifted open): replace bare pro.note line with titled header (optimize.title/sub) and thread profilePanelOpen (lifted to App or local+forwardRef per decision a). Commit: "feat(web): first-class optimize header in FixCard".
T5 (aside anchor): add the gated "Optimize whole folder →" button in the results aside that opens the panel + scrolls. Commit: "feat(web): results-aside optimize anchor".
T6 (optional, droppable): one honest secondary subtitle clause in the dropzone (no CTA, no delay). Commit: "copy(web): dropzone names the optimize path". Drop if it dilutes the diagnosis hero.
Each commit is independently shippable; T1-T2 are pure/tested, T3-T5 are additive UI, T6 is optional copy.