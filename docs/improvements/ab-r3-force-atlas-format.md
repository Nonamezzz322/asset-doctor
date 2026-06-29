# R3 Force the chosen format on prebuilt atlases under a format-only export profile (close the last findings-gated residual) (PROCEED)

## Premise verification (cited, against the REAL code)

The audit's claim "loose-image fan-out + Spine packing are already NOT findings-gated" is MOSTLY correct, but there is ONE precise residual gate. I traced every emission path.

**The only source of FixOps is findings-driven.** `planFix` (packages/fix/src/plan.ts:157-432) iterates `report.findings` EXCLUSIVELY — every op (repack/resize/transcode/pack/drop) is keyed off a finding. No finding ⇒ no op. This is by design.

**The worker has TWO findings-INDEPENDENT drivers that iterate all of `merged`:**
1. The scale-tier multiplier loop, fix.worker.ts:3146 `for (const a of merged)` — tiers EVERY eligible asset (loose AND prebuilt atlas, via `atlas = atlasByRef.get(ref)` + `scaleAtlas`, the per-format encode at :3258-3275/:3358-3413), regardless of findings. Entered iff `tieringOn` (fix.worker.ts:557).
2. The FORMAT-ONLY EXPORT-PROFILE PASS, fix.worker.ts:3506-3540 `for (const a of merged)` — fans EVERY eligible LOOSE image across the profile formats, independent of findings. Its own comment (:3493-3496) documents that it exists precisely to close the silent-no-op gap for loose images.

