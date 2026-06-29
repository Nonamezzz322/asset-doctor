# Wire profile-global knobs + AVIF subsample picker (effort / scaleAwareQuality / pngRecompressLevel / avifQualityAlpha / avifSubsample) (PROCEED)

VERDICT: PROCEED. Premise verified true. The asset-builder "raw -> configure -> structured output" flow is ~85% already shipped on the ExportProfile fix path (engine iterates all merged refs, re-derives packing from raw, mirrors the input tree via zip). The named first slice is a real, contained wiring gap, NOT a from-scratch build.

== PROBLEM (verified, cited) ==
The ExportProfile data contract ALREADY declares five profile-global encode knobs: `effort`, `pngRecompressLevel`, `avifSubsample`, `avifQualityAlpha`, `scaleAwareQuality` (packages/core/src/index.ts:189-198). The worker ALREADY reads them: apps/web/src/worker/fix.worker.ts:532-536 folds `opts.exportProfile?.effort/scaleAwareQuality/avifQualityAlpha/avifSubsample/pngRecompressLevel` into the FormatEncodeGlobal. The pure mapper ALREADY forwards them: packages/fix/src/settings.ts formatEncode() stamps `global.effort`(168/182/192), `global.avifSubsample`(195), `global.avifQualityAlpha`(194), `global.pngRecompressLevel`(170) into the per-target FormatEncode. The worker's feToEncodeOpts (fix.worker.ts:723-731) carries them to encodeCanvas, and encodeCanvas's AVIF branch passes `subsample` to @jsquash/avif (fix.worker.ts:4324: `...(opts.avifSubsample != null ? { subsample: opts.avifSubsample } : {})`).

The GAP: the App.tsx exportProfile memo (apps/web/src/App.tsx:1559-1583) NEVER populates any profile-global knob. It returns only `{ formats, tiers, ...(overrides?) }` (line 1582). So `avifSubsample`/`effort`/etc. on the TOP-LEVEL profile are permanently `undefined` from the UI. The only way subsample reaches the encoder today is via the fonts444 OVERRIDE preset (App.tsx:1577) — there is no profile-wide picker. The protocol confirms this was a deliberate deferral: fix-protocol.ts:43-44 says of avifSubsample "FIELD ships; UI toggle GATED until Task 14 verifies 0/1/2 mapping (3=YUV444 is already confirmed in @jsquash encode.js)". This slice IS Task 14.

A second, smaller verified gap: validateProfile (packages/fix/src/scale.ts:187-223) validates OVERRIDE-level `o.avifSubsample`/`o.effort` (lines 210-215) but NEVER validates the PROFILE-GLOBAL `p.avifSubsample`/`p.effort`/`p.pngRecompressLevel`/`p.avifQualityAlpha` (grep for `p.avifSubsample` in scale.ts returns nothing). A bad global subsample would slip straight to the codec. The slice must close this fail-closed hole.

NOTE on disconnect: today's SettingsPanel `effort`/`scaleAwareQ`/`pngRecompress` toggles (App.tsx:1414-1417, UI at 686-702) feed the LEGACY (profile-OFF) path via buildOptions:1651-1656 only. The CLAUDE-style comment at App.tsx:1150-1151 CLAIMS "effort/scaleAwareQuality knobs ... are folded into the profile's global knobs" — this is currently FALSE for the profile path (the memo ignores them). The slice makes the comment true.

== V1 SCOPE ==
1. App.tsx exportProfile memo (1559-1583): add profile-global knobs to the returned ExportProfile, sourced from the EXISTING SettingsPanel state — `effort` (>0 ⇒ set, else omit), `scaleAwareQuality` (true ⇒ set, else omit), `pngRecompressLevel` (pngRecompress ⇒ 2, else omit) — so a profile run honors the same encode knobs as the legacy path (single source of truth, kills the false comment). Add the memo deps (effort, scaleAwareQ, pngRecompress) — they are ALREADY in buildOptions deps (1860) so no new state.
2. NEW avifSubsample picker in ExportProfilePanel (App.tsx:1238-1393 body): a small select shown only when AVIF is enabled — options {default(omit), 4:4:4(=3), 4:2:2(=1), 4:2:0(=0)} mapping to the @jsquash subsample integers. New state `profileAvifSubsample: number | undefined` (default undefined ⇒ omit ⇒ byte-identical). Memo sets `avifSubsample` on the profile when defined. (4:4:0=2 omitted from picker — rare, keep the verified 0/1/3 set per protocol note; document 2 as a follow-up.)
3. validateProfile (scale.ts): validate the four profile-GLOBAL numeric knobs with the SAME bounds already used for overrides (effort [0,6]; avifSubsample integer; pngRecompressLevel [0,6]; avifQualityAlpha [-1,100] or [0,100]). Reuse the existing error-string style.
4. i18n: add `fix.profile.avifSubsample` (label) + four option labels to all 9 catalogs (en is source); the i18n-app-keys test (apps/web/test/i18n-app-keys.test.ts) and catalogs drift test (packages/i18n/test/catalogs.test.ts) enforce parity.

== OUT OF SCOPE / DEFERRED ==
- avifQualityAlpha UI picker (field already wired worker-side; defer to a later slice — keep state plumbing only if trivial, else omit entirely). The memo CAN still pass it through if a future picker sets it; v1 leaves it undefined.
- 4:4:0 (subsample=2) option (protocol says 0/1/2 mapping unverified beyond 3; ship 0/1/3, note 2 as follow-up).
- Entry framing / dedicated "Asset Builder" UI route (the one REAL gap (d) flagged in context — UX-only, App.tsx:360/408). Not this slice.
- PixiJS manifest, content-hash, KTX2 backend — already shipped or separate slices.
- Per-tier or per-override global-knob granularity (settings.ts:102-103 explicitly keeps scaleAwareQuality/avifQualityAlpha/pngRecompressLevel profile-global in v1).

== ADDITIVE CONTRACT / TYPE CHANGES ==
ZERO core type changes — ExportProfile already has every field (core:184-203). This is the whole point: the contract was built ahead of the UI. Absent ⇒ byte-identical is already the documented invariant on each field ("Omit ⇒ ..."). The only NEW types are App-local UI state (a `number | undefined` for the subsample picker) — not a cross-package contract, so no `core` coordination needed.

== PURE MODULES + SIGNATURES ==
The structure-preserving path mapping the request demands ALREADY EXISTS and is pure/Node-testable:
- `tieredName(stem, suffix, mime?)` (scale.ts, tested scale.test.ts:62-82) — inserts the resolution suffix before the ext, swaps ext for a transcoded mime. THIS is the output path construction; it preserves the slash-bearing relative stem (the dir tree) and only touches the basename. No change needed.
- `formatEncode(fmt, scale, global): FormatEncode` (settings.ts:150) — already maps a FormatTarget + the global knobs to encode params. No change.
- `validateProfile(p): ProfileValidation` (scale.ts:187) — EXTEND with global-knob validation (the only pure change). New internal guard, e.g. a `validateGlobals(p, errors)` helper mirroring the override loop at 210-215.
The tree-mirroring itself is the worker keying by `keyOf(f)` (dir-aware ingest key) + zip.ts writing each emitted ref at its keyed path — already structure-preserving; the engine re-derives packing from raw (ingest:194) and iterates all merged refs (fix.worker.ts:3506,3146). No new path module is required for THIS slice.

== WORKER / UI / BACKEND CHANGES ==
- WORKER: NONE. fix.worker.ts:532-536 + 723-731 + 4324 already consume every knob. This slice writes ZERO worker code — the wiring is already there, only starved of input. (Strong evidence the premise is true.)
- UI: App.tsx memo (1559-1583) gains 3-4 fields + the picker JSX in ExportProfilePanel + one new useState. ~25 lines.
- PURE: scale.ts validateProfile global-knob guard. ~15 lines.
- i18n: 5 keys × 9 catalogs.
- BACKEND: NONE (AVIF subsample is a 100% in-browser @jsquash encode — invariant 1 holds, nothing leaves the device).

== HONESTY + INVARIANT COMPLIANCE ==
- Invariant 1 (browser-first): AVIF subsample/effort/scaleAwareQuality are all OffscreenCanvas + @jsquash WASM — zero network. pngRecompressLevel = @jsquash/oxipng, also local. No bytes leave the device. (pngLossy/pngquant is the only backend knob and is NOT in this slice.)
- Invariant 3 (objective): these are encode PARAMETERS the user chooses, not generated content; we measure the resulting bytes in the receipt. Subsample 4:4:4 vs 4:2:0 is an explicit user trade, surfaced honestly (no "sharper" verdict).
- Invariant 5 (disk≠VRAM): every knob here is DISK-only (chroma subsample/effort/oxipng change file bytes; the GPU still decodes RGBA8888). The existing fix.profile.diskNote (en.json:453) already states this; the picker inherits it. NO VRAM claim is added.
- No faked output: validateProfile fail-closed already rejects lossless-avif (scale.ts:180); the new global-knob guard extends fail-closed to bad subsample/effort so a known-bad profile is never sent (matching the existing override guard).

== DETERMINISM ==
formatEncode and validateProfile are already pure (no Date/random — settings.ts:148). The picker maps to a fixed integer; encodeCanvas's subsample pass-through is deterministic. Re-emitting an identical profile is byte-identical (scale.test.ts:217 already asserts this for tiers). The new memo fields are derived from React state only.