**Result of the trace, by asset class:**
- Loose images, ANY profile: FULLY FORCED (multi-tier → loop #1; format-only → loop #2). NO gap.
- Prebuilt atlases, MULTI-tier profile (`profileTiers` has `scale<1`): FULLY FORCED — loop #1 re-encodes each page to each profile format (fix.worker.ts:3258-3275, single-format keeps legacy `_suffix.json`). NO gap.
- **Prebuilt atlases, FORMAT-ONLY profile (single scale-1 tier ⇒ `profileHasLowerTier=false` ⇒ `tieringOn=false`, fix.worker.ts:551-557): RESIDUAL GAP.** The tier loop is not entered, and the format-only pass explicitly skips atlases (fix.worker.ts:3508 `if (a.kind !== 'image') continue;`). The atlas page is transcoded to the profile format ONLY via the prebuilt-atlas passthrough transcode (fix.worker.ts:2414-2554), which fires ONLY when a `transcode` op exists — i.e. ONLY when the page earned a `format` finding. And `formatFinding` returns `null` for AVIF sources (rules.ts:771) and for any page whose best re-encode saves less than `cfg.formatSaving.warn` (rules.ts:781).

**Concrete failure the user hits:** pick "AVIF, single tier" expecting all prebuilt TexturePacker/Pixi sheets converted to AVIF. Sheets that save enough → AVIF (finding fired). Sheets already AVIF, or near-optimal (sub-threshold), or a format whose AVIF isn't smaller → passed through VERBATIM in their original format (fix.worker.ts:3573-3600). The explicit "export everything as AVIF" request silently produces a mixed-format folder. This matches the user's R3 ask exactly ("get finished spritesheets for EVERYTHING per config, not only assets the diagnosis flagged").

This is a DOCUMENTED v1 scope decision (docs/improvements/round7-export-profile.md:229, §5d-bis: "atlas pages (loose-only scope...)"), NOT an oversight — but it is a real, contained residual the user is now asking to lift for the single-format case.

## v1 scope (one shippable slice)
Add a worker driver that, for a SINGLE-format format-only profile, forces the chosen format onto EVERY eligible prebuilt atlas page that no prior op/transform claimed — reusing the existing prebuilt-atlas passthrough transcode machinery verbatim. Scope deliberately limited to SINGLE-format profiles (the safe case where the existing :2460 multi-format atlas guard already says "atlas pages stay single-format"): one page in one format, sidecar repointed, old page dropped, no dangling N-variant problem.

Honesty preserved: the existing keep-original-on-size-loss guard (fix.worker.ts:2478-2486) stays — if the forced format is LARGER than the source, keep the original page and surface an honest skip (never ship a worse file under a fix banner; invariant 3/5). The receipt's `exportProfile.assets` count grows to include forced atlases; disk delta is the real measured before/after; identical pixel dims ⇒ NO VRAM claim (fix.worker.ts:2550, invariant 5).

## Out of scope (defer)
- MULTI-format atlas fan-out (one page across N sidecar entries) — already gated off at fix.worker.ts:2460; keep that guard.
- Multi-tier profiles — already force atlases (loop #1); untouched.
- Spine multi-page atlases — already refused (fix.worker.ts:2450-2456); keep refused with the existing skip.
- Repacked/merged/dedup-owned atlases — already claimed (`replaced`/`dropped`); the new driver must respect those sets and skip them (loop #2's exact discipline).
- Loose images — already forced; untouched.

## Additive contract/type changes
NONE required. The receipt field `exportProfile: { formats, tiers, assets, filesEmitted }` (apps/web/src/worker/fix-protocol.ts:401) already exists and already counts `profileAssets`/`profileFilesEmitted`; forced atlases will naturally increment those existing counters. No core type change ⇒ absent-profile path stays byte-identical by construction.

## Pure modules + signatures (Node-testable)
No NEW pure module is strictly needed — the per-page transcode is inherently pixel/OffscreenCanvas work (no Node harness exists, per round7-export-profile.md B2). BUT extract the eligibility DECISION into a pure predicate so it CAN be Node-tested (mirroring the existing `tierRefusal`/`fanoutDecision` discipline):

In packages/fix/src/ add `atlasProfileForce.ts`:
- `export function atlasNeedsForcedFormat(args: { sourceMime: ImageMime; targetMime: ImageMime; isMultiFormat: boolean; isSpineMultiPage: boolean; hasSidecar: boolean; alreadyClaimed: boolean }): { force: boolean; skipReason?: string }` — pure, returns force=false (with a reason when it would otherwise want to but can't) when: multi-format profile, multi-page Spine, no sidecar, already claimed, or `sourceMime === targetMime` (no-op). Deterministic, total. This is the SAME branch logic currently inline at fix.worker.ts:2425-2464, lifted so the worker calls it and a Node test pins every gate.

## Worker changes (apps/web/src/worker/fix.worker.ts)
Add a block immediately AFTER the format-only loose pass (after line 3540), gated identically `if (profileOn && !profileHasLowerTier && !profileMulti)`:
- `for (const a of merged)` where `a.kind === 'atlas'`; resolve `ref`, `path = pathByRef.get(ref)`.
- Skip if `replaced.has(path) || dropped.has(path) || profileOwned.has(ref)` (a finding-driven passthrough transcode already ran, or a repack/merge/dedup claimed it) — the same guards loop #2 uses.
- Compute the profile's single target mime via `resolveProfile(ref).formats[0].format`. Call `atlasNeedsForcedFormat(...)`; on `force:false` push the returned `skipReason` to `skipped[]` (honest) and continue.
- On `force:true`, invoke the EXISTING prebuilt-atlas passthrough transcode code (fix.worker.ts:2466-2554) — factor that body into a local `forceAtlasFormat(ref, atlasOfRef, path, sidecar, targetMime)` helper shared by both the op handler at :2426 and this new driver, so there is ONE implementation (no drift). It already: encodes via `transcode`, keeps-original-on-size-loss (:2478), renames the page (`renamedTo`), repoints the sidecar (`repointAtlasImage` + `emitTexturePackerJson`/`emitSpineAtlasText`), drops the old page (`replaced.add`), sets `referencesChanged`, records the variant, the change rows, the KTX2 candidate, and the operations line.
- Increment `profileAssets++` / `profileFilesEmitted++` and `profileOwned.add(ref)` on a successful force, so the receipt counts it and Phase-A/C owner bookkeeping (predictOwnerFinalNames, :1236) stays correct (this ref now actually transcodes — mirror the loose path's ownerActualName update).

CRITICAL ordering: this driver must run BEFORE the pass-through loop (:3573) so the forced page's old path is in `dropped`/`replaced` and the pass-through doesn't also ship the original. It already would (it runs at :3540, pass-through at :3573).

Owner prediction (fix.worker.ts:1257-1262): an atlas that is a dedup OWNER and is force-transcoded must be predicted as transcoded. Today predictOwnerFinalNames keys on whether a transcode OP exists; a forced atlas has no op. Extend the lookup callback so a single-format format-only profile predicts the owner atlas's final image as `renamedTo(path, profile.formats[0].format)` when this new driver would force it (and the size-loss guard wouldn't bail — predict conservatively as transcoded; if execute bails on size-loss it already sets ownerActualName back to original at :2587-equivalent, and Phase C keeps the consumer — the existing divergence-safe path). This is the one subtle interaction; the existing K8/divergence machinery already handles "predicted transcoded but execute kept original" by keeping the consumer.

## UI/backend changes
NONE. No new toggle — this is the natural meaning of an already-shipped single-format export profile. No backend touch (browser-only, invariant 1/2 intact). Optionally one new i18n key for the new skip reasons (`fix.profile.atlasForcedKept` / reuse the existing transcode-kept-original phrasing) across the 9 catalogs with the drift guard — but the skip strings can also reuse the existing atlas-transcode skip reasons already in en.json, minimizing i18n surface.

## Honesty + invariant compliance
- Inv 1/2: 100% browser, no backend, no network. Untouched.
- Inv 3 (measure, never fabricate): the page is REALLY re-encoded; the keep-original-on-size-loss guard means we never ship a larger file claimed as a fix; every refusal is a surfaced `skipped[]` note, never silent.
- Inv 5 (disk≠VRAM): identical pixel dims ⇒ identical RGBA8888 ⇒ NO vramSaved increment (the existing passthrough already does this, :2550). The receipt's exportProfile.assets is a DISK file count, not a saving.

## Determinism
`merged` is a stable order; `resolveProfile(ref).formats[0]` is deterministic; the encode is deterministic given the codec. Output paths via `renamedTo` + `hashEmit` are content-addressed and stable. Set-membership guards are order-free.

## Edge cases
- AVIF source + AVIF profile target ⇒ `sourceMime === targetMime` ⇒ atlasNeedsForcedFormat returns force=false (no-op), no skip noise.
- Forced format larger than source ⇒ keep original page + honest skip (existing guard).
- Atlas with no sidecar (rare parsed-atlas) ⇒ skip with the existing "sidecar unavailable" reason (re-encoding would dangle the manifest).
- Multi-page Spine ⇒ refused (existing reason at :2450).
- Atlas carrying a mesh ⇒ the passthrough is VERBATIM (no recompose), mesh geometry untouched — safe (the comment at :2417 confirms frame/mesh untouched), so meshed atlases CAN be force-transcoded (unlike tiering which drops mesh). No new gate needed.
- Multipack `related_multi_packs` under hashOn ⇒ existing strip + skip note (:2503).
- Hashing on/off ⇒ existing hashEmit chain.

## Test plan (REAL, pure-Node where possible)
1. NEW packages/fix/test/atlas-profile-force.test.ts (pure, Vitest, no harness needed): exhaustively pin `atlasNeedsForcedFormat` — force=true only for {single-format, not-multipage-spine, has-sidecar, not-claimed, source≠target}; force=false with the right skipReason for each excluded gate; source===target ⇒ force=false no reason.
2. Extend packages/fix/test/export-profile-fanout.test.ts: assert a single-format format-only profile's expected per-atlas decision row (one image renamed to the target mime, sidecar repointed) using the same pure-composition style (validateProfile + renamedTo + repointAtlasImage emit).
3. Determinism test: same inputs ⇒ same predicate output + same emitted names.
4. Byte-identity argument (the honest substitute for the absent worker e2e, per round7 B2): the new driver block is wholly inside `if (profileOn && !profileHasLowerTier && !profileMulti)`; profile-absent OR multi-tier OR multi-format ⇒ block never runs ⇒ `out`/zip byte-identical to today. Stated as a code-review assertion in the PR (the discipline the project already uses).
5. Manual verification (documented, since pixels need a browser): load a fixture folder containing a prebuilt AVIF/PNG TexturePacker sheet that earns NO format finding, set a single-format AVIF/WebP profile, confirm the downloaded zip now contains the sheet in the chosen format with a repointed sidecar and no orphaned original. Use fixtures/sample-projects + check-invariants skill.

## Ordered small-commit breakdown
1. feat(fix): pure `atlasNeedsForcedFormat` predicate + Node tests (packages/fix/src/atlasProfileForce.ts, atlas-profile-force.test.ts) — no worker wiring yet.
2. refactor(worker): extract the inline prebuilt-atlas passthrough transcode body (:2466-2554) into a local `forceAtlasFormat` helper, called by the existing op handler — pure refactor, byte-identical (prove via existing tests passing).
3. feat(worker): add the single-format format-only atlas-force driver after the loose pass (:3540), gated `profileOn && !profileHasLowerTier && !profileMulti`, using the helper + predicate; increment profileAssets/profileFilesEmitted/profileOwned.
4. fix(worker): extend predictOwnerFinalNames lookup to predict a force-transcoded owner atlas's final mime under a single-format format-only profile (divergence-safe).
5. test(fix): extend export-profile-fanout decision test for the atlas row; add i18n skip keys if new strings are introduced (run the i18n drift guard).
6. docs: append the lifted-scope note to docs/improvements/round7-export-profile.md §5d-bis (single-format atlases now forced).