== EDGE CASES ==
- Nested dirs: handled by keyOf/tieredName preserving the slash-bearing stem (unchanged).
- Name collisions across formats/tiers: validateProfile's dupTarget guard (scale.ts:157-169) already catches same-byte targets; subsample is part of the AVIF encode but two AVIF targets differing ONLY by global subsample is impossible (subsample is profile-global, not per-target) — so no new collision class. Confirm the dup-key (`avif|q85`) is unaffected (it is — global knob, one value).
- Mixed asset types: profile fan-out governs LOOSE/transcode/tier paths only; repack/merge sheets + Spine pages keep runtime-safe formats (core:181-183) — subsample never corrupts a sheet. Verified the worker gates this.
- Scale suffixes: untouched; scaleAwareQuality now folded so downscaled AVIF tiers get the lower-q + chosen subsample consistently (formatEncode:156).
- AVIF disabled but subsample set: picker is AVIF-gated in UI; defensively, formatEncode only stamps avifSubsample on AVIF targets (settings.ts:188-196), so a stray value on a webp/png profile is inert.
- Subsample on the fonts444 OVERRIDE vs the new global: override later-wins merge already handles `o.avifSubsample ?? global.avifSubsample` (settings.ts:282) — the global is the base, the override overlays. No conflict.

== TEST PLAN (real) ==
Pure unit (extend packages/fix/test/scale.test.ts, reusing its validateProfile/validateTiers patterns at lines 83-142):
1. validateProfile accepts a profile with valid global avifSubsample (0/1/3), effort 0-6, pngRecompressLevel 0-6.
2. validateProfile REJECTS global avifSubsample non-integer (3.5), effort 7, pngRecompressLevel -1, avifQualityAlpha 101 — assert the error strings (fail-closed). These are the NEW guards — currently NO test exercises global-knob bounds (only override bounds via override[i]).
3. formatEncode (settings.test.ts) already covers global.avifSubsample forwarding onto AVIF and NOT onto webp/png — reuse/confirm (settings.ts:188-196); add a case asserting global effort reaches all three targets.
4. export-profile-fanout.test.ts (existing) — add an assertion that a profile carrying avifSubsample produces FormatEncode.avifSubsample on its AVIF fan-out entries (end-to-end pure proof the knob survives the resolver).
5. i18n: apps/web/test/i18n-app-keys.test.ts auto-catches the 5 new t() keys if uncatalogued; packages/i18n/test/catalogs.test.ts auto-catches locale drift. Run both.
UNVERIFIABLE-BY-UNIT (explicit reasoning): the actual VISUAL/byte effect of subsample=3 vs 0 inside @jsquash is a WASM codec behavior — NOT unit-testable in Node without the codec, and out of our determinism contract. We assert only that the integer is PASSED THROUGH correctly (encodeCanvas:4324 spread); the protocol note (fix-protocol.ts:43) already records that 3=YUV444 is confirmed in @jsquash encode.js. Manual smoke: enable profile + AVIF + 4:4:4 on fixtures/sample-projects, run fix, confirm a non-empty .avif emits and the receipt shows a byte delta (no automated visual diff — visual quality is a user trade, invariant 3). No new worker test needed (the worker path is unchanged; existing plan-worker/best-format-worker tests still cover the option-bag flow).

== ORDERED SMALL-COMMIT BREAKDOWN ==
C1 (pure, test-first): scale.ts validateProfile — add global-knob fail-closed validation (avifSubsample integer; effort/pngRecompressLevel [0,6]; avifQualityAlpha bound) + tests in scale.test.ts. Self-contained, no UI.
C2 (pure): settings.test.ts / export-profile-fanout.test.ts — add the global-effort + avifSubsample fan-out assertions (proves the already-wired path before touching UI).
C3 (UI wiring): App.tsx exportProfile memo (1559-1583) — fold effort/scaleAwareQuality/pngRecompressLevel from existing SettingsPanel state into the returned profile (omit-when-default ⇒ byte-identical); add deps. Fixes the false comment at 1150-1151.
C4 (UI feature): App.tsx — new profileAvifSubsample state + AVIF-gated picker in ExportProfilePanel; memo sets profile.avifSubsample when defined.
C5 (i18n): add fix.profile.avifSubsample + 4 option labels to en.json, then propagate to the other 8 catalogs; run i18n-app-keys + catalogs drift tests.
C6: pnpm typecheck + pnpm test (fix + web + i18n) green; manual smoke per test plan.

KEY FILE PATHS:
- /home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx (memo 1559-1583; panel 1194-1396; state 1481-1491)
- /home/nonamezzz/Рабочий стол/projects/packages/fix/src/settings.ts (formatEncode 150-197; globals 102-126)
- /home/nonamezzz/Рабочий стол/projects/packages/fix/src/scale.ts (validateProfile 187-223 — EXTEND)
- /home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix.worker.ts (consumes 532-536, 723-731, 4324 — UNCHANGED)
- /home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix-protocol.ts:43-45 (the GATED note — this slice ungates)
- /home/nonamezzz/Рабочий стол/projects/packages/core/src/index.ts:184-231 (ExportProfile — UNCHANGED)
- /home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/*.json (5 new keys)
- /home/nonamezzz/Рабочий стол/projects/packages/fix/test/scale.test.ts, settings.test.ts, export-profile-fanout.test.ts (extend